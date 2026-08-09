from __future__ import annotations

import ipaddress
import os
import platform
import shutil
import socket
import subprocess
from dataclasses import dataclass

import psutil

from .bootstrap import PINNED_PYTHON, PINNED_RAY_VERSION, python_version as bootstrap_python_version, ray_version as bootstrap_ray_version, resolved_ray_executable
from .models import AppConfig, DiagnosticCheck


PRIVATE_LOOPBACKS = {"127.0.0.1", "localhost"}


def is_private_host(host: str) -> bool:
    if host in PRIVATE_LOOPBACKS:
        return True
    try:
        ip = ipaddress.ip_address(socket.gethostbyname(host))
    except OSError:
        return False
    return ip.is_private or ip.is_loopback


def is_port_available(host: str, port: int) -> bool:
    try:
        bind_host = socket.gethostbyname(host)
    except OSError:
        bind_host = "127.0.0.1"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((bind_host, port))
        except OSError:
            return False
    return True


def is_port_reachable(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def is_coordinator_reachable(config: AppConfig, timeout: float = 1.0) -> bool:
    try:
        from .discovery import _probe_user, _tcp_open

        return _tcp_open(
            config.coordinator.head_host,
            config.coordinator.ray_port,
            timeout,
            allow_cli_fallback=True,
            cli_user=_probe_user(config),
        )
    except Exception:
        return is_port_reachable(config.coordinator.head_host, config.coordinator.ray_port, timeout)


def find_available_port(host: str, preferred: int, limit: int = 200) -> int:
    for port in range(preferred, preferred + limit):
        if is_port_available(host, port):
            return port
    raise RuntimeError(f"No available port found starting at {preferred}")


def ray_version() -> str | None:
    return bootstrap_ray_version(timeout=5)


def python_version() -> str | None:
    return bootstrap_python_version(timeout=5)


def has_ray() -> bool:
    return resolved_ray_executable() is not None


def has_worker_account(account: str) -> bool:
    if platform.system() == "Windows":
        result = subprocess.run(["net", "user", account], check=False, capture_output=True, text=True)
        return result.returncode == 0
    try:
        import pwd

        pwd.getpwnam(account)
        return True
    except KeyError:
        return False


def has_worker_launch_permission(account: str) -> bool:
    if not account or platform.system() == "Windows":
        return True
    if platform.system() != "Darwin":
        return True
    try:
        result = subprocess.run(["sudo", "-n", "-u", account, "--", "true"], check=False, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def container_runtime_status(runtime: str) -> tuple[bool, str]:
    binary = shutil.which(runtime)
    if not binary:
        return False, f"{runtime} is not installed or not on PATH"
    try:
        result = subprocess.run([runtime, "--version"], check=False, capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        return False, f"{runtime} did not respond to --version"
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or f"{runtime} failed").strip()
    return True, (result.stdout or result.stderr).strip()


def gpu_runtime_status(runtime: str) -> tuple[bool, str]:
    if runtime == "docker":
        cmd = ["docker", "info", "--format", "{{json .Runtimes}}"]
    else:
        cmd = [runtime, "info"]
    try:
        result = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.TimeoutExpired):
        return False, "GPU runtime check could not run"
    text = (result.stdout + result.stderr).lower()
    if "nvidia" in text or "gpu" in text:
        return True, "GPU runtime appears configured"
    return False, "No NVIDIA/GPU runtime detected"


def idle_snapshot(cpu_threshold: int) -> bool:
    return psutil.cpu_percent(interval=0.2) <= cpu_threshold


def diagnostics(config: AppConfig) -> list[DiagnosticCheck]:
    checks: list[DiagnosticCheck] = []
    rv = ray_version()
    pyv = python_version()
    ray_ok = rv == PINNED_RAY_VERSION and pyv == PINNED_PYTHON
    checks.append(
        DiagnosticCheck(
            id="ray",
            label="Ray CLI",
            status="pass" if ray_ok else "fail",
            detail=(f"Ray {rv}, Python {pyv} at {resolved_ray_executable()}" if rv else "Ray CLI not found"),
            fix=f"Install the app-local pinned Ray runtime ({PINNED_RAY_VERSION}) with Python {PINNED_PYTHON} from Setup.",
        )
    )
    private = is_private_host(config.coordinator.head_host)
    checks.append(
        DiagnosticCheck(
            id="private_network",
            label="Private VLAN address",
            status="pass" if private else "fail",
            detail=f"Coordinator host {config.coordinator.head_host} {'is private' if private else 'is not private or cannot be resolved'}",
            fix="Use a private VLAN IP/DNS name; do not bind Ray to public campus or internet interfaces.",
        )
    )
    if config.app_mode.value == "node":
        reachable = is_coordinator_reachable(config)
        checks.append(
            DiagnosticCheck(
                id="ray_port",
                label="Coordinator reachability",
                status="pass" if reachable else "warn",
                detail=(
                    f"Coordinator is reachable at {config.coordinator.ray_address}"
                    if reachable
                    else f"Coordinator is not reachable at {config.coordinator.ray_address}"
                ),
                fix="Start the host in External workers mode or save the host machine's LAN IP address.",
            )
        )
    else:
        port_ok = is_port_available(config.coordinator.head_host, config.coordinator.ray_port)
        checks.append(
            DiagnosticCheck(
                id="ray_port",
                label="Ray head port",
                status="pass" if port_ok else "fail",
                detail=f"{config.coordinator.head_host}:{config.coordinator.ray_port} {'is available' if port_ok else 'is already in use'}",
                fix="Run Full machine setup to automatically select an available Ray head port.",
            )
        )
    account_ok = has_worker_account(config.privacy.worker_account)
    launch_ok = not account_ok or has_worker_launch_permission(config.privacy.worker_account)
    coordinator_mac = config.app_mode.value == "coordinator" and platform.system() == "Darwin"
    node_mac_missing_permission = config.app_mode.value == "node" and platform.system() == "Darwin" and account_ok and not launch_ok
    checks.append(
        DiagnosticCheck(
            id="worker_account",
            label="Dedicated worker account",
            status="fail" if node_mac_missing_permission else "pass" if account_ok else ("warn" if coordinator_mac else "fail"),
            detail=(
                f"Account {config.privacy.worker_account} exists, but RayLab needs administrator approval to launch worker processes"
                if node_mac_missing_permission
                else
                f"Account {config.privacy.worker_account} exists"
                if account_ok
                else "macOS Coordinator/UI mode can continue; production GPU worker isolation is Windows/Linux only"
                if coordinator_mac
                else f"Account {config.privacy.worker_account} does not exist"
            ),
            fix=(
                "Run Full machine setup and approve the macOS administrator prompt."
                if node_mac_missing_permission
                else "Use a Linux/Windows worker node for GPU sharing."
                if coordinator_mac and not account_ok
                else "Create the raylab-worker account using the OS setup guide before enabling sharing."
            ),
        )
    )
    runtime_ok, runtime_detail = container_runtime_status(config.privacy.container_runtime)
    checks.append(
        DiagnosticCheck(
            id="container_runtime",
            label="Container runtime",
            status="pass" if runtime_ok else "fail",
            detail=runtime_detail,
            fix="Install Docker/Podman and configure it for the dedicated worker account.",
        )
    )
    gpu_ok, gpu_detail = gpu_runtime_status(config.privacy.container_runtime) if runtime_ok else (False, "Skipped")
    checks.append(
        DiagnosticCheck(
            id="gpu_container_runtime",
            label="GPU container runtime",
            status="pass" if gpu_ok else "warn",
            detail=gpu_detail,
            fix="Install NVIDIA Container Toolkit or equivalent GPU support for the selected runtime.",
        )
    )
    store_ok = bool(config.object_store.endpoint_url and config.object_store.bucket)
    checks.append(
        DiagnosticCheck(
            id="object_store",
            label="Lab object store",
            status="pass" if store_ok else "warn",
            detail="Configured" if store_ok else "Endpoint or bucket is missing",
            fix="Set the S3-compatible endpoint and bucket used for datasets and model weights.",
        )
    )
    return checks


@dataclass(frozen=True)
class SetupCommand:
    os_name: str
    command: str
    note: str


def worker_account_setup_commands(account: str = "raylab-worker") -> list[SetupCommand]:
    return [
        SetupCommand("Linux", f"sudo useradd --system --create-home --shell /usr/sbin/nologin {account}", "Create an unprivileged system user for Ray workers."),
        SetupCommand("Linux", f"sudo mkdir -p /var/lib/{account}/jobs && sudo chown -R {account}:{account} /var/lib/{account}", "Create the job working directory."),
        SetupCommand("Windows", f"net user {account} * /add", "Create a local user with a generated password entered by an administrator."),
        SetupCommand("Windows", f"mkdir C:\\RayLab\\jobs", "Create a controlled job working directory."),
    ]
