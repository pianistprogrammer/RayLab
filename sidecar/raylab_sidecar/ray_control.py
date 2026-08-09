from __future__ import annotations

import json
import os
import platform
import re
import signal
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psutil
import requests

from .bootstrap import ensure_ray_runtime, ray_command
from .diagnostics import diagnostics, has_worker_account, has_worker_launch_permission, is_port_available, is_private_host
from .discovery import detect_lan_ip, is_loopback_host
from .models import AppConfig, AppMode, AuditEvent, ClusterState, ClusterStatus, JobResponse, JobSubmission, NodeInfo, TerminalLogEntry
from .storage import ConfigStore, SecretStore


SENSITIVE_FLAGS = {"--redis-password", "--token"}
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
RAY_PROCESS_NAMES = {
    "raylet",
    "gcs_server",
    "plasma_store_server",
    "dashboard",
    "runtime_env_agent",
    "log_monitor",
}
RAY_PROCESS_MARKERS = (
    "/raylet",
    "gcs_server",
    "plasma_store_server",
    "dashboard.py",
    "runtime_env_agent",
    "log_monitor.py",
    "monitor.py",
    "ray::",
)


def _ray_usage_resources(raw: dict[str, Any]) -> dict[str, float]:
    resources: dict[str, float] = {}
    for key, value in raw.items():
        total = value[1] if isinstance(value, list | tuple) and len(value) >= 2 else value
        try:
            resources[key] = float(total)
        except (TypeError, ValueError):
            continue
    return resources


def _hostname_from_ray_resources(resources: dict[str, float]) -> str | None:
    for key in resources:
        if key.startswith("node:"):
            return key.removeprefix("node:")
    return None


def _node_sort_rank(node: NodeInfo) -> tuple[int, str]:
    status = node.status.lower()
    if status == "alive" or status == "active":
        return (0, node.hostname)
    if status in {"dead", "inactive"}:
        return (2, node.hostname)
    return (1, node.hostname)


def redact_command(command: list[str]) -> list[str]:
    redacted: list[str] = []
    skip_next = False
    for item in command:
        if skip_next:
            redacted.append("<redacted>")
            skip_next = False
            continue
        redacted.append(item)
        if item in SENSITIVE_FLAGS:
            skip_next = True
    return redacted


@dataclass
class CommandResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str


class CommandRunner:
    def run(
        self,
        command: list[str],
        *,
        as_worker: bool = False,
        worker_account: str = "raylab-worker",
        timeout: int = 60,
        on_output: Any | None = None,
    ) -> CommandResult:
        effective = command
        if as_worker:
            effective = self._wrap_as_worker(command, worker_account)
        safe_command = redact_command(effective)
        env = os.environ.copy()
        if platform.system() in {"Darwin", "Windows"}:
            env["RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER"] = "1"
        popen_kwargs: dict[str, Any] = {}
        if platform.system() == "Windows":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["start_new_session"] = True
        try:
            process = subprocess.Popen(effective, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, **popen_kwargs)
        except OSError as exc:
            return CommandResult(safe_command, 127, "", str(exc))

        output: list[str] = []
        output_lock = threading.Lock()
        started = time.monotonic()
        assert process.stdout is not None

        def read_output() -> None:
            for line in process.stdout or []:
                with output_lock:
                    output.append(line)
                if on_output:
                    on_output(line.rstrip())

        reader = threading.Thread(target=read_output, name="raylab-command-output", daemon=True)
        reader.start()
        while True:
            if process.poll() is not None:
                break
            if time.monotonic() - started > timeout:
                self._terminate_process_tree(process)
                reader.join(timeout=1)
                message = f"Command timed out after {timeout} seconds"
                if on_output:
                    on_output(message)
                with output_lock:
                    return CommandResult(safe_command, 124, "".join(output), message)
            time.sleep(0.1)
        reader.join(timeout=2)
        with output_lock:
            return CommandResult(safe_command, process.returncode or 0, "".join(output), "")

    def _terminate_process_tree(self, process: subprocess.Popen[str]) -> None:
        if platform.system() == "Windows":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], check=False, capture_output=True, text=True)
            return
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except OSError:
            process.kill()

    def _wrap_as_worker(self, command: list[str], worker_account: str) -> list[str]:
        if platform.system() == "Windows":
            raise RuntimeError(
                "Windows node execution requires the RayLab worker service/task wrapper; "
                "run the documented setup before starting Node mode."
            )
        if platform.system() == "Darwin":
            return ["sudo", "-n", "-u", worker_account, "--", "env", "RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1", *command]
        return ["sudo", "-n", "-u", worker_account, "--", *command]


class RayController:
    def __init__(self, store: ConfigStore, secrets: SecretStore, runner: CommandRunner | None = None) -> None:
        self.store = store
        self.secrets = secrets
        self.runner = runner or CommandRunner()
        self.state = ClusterState.stopped
        self.message = "Not started"
        self.logs: list[TerminalLogEntry] = []

    def terminal_logs(self) -> list[TerminalLogEntry]:
        return self.logs[-500:]

    def log(self, message: str, stream: str = "system") -> None:
        self._log(message, stream)

    def _log(self, message: str, stream: str = "system") -> None:
        message = ANSI_RE.sub("", message)
        self.logs.append(TerminalLogEntry(stream=stream, message=message))
        self.logs = self.logs[-500:]

    def status(self) -> ClusterStatus:
        config = self.store.load()
        config = self._normalize_external_coordinator(config)
        local_running = self._ray_status_ok(config) if config.app_mode != AppMode.unconfigured else False
        if self.state in {ClusterState.stopped, ClusterState.error} and local_running:
            self.state = ClusterState.running
            self.message = "Ray is running"
        elif self.state == ClusterState.error and not local_running:
            self.state = ClusterState.stopped
            self.message = "Ray is not running locally"
        elif self.state == ClusterState.running and not local_running:
            self.state = ClusterState.stopped
            self.message = "Ray is not running locally"
        if self.state == ClusterState.running and config.app_mode == AppMode.coordinator:
            config = self._normalize_running_coordinator_address(config)
        checks = diagnostics(config)
        if self.state == ClusterState.running and config.app_mode == AppMode.coordinator:
            for check in checks:
                if check.id == "ray_port":
                    check.status = "pass"
                    check.detail = f"{config.coordinator.ray_address} is occupied by the running Ray head"
                    check.fix = None
        if self.state == ClusterState.running and config.app_mode == AppMode.node:
            for check in checks:
                if check.id == "ray_port":
                    check.status = "pass"
                    check.detail = f"Connected to coordinator at {config.coordinator.ray_address}"
                    check.fix = None
        return ClusterStatus(
            state=self.state,
            mode=config.app_mode,
            address=config.coordinator.ray_address if config.app_mode != AppMode.unconfigured else None,
            dashboard_url=config.coordinator.dashboard_url if config.app_mode == AppMode.coordinator else None,
            message=self.message,
            diagnostics=checks,
        )

    def _ray_status_ok(self, config: AppConfig) -> bool:
        return self._local_ray_running(config)

    def start(self) -> ClusterStatus:
        config = self.store.load()
        config = self._normalize_external_coordinator(config)
        if config.app_mode == AppMode.unconfigured:
            message = "Choose Coordinator or Node mode before starting Ray."
            self._log(message, "stderr")
            raise ValueError(message)
        if self._ray_status_ok(config):
            self.state = ClusterState.running
            self.message = "Ray is already running"
            return self.status()
        if config.coordinator.bind_private_only and not is_private_host(config.coordinator.head_host):
            message = "Refusing to start Ray on a non-private coordinator address."
            self._log(message, "stderr")
            raise ValueError(message)
        coordinator_mac = config.app_mode == AppMode.coordinator and platform.system() == "Darwin"
        if config.privacy.worker_account_required and config.app_mode == AppMode.node and not has_worker_account(config.privacy.worker_account):
            if platform.system() == "Darwin":
                message = "Run Full machine setup and approve the macOS administrator prompt so RayLab can create the hidden raylab-worker account."
                self._log(message, "stderr")
                raise ValueError(message)
            message = "Run Full machine setup to create the dedicated raylab-worker account before sharing."
            self._log(message, "stderr")
            raise ValueError(message)
        if config.privacy.worker_account_required and config.app_mode == AppMode.node and not has_worker_launch_permission(config.privacy.worker_account):
            message = "Run Full machine setup and approve the macOS administrator prompt so RayLab can launch Ray as raylab-worker without asking for a terminal password."
            self._log(message, "stderr")
            raise ValueError(message)
        if config.privacy.worker_account_required and config.app_mode == AppMode.coordinator and not coordinator_mac and not has_worker_account(config.privacy.worker_account):
            message = "Dedicated raylab-worker account is required before hosting production worker-capable head nodes."
            self._log(message, "stderr")
            raise ValueError(message)

        self._clear_or_report_port_conflicts(config)

        bootstrap = ensure_ray_runtime(on_output=lambda line: self._log(line, "stdout"))
        if not bootstrap.succeeded:
            self.state = ClusterState.error
            self.message = bootstrap.message
            self._log(bootstrap.message, "stderr")
            self._audit("ray_bootstrap_failed", "system", self.message, {"command": bootstrap.command})
            raise RuntimeError(bootstrap.message)

        if config.app_mode == AppMode.node:
            self._cleanup_stale_worker_ray(config)

        command = self._head_command(config) if config.app_mode == AppMode.coordinator else self._node_command(config)
        as_worker = config.app_mode == AppMode.node
        self.state = ClusterState.starting
        self._log(f"$ {' '.join(redact_command(command))}")
        self._log("Starting Ray...")
        result = self.runner.run(command, as_worker=as_worker, worker_account=config.privacy.worker_account, timeout=90, on_output=lambda line: self._log(line, "stdout"))
        if result.returncode != 0:
            self.state = ClusterState.error
            self.message = result.stderr or result.stdout or "Ray start failed"
            self._log(f"Ray start failed with exit code {result.returncode}", "stderr")
            self._audit("cluster_start_failed", "system", self.message, {"command": result.command})
            raise RuntimeError(self.message)
        if config.app_mode == AppMode.node and not self._wait_for_local_start(config, timeout=8):
            self.state = ClusterState.error
            self.message = "Ray worker exited before it became visible locally"
            self._log(self.message, "stderr")
            self._audit("cluster_start_failed", "system", self.message, {"command": result.command})
            raise RuntimeError(self.message)
        self.state = ClusterState.running
        self.message = "Ray is running"
        self._log("Ray is running")
        self._audit("cluster_started", "system", self.message, {"command": result.command, "mode": config.app_mode.value})
        return self.status()

    def _normalize_external_coordinator(self, config: AppConfig) -> AppConfig:
        if not self._should_publish_external_join_address(config):
            return config
        if not is_loopback_host(config.coordinator.head_host):
            return config
        node_ip = config.coordinator.node_ip_address.strip()
        lan_ip = node_ip if node_ip and not is_loopback_host(node_ip) else detect_lan_ip()
        if not lan_ip:
            return config
        config.coordinator.head_host = lan_ip
        if not config.coordinator.node_ip_address.strip():
            config.coordinator.node_ip_address = lan_ip
        self.store.save(config)
        self._log(f"External workers mode: join address set to {lan_ip}:{config.coordinator.ray_port}")
        return config

    def _normalize_running_coordinator_address(self, config: AppConfig) -> AppConfig:
        if not is_loopback_host(config.coordinator.head_host):
            return config
        lan_ip = detect_lan_ip()
        if not lan_ip:
            return config
        config.coordinator.head_host = lan_ip
        if not config.coordinator.node_ip_address.strip():
            config.coordinator.node_ip_address = lan_ip
        self.store.save(config)
        self._log(f"Running coordinator: publishing join address {lan_ip}:{config.coordinator.ray_port}")
        return config

    def _should_publish_external_join_address(self, config: AppConfig) -> bool:
        if config.app_mode != AppMode.coordinator:
            return False
        node_ip = config.coordinator.node_ip_address.strip()
        return (
            config.coordinator.allow_external_workers
            or config.coordinator.dashboard_host.strip() == "0.0.0.0"
            or (bool(node_ip) and not is_loopback_host(node_ip))
        )

    def stop(self, panic: bool = False) -> ClusterStatus:
        config = self.store.load()
        self.state = ClusterState.stopping
        command = [ray_command(), "stop", "--force"]
        self._log(f"$ {' '.join(redact_command(command))}")
        self._log("Stopping local Ray processes...")
        result = self.runner.run(command, as_worker=config.app_mode == AppMode.node, worker_account=config.privacy.worker_account, timeout=60, on_output=lambda line: self._log(line, "stdout"))
        if result.returncode != 0:
            self._log(f"ray stop returned exit code {result.returncode}; verifying local Ray state anyway", "stderr")
        self._wait_for_local_stop(config, timeout=6)
        if self._local_ray_running(config):
            self._log("Ray processes are still present after ray stop; running local cleanup fallback", "stderr")
            killed = self._kill_local_ray_processes()
            self._log(f"Fallback cleanup signaled {killed} local Ray process(es)")
            self._wait_for_local_stop(config, timeout=5)
        remaining = self._local_ray_processes()
        if remaining:
            self.state = ClusterState.error
            self.message = f"Ray stop incomplete: {len(remaining)} local Ray process(es) still running"
            self._log(self.message, "stderr")
            for proc in remaining[:8]:
                self._log(f"Still running: pid {proc.pid} {self._proc_label(proc)}", "stderr")
        else:
            self.state = ClusterState.stopped
            port_note = self._coordinator_port_note(config)
            self.message = "Ray stopped" + (f"; {port_note}" if port_note else "")
            self._log(self.message)
        self._audit("panic_stop" if panic else "cluster_stopped", "system", self.message, {"command": result.command})
        if panic:
            config.node_policy.manual_override = "panic"
            self.store.save(config)
        return self.status()

    def _wait_for_local_stop(self, config: AppConfig, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self._local_ray_running(config):
                return
            time.sleep(0.25)

    def _wait_for_local_start(self, config: AppConfig, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._local_ray_running(config):
                return True
            time.sleep(0.25)
        return False

    def _cleanup_stale_worker_ray(self, config: AppConfig) -> None:
        if not self._local_ray_processes():
            return
        self._log("Clearing stale local Ray worker processes before joining the coordinator")
        stop_command = [ray_command(), "stop", "--force"]
        self.runner.run(stop_command, as_worker=True, worker_account=config.privacy.worker_account, timeout=30, on_output=lambda line: self._log(line, "stdout"))
        self._wait_for_local_stop(config, timeout=4)
        if self._local_ray_processes():
            killed = self._kill_worker_ray_processes(config.privacy.worker_account)
            if killed:
                self._log(f"Fallback cleanup signaled stale worker Ray processes for {config.privacy.worker_account}")
            self._wait_for_local_stop(config, timeout=3)

    def _local_ray_running(self, config: AppConfig) -> bool:
        procs = self._local_ray_processes()
        if config.app_mode == AppMode.node:
            return any(self._is_raylet_process(proc) for proc in procs) or self._ps_has_raylet(config)
        if config.app_mode == AppMode.coordinator:
            return any(self._is_head_process(proc) for proc in procs) or self._ps_has_head(config)
        return bool(procs)

    def _ps_command_lines(self) -> list[str]:
        try:
            result = subprocess.run(["ps", "axww", "-o", "command="], check=False, capture_output=True, text=True, timeout=2)
        except Exception:
            return []
        return [line.lower() for line in result.stdout.splitlines()]

    def _ps_has_raylet(self, config: AppConfig) -> bool:
        address = config.coordinator.ray_address.lower()
        return any(self._ps_line_is_raylet(line) and f"--gcs-address={address}" in line for line in self._ps_command_lines())

    def _ps_line_is_raylet(self, line: str) -> bool:
        text = line.strip().lower()
        if not text:
            return False
        excluded = ("grep ", "ssh ", "sshd ", "curl ", "tail ", "raylab-sidecar", "zsh -", "bash -")
        if any(item in text for item in excluded):
            return False
        return "/site-packages/ray/core/src/ray/raylet/raylet " in text or text.endswith("/site-packages/ray/core/src/ray/raylet/raylet")

    def _ps_has_head(self, config: AppConfig) -> bool:
        host = config.coordinator.node_ip_address.strip() or config.coordinator.head_host
        return any(
            "gcs_server" in line
            or ("/raylet" in line and f"--node_ip_address={host}" in line)
            or ("/raylet" in line and f"--node-ip-address={host}" in line)
            for line in self._ps_command_lines()
        )

    def _is_raylet_process(self, proc: psutil.Process) -> bool:
        try:
            name = (proc.info.get("name") or proc.name() or "").lower()
            text = " ".join(str(part) for part in (proc.info.get("cmdline") or proc.cmdline() or [])).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False
        return name == "raylet" or "/raylet" in text

    def _is_head_process(self, proc: psutil.Process) -> bool:
        try:
            name = (proc.info.get("name") or proc.name() or "").lower()
            text = " ".join(str(part) for part in (proc.info.get("cmdline") or proc.cmdline() or [])).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False
        return name in {"gcs_server", "raylet"} or "gcs_server" in text or "/raylet" in text

    def _local_ray_processes(self) -> list[psutil.Process]:
        current_pid = os.getpid()
        matches: list[psutil.Process] = []
        for proc in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                if proc.pid == current_pid:
                    continue
                name = (proc.info.get("name") or "").lower()
                cmdline = [str(part) for part in proc.info.get("cmdline") or []]
                text = " ".join(cmdline).lower()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            if "ray status" in text or "ray stop" in text or "ray start" in text:
                continue
            if name in RAY_PROCESS_NAMES or any(marker in text for marker in RAY_PROCESS_MARKERS):
                matches.append(proc)
        return matches

    def _kill_local_ray_processes(self) -> int:
        procs = self._local_ray_processes()
        for proc in procs:
            try:
                proc.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        gone, alive = psutil.wait_procs(procs, timeout=3)
        for proc in alive:
            try:
                proc.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return len(procs)

    def _kill_worker_ray_processes(self, worker_account: str) -> int:
        if platform.system() == "Windows" or not worker_account:
            return 0
        patterns = [
            "[r]ay/core/src/ray/raylet/raylet",
            "[r]ay/core/src/ray/gcs/gcs_server",
            "[r]ay/_private/log_monitor.py",
            "[r]ay/_private/runtime_env/agent/main.py",
            "[r]ay/dashboard/dashboard.py",
        ]
        killed = 0
        for pattern in patterns:
            try:
                result = subprocess.run(
                    ["sudo", "-n", "-u", worker_account, "--", "pkill", "-f", pattern],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0:
                killed += 1
        return killed

    def _tcp_open(self, host: str, port: int) -> bool:
        targets = [host]
        if host not in {"127.0.0.1", "localhost", "0.0.0.0"}:
            targets.append("127.0.0.1")
        for target in targets:
            try:
                with socket.create_connection((target, port), timeout=0.25):
                    return True
            except OSError:
                continue
        return False

    def _coordinator_port_note(self, config: AppConfig) -> str | None:
        if config.app_mode != AppMode.coordinator:
            return None
        if self._tcp_open(config.coordinator.head_host, config.coordinator.ray_port):
            return f"port {config.coordinator.ray_port} is still occupied by another local service"
        return f"port {config.coordinator.ray_port} is free"

    def _required_local_ports(self, config: AppConfig) -> list[tuple[str, str, int]]:
        if config.app_mode != AppMode.coordinator:
            return []
        head_host = config.coordinator.node_ip_address.strip() or config.coordinator.head_host
        return [
            ("Ray head", head_host, config.coordinator.ray_port),
            ("Ray dashboard", config.coordinator.dashboard_host, config.coordinator.dashboard_port),
            ("Ray client", head_host, config.coordinator.client_port),
        ]

    def _clear_or_report_port_conflicts(self, config: AppConfig) -> None:
        required = self._required_local_ports(config)
        if not required:
            return
        conflicts = [(label, host, port) for label, host, port in required if not is_port_available(host, port)]
        if not conflicts:
            return
        if self._local_ray_processes():
            self._log("Configured Ray ports are occupied; clearing stale local Ray processes before start")
            self.stop()
            conflicts = [(label, host, port) for label, host, port in required if not is_port_available(host, port)]
            if not conflicts:
                return
        details = [f"{label} port {port} on {host} is occupied by {self._port_owner_summary(port)}" for label, host, port in conflicts]
        message = "Port conflict: " + "; ".join(details)
        self._log(message, "stderr")
        raise ValueError(message)

    def _port_owner_summary(self, port: int) -> str:
        try:
            connections = psutil.net_connections(kind="inet")
        except (psutil.AccessDenied, OSError):
            return "another local process"
        for connection in connections:
            if connection.status != psutil.CONN_LISTEN or not connection.laddr or connection.laddr.port != port:
                continue
            if connection.pid is None:
                return "another local process"
            try:
                proc = psutil.Process(connection.pid)
                return f"PID {connection.pid} ({self._proc_label(proc)})"
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return f"PID {connection.pid}"
        return "another local process"

    def _proc_label(self, proc: psutil.Process) -> str:
        try:
            cmdline = " ".join(proc.cmdline())
            return cmdline[:220] if cmdline else proc.name()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return "<unavailable>"

    def _head_command(self, config: AppConfig) -> list[str]:
        command = [
            ray_command(),
            "start",
            "--head",
            "--port",
            str(config.coordinator.ray_port),
            "--dashboard-host",
            config.coordinator.dashboard_host,
            "--dashboard-port",
            str(config.coordinator.dashboard_port),
            "--ray-client-server-port",
            str(config.coordinator.client_port),
            "--num-cpus",
            str(int(config.resource_caps.cpus)),
            "--num-gpus",
            str(int(config.resource_caps.gpus)),
            "--memory",
            str(config.resource_caps.memory_bytes),
            "--resources",
            json.dumps({"raylab_max_jobs": config.resource_caps.max_concurrent_jobs}),
        ]
        node_ip = config.coordinator.node_ip_address.strip()
        if not node_ip and config.coordinator.allow_external_workers:
            # Ray defaults to 127.0.0.1 when no IP is given, which makes the
            # head unreachable to remote workers. Detect the LAN IP instead.
            node_ip = self._detect_lan_ip()
            if node_ip:
                self._log(f"External workers mode: using detected LAN IP {node_ip} as --node-ip-address")
        if node_ip:
            command[3:3] = ["--node-ip-address", node_ip]
        return command

    def _detect_lan_ip(self) -> str:
        return detect_lan_ip()

    def _node_command(self, config: AppConfig) -> list[str]:
        return [
            ray_command(),
            "start",
            "--address",
            config.coordinator.ray_address,
            "--num-cpus",
            str(int(config.resource_caps.cpus)),
            "--num-gpus",
            str(int(config.resource_caps.gpus)),
            "--memory",
            str(config.resource_caps.memory_bytes),
            "--resources",
            json.dumps({"raylab_max_jobs": config.resource_caps.max_concurrent_jobs}),
        ]

    def nodes(self) -> list[NodeInfo]:
        config = self.store.load()
        state_nodes = self._nodes_from_state_api(config)
        if state_nodes:
            return state_nodes
        try:
            response = requests.get(f"{config.coordinator.dashboard_url}/api/cluster_status", timeout=5)
            response.raise_for_status()
            data = response.json()
        except Exception:
            return []
        nodes: list[NodeInfo] = []
        for raw in data.get("data", {}).get("nodes", []) or data.get("nodes", []):
            resources = raw.get("Resources", raw.get("resources_total", {})) or {}
            nodes.append(
                NodeInfo(
                    node_id=str(raw.get("NodeID") or raw.get("node_id") or raw.get("ip") or len(nodes)),
                    hostname=str(raw.get("NodeName") or raw.get("node_name") or raw.get("ip") or "unknown"),
                    status=str(raw.get("State") or raw.get("status") or "unknown"),
                    cpus_total=float(resources.get("CPU", 0)),
                    gpus_total=float(resources.get("GPU", 0)),
                    memory_total_gb=float(resources.get("memory", 0)) / 1024 / 1024 / 1024 if resources.get("memory") else 0,
                    last_seen=datetime.utcnow(),
                )
            )
        if nodes:
            return nodes
        cluster_status = data.get("data", {}).get("clusterStatus", {}) or {}
        load_metrics = cluster_status.get("loadMetricsReport", {}) or {}
        autoscaler = cluster_status.get("autoscalerReport", {}) or {}
        usage_by_node = load_metrics.get("usageByNode", {}) or {}
        node_type_mapping = load_metrics.get("nodeTypeMapping") or autoscaler.get("nodeTypeMapping") or {}
        active_ids = set(node_type_mapping.keys()) | set(usage_by_node.keys())
        for node_id in sorted(active_ids):
            resources = _ray_usage_resources(usage_by_node.get(node_id, {}) or {})
            if not resources:
                # Ray reports the head separately in RayLab's graph, so empty
                # dashboard usage entries are not useful worker nodes.
                continue
            hostname = _hostname_from_ray_resources(resources) or node_type_mapping.get(node_id) or node_id[:12]
            nodes.append(
                NodeInfo(
                    node_id=str(node_id),
                    hostname=str(hostname),
                    status="active",
                    cpus_total=float(resources.get("CPU", 0)),
                    gpus_total=float(resources.get("GPU", 0)),
                    memory_total_gb=float(resources.get("memory", 0)) / 1024 / 1024 / 1024 if resources.get("memory") else 0,
                    last_seen=datetime.utcnow(),
                )
            )
        return nodes

    def _nodes_from_state_api(self, config: AppConfig) -> list[NodeInfo]:
        try:
            response = requests.get(f"{config.coordinator.dashboard_url}/api/v0/nodes", timeout=5)
            response.raise_for_status()
            data = response.json()
        except Exception:
            return []
        raw_nodes = data.get("data", {}).get("result", {}).get("result", [])
        by_host: dict[str, NodeInfo] = {}
        for raw in raw_nodes:
            if not isinstance(raw, dict) or raw.get("is_head_node"):
                continue
            resources = raw.get("resources_total", {}) or {}
            hostname = str(raw.get("node_name") or raw.get("node_ip") or raw.get("node_id") or "unknown")
            node = NodeInfo(
                node_id=str(raw.get("node_id") or hostname),
                hostname=hostname,
                status=str(raw.get("state") or "unknown").lower(),
                cpus_total=float(resources.get("CPU", 0)),
                gpus_total=float(resources.get("GPU", 0)),
                memory_total_gb=float(resources.get("memory", 0)) / 1024 / 1024 / 1024 if resources.get("memory") else 0,
                last_seen=datetime.utcnow(),
            )
            previous = by_host.get(hostname)
            if previous is None or _node_sort_rank(node) < _node_sort_rank(previous):
                by_host[hostname] = node
        return sorted(by_host.values(), key=_node_sort_rank)

    def submit_job(self, job: JobSubmission) -> JobResponse:
        config = self.store.load()
        submitter = next((item for item in config.submitters if item.id == job.submitter_id and not item.revoked), None)
        if not submitter:
            raise ValueError("Submitter is unknown or revoked.")
        if config.privacy.require_runtime_working_dir and not job.runtime_env.get("working_dir"):
            raise ValueError("Job runtime_env must include a working_dir.")
        payload: dict[str, Any] = {
            "entrypoint": job.entrypoint,
            "runtime_env": job.runtime_env,
            "metadata": {**job.metadata, "raylab_submitter_id": submitter.id, "raylab_submitter_name": submitter.name},
        }
        try:
            response = requests.post(f"{config.coordinator.dashboard_url}/api/jobs/", json=payload, timeout=10)
            response.raise_for_status()
            body = response.json()
        except Exception as exc:
            self._audit("job_submit_failed", submitter.name, str(exc), {"entrypoint": job.entrypoint})
            raise RuntimeError(f"Ray job submission failed: {exc}") from exc
        job_id = str(body.get("job_id") or body.get("submission_id") or "unknown")
        self._audit("job_submitted", submitter.name, f"Submitted job {job_id}", {"job_id": job_id, "entrypoint": job.entrypoint})
        return JobResponse(job_id=job_id, status="submitted", message="Job submitted")

    def kill_job(self, job_id: str) -> JobResponse:
        config = self.store.load()
        try:
            response = requests.post(f"{config.coordinator.dashboard_url}/api/jobs/{job_id}/stop", timeout=10)
            response.raise_for_status()
        except Exception as exc:
            self._audit("job_kill_failed", "system", str(exc), {"job_id": job_id})
            raise RuntimeError(f"Ray job kill failed: {exc}") from exc
        self._audit("job_killed", "system", f"Killed job {job_id}", {"job_id": job_id})
        return JobResponse(job_id=job_id, status="killed", message="Job kill requested")

    def _audit(self, event_type: str, actor: str, message: str, metadata: dict[str, Any] | None = None) -> None:
        self.store.append_audit(AuditEvent(event_type=event_type, actor=actor, message=message, metadata=metadata or {}))
