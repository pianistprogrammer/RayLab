from __future__ import annotations

import os
import platform
import pwd
import shlex
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

from .bootstrap import PINNED_PYTHON, PINNED_RAY_VERSION, ensure_ray_runtime, python_version
from .diagnostics import container_runtime_status, find_available_port, gpu_runtime_status, has_worker_account, is_port_available, is_port_reachable, is_private_host, ray_version
from .models import AppConfig, AppMode, AuditEvent, SetupRunStatus, SetupTask
from .storage import ConfigStore, config_dir


TASKS = [
    ("python", "Python environment"),
    ("ray", "Ray 2.52+"),
    ("config_dir", "Local app storage"),
    ("network", "Private coordinator address"),
    ("ports", "Ray ports"),
    ("worker_account", "Dedicated worker account"),
    ("container", "Container runtime"),
    ("gpu_container", "GPU container runtime"),
    ("object_store", "Lab object store"),
    ("final", "Readiness"),
]


class SetupRunner:
    def __init__(self, store: ConfigStore) -> None:
        self.store = store
        self._lock = threading.Lock()
        self._status = SetupRunStatus(tasks=[SetupTask(id=task_id, label=label) for task_id, label in TASKS])

    def status(self) -> SetupRunStatus:
        with self._lock:
            return self._status.model_copy(deep=True)

    def start(self) -> SetupRunStatus:
        with self._lock:
            if self._status.running:
                return self._status.model_copy(deep=True)
            self._status = SetupRunStatus(
                running=True,
                succeeded=None,
                progress=0,
                message="Starting setup checks...",
                started_at=datetime.utcnow(),
                tasks=[SetupTask(id=task_id, label=label) for task_id, label in TASKS],
            )
        threading.Thread(target=self._run, name="raylab-full-setup", daemon=True).start()
        return self.status()

    def _set_task(self, task_id: str, status: str, detail: str, fix: str | None = None) -> None:
        with self._lock:
            for task in self._status.tasks:
                if task.id == task_id:
                    task.status = status  # type: ignore[assignment]
                    task.detail = detail
                    task.fix = fix
                    break
            completed = sum(1 for task in self._status.tasks if task.status in {"pass", "warn", "fail", "skipped"})
            self._status.progress = int((completed / len(self._status.tasks)) * 100)
            self._status.message = detail

    def _run_command(self, command: list[str], timeout: int = 600) -> tuple[bool, str]:
        try:
            result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=timeout)
        except Exception as exc:
            return False, str(exc)
        output = "\n".join(part for part in [result.stdout.strip(), result.stderr.strip()] if part)
        return result.returncode == 0, output[-1200:]

    def _run(self) -> None:
        config = self.store.load()
        try:
            self._check_python()
            self._ensure_ray()
            self._ensure_config_dir()
            self._check_network(config)
            config = self._ensure_ports(config)
            self._ensure_worker_account(config)
            self._check_container(config)
            self._check_object_store(config)
            self._finish(config)
        except Exception as exc:  # pragma: no cover - defensive final guard
            self._set_task("final", "fail", f"Setup failed unexpectedly: {exc}")
            self._complete(False, False, f"Setup failed unexpectedly: {exc}")

    def _check_python(self) -> None:
        self._set_task("python", "running", "Checking Python environment...")
        version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        if sys.version_info < (3, 11):
            self._set_task("python", "fail", f"Python {version} is too old", "Install Python 3.11+ and restart the sidecar.")
        else:
            self._set_task("python", "pass", f"Python {version} is ready")

    def _ensure_ray(self) -> None:
        self._set_task("ray", "running", "Checking Ray installation...")
        existing = ray_version()
        existing_python = python_version()
        if existing == PINNED_RAY_VERSION and existing_python == PINNED_PYTHON:
            self._set_task("ray", "pass", f"Pinned Ray runtime is installed: {existing} with Python {existing_python}")
            return
        result = ensure_ray_runtime(on_output=lambda line: self._set_task("ray", "running", line[-240:]))
        installed = result.ray_version or ray_version()
        installed_python = python_version()
        if result.succeeded and installed == PINNED_RAY_VERSION and installed_python == PINNED_PYTHON:
            self._set_task("ray", "pass", f"Ray installed successfully: {installed} with Python {installed_python}")
        else:
            detail = "\n".join(result.log_tail[-5:]) if result.log_tail else result.message
            self._set_task("ray", "fail", result.message, detail or "Run the installer again with network access or bundled wheels.")

    def _ensure_config_dir(self) -> None:
        self._set_task("config_dir", "running", "Creating local app storage...")
        path = config_dir()
        path.mkdir(parents=True, exist_ok=True)
        self._set_task("config_dir", "pass", f"App storage is ready at {path}")

    def _check_network(self, config: AppConfig) -> None:
        self._set_task("network", "running", "Checking coordinator network scope...")
        if is_private_host(config.coordinator.head_host):
            self._set_task("network", "pass", f"{config.coordinator.head_host} is private or loopback")
        else:
            self._set_task("network", "fail", f"{config.coordinator.head_host} is not private", "Set the head host to a private lab VLAN IP or DNS name.")

    def _ensure_ports(self, config: AppConfig) -> AppConfig:
        self._set_task("ports", "running", "Checking Ray ports...")
        host = config.coordinator.head_host
        if config.app_mode == AppMode.node:
            if is_port_reachable(host, config.coordinator.ray_port):
                self._set_task("ports", "pass", f"Coordinator is reachable at {config.coordinator.ray_address}")
            else:
                self._set_task(
                    "ports",
                    "warn",
                    f"Coordinator is not reachable at {config.coordinator.ray_address}",
                    "Start the host in External workers mode or save the host machine's LAN IP address.",
                )
            return config
        changed: list[str] = []
        if not is_port_available(host, config.coordinator.ray_port):
            old = config.coordinator.ray_port
            config.coordinator.ray_port = find_available_port(host, max(6380, old + 1))
            changed.append(f"Ray head {old}->{config.coordinator.ray_port}")
        if not is_port_available(host, config.coordinator.dashboard_port):
            old = config.coordinator.dashboard_port
            config.coordinator.dashboard_port = find_available_port(host, max(8266, old + 1))
            changed.append(f"Dashboard {old}->{config.coordinator.dashboard_port}")
        if not is_port_available(host, config.coordinator.client_port):
            old = config.coordinator.client_port
            config.coordinator.client_port = find_available_port(host, max(10002, old + 1))
            changed.append(f"Ray Client {old}->{config.coordinator.client_port}")
        if changed:
            self.store.save(config)
            self._set_task("ports", "pass", "Updated occupied ports: " + ", ".join(changed))
        else:
            self._set_task("ports", "pass", "Required Ray ports are available")
        return config

    def _ensure_worker_account(self, config: AppConfig) -> None:
        self._set_task("worker_account", "running", "Checking dedicated worker account...")
        account = config.privacy.worker_account
        system = platform.system()
        if has_worker_account(account):
            if system == "Darwin" and config.app_mode == AppMode.node and not self._can_launch_as_worker(account):
                self._set_task(
                    "worker_account",
                    "running",
                    f"Account {account} exists; macOS will ask for administrator permission to let RayLab launch worker processes as it...",
                )
                ok, output = self._create_macos_worker_account(account)
                if ok and self._can_launch_as_worker(account):
                    self._set_task("worker_account", "pass", f"Account {account} exists and worker launch permission is approved")
                else:
                    self._set_task("worker_account", "fail", f"Could not approve worker launch permission for {account}", output or "Approve the macOS administrator prompt and rerun setup.")
                return
            self._set_task("worker_account", "pass", f"Account {account} exists")
            return
        if system == "Linux" and os.geteuid() == 0:
            ok, output = self._run_command(["useradd", "--system", "--create-home", "--shell", "/usr/sbin/nologin", account])
            jobs_dir = Path(f"/var/lib/{account}/jobs")
            jobs_dir.mkdir(parents=True, exist_ok=True)
            self._run_command(["chown", "-R", f"{account}:{account}", f"/var/lib/{account}"])
            if ok or has_worker_account(account):
                self._set_task("worker_account", "pass", f"Created account {account}")
            else:
                self._set_task("worker_account", "fail", f"Could not create {account}", output)
            return
        if system == "Darwin" and config.app_mode == AppMode.node:
            self._set_task(
                "worker_account",
                "running",
                f"macOS will ask for administrator permission to create the hidden {account} worker account...",
            )
            ok, output = self._create_macos_worker_account(account)
            if ok or has_worker_account(account):
                self._set_task("worker_account", "pass", f"Created account {account} and approved worker launch permission")
            else:
                self._set_task("worker_account", "fail", f"Could not create {account}", output or "Approve the macOS administrator prompt and rerun setup.")
            return
        if config.app_mode == AppMode.coordinator and system == "Darwin":
            self._set_task("worker_account", "warn", "macOS is ready for Coordinator/UI testing; production worker isolation is Windows/Linux only", "Use a Linux/Windows worker node for GPU sharing.")
            return
        self._set_task(
            "worker_account",
            "fail",
            f"Account {account} is missing and needs administrator setup",
            "Run the OS worker-account setup from docs/rollout.md, then rerun full setup.",
        )

    def _create_macos_worker_account(self, account: str) -> tuple[bool, str]:
        owner = self._owner_short_name()
        if not owner:
            return False, "Could not determine the current macOS user for worker launch permission."
        script = f"""
set -eu
ACCOUNT={shlex.quote(account)}
OWNER={shlex.quote(owner)}
if ! /usr/bin/id -u "$ACCOUNT" >/dev/null 2>&1; then
  UID_VALUE=$(/usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk '$2 >= 451 && $2 < 500 {{ used[$2]=1 }} END {{ for (i=451; i<500; i++) if (!used[i]) {{ print i; exit }} }}')
  if [ -z "$UID_VALUE" ]; then
    UID_VALUE=$(/usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk 'BEGIN {{ max=500 }} $2 > max {{ max=$2 }} END {{ print max + 1 }}')
  fi
  /usr/bin/dscl . -create "/Users/$ACCOUNT"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" UserShell /usr/bin/false
  /usr/bin/dscl . -create "/Users/$ACCOUNT" RealName "RayLab Worker"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" UniqueID "$UID_VALUE"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" PrimaryGroupID 20
  /usr/bin/dscl . -create "/Users/$ACCOUNT" NFSHomeDirectory "/var/lib/$ACCOUNT"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" IsHidden 1
  /usr/bin/dscl . -passwd "/Users/$ACCOUNT" '*'
fi
/bin/mkdir -p "/var/lib/$ACCOUNT/jobs"
/usr/sbin/chown -R "$ACCOUNT":staff "/var/lib/$ACCOUNT"
/bin/chmod 755 "/var/lib/$ACCOUNT"
/bin/mkdir -p /private/etc/sudoers.d
SUDOERS="/private/etc/sudoers.d/raylab-$OWNER"
/bin/cat > "$SUDOERS" <<EOF
# RayLab: allow this desktop user to launch approved worker processes as the isolated worker account.
$OWNER ALL=($ACCOUNT) NOPASSWD: ALL
EOF
/bin/chmod 440 "$SUDOERS"
/usr/sbin/visudo -cf "$SUDOERS"
""".strip()
        prompt = (
            f"RayLab needs administrator permission to create a hidden local account named {account}. "
            "Cluster jobs will run as this account instead of your personal macOS user."
        )
        command = [
            "osascript",
            "-e",
            f"do shell script {self._applescript_string(script)} with administrator privileges with prompt {self._applescript_string(prompt)}",
        ]
        return self._run_command(command, timeout=300)

    def _can_launch_as_worker(self, account: str) -> bool:
        ok, _output = self._run_command(["sudo", "-n", "-u", account, "--", "true"], timeout=5)
        return ok

    def _owner_short_name(self) -> str:
        try:
            return pwd.getpwuid(os.getuid()).pw_name
        except Exception:
            return os.environ.get("USER") or os.environ.get("LOGNAME") or ""

    def _applescript_string(self, value: str) -> str:
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace("\n", "\\n") + '"'

    def _check_container(self, config: AppConfig) -> None:
        runtime = config.privacy.container_runtime
        self._set_task("container", "running", f"Checking {runtime}...")
        ok, detail = container_runtime_status(runtime)
        self._set_task("container", "pass" if ok else "fail", detail, None if ok else "Install Docker/Podman and restart the app.")
        self._set_task("gpu_container", "running", "Checking GPU container support...")
        if not ok:
            self._set_task("gpu_container", "skipped", "Skipped because container runtime is missing")
            return
        gpu_ok, gpu_detail = gpu_runtime_status(runtime)
        self._set_task("gpu_container", "pass" if gpu_ok else "warn", gpu_detail, None if gpu_ok else "Install NVIDIA Container Toolkit on GPU worker machines.")

    def _check_object_store(self, config: AppConfig) -> None:
        self._set_task("object_store", "running", "Checking lab object-store config...")
        if config.object_store.endpoint_url and config.object_store.bucket:
            self._set_task("object_store", "pass", f"Object store bucket configured: {config.object_store.bucket}")
        else:
            self._set_task("object_store", "warn", "Object store is not configured yet", "Set endpoint and bucket before submitting real LLM/data jobs.")

    def _finish(self, config: AppConfig) -> None:
        status = self.status()
        blocking = [task for task in status.tasks if task.status == "fail"]
        ray_ok = any(task.id == "ray" and task.status == "pass" for task in status.tasks)
        network_ok = any(task.id == "network" and task.status == "pass" for task in status.tasks)
        worker_ok = any(task.id == "worker_account" and task.status == "pass" for task in status.tasks)
        coordinator_dev_ok = config.app_mode == AppMode.coordinator and platform.system() == "Darwin"
        can_continue = ray_ok and network_ok and (worker_ok or coordinator_dev_ok)
        if blocking and not can_continue:
            message = "Setup finished with blocking issues."
            self._set_task("final", "fail", message)
            self._complete(False, False, message)
        else:
            message = "Setup complete. You can continue." if can_continue else "Setup complete with warnings."
            self._set_task("final", "pass" if can_continue else "warn", message)
            self._complete(True, can_continue, message)

    def _complete(self, succeeded: bool, can_continue: bool, message: str) -> None:
        with self._lock:
            self._status.running = False
            self._status.succeeded = succeeded
            self._status.can_continue = can_continue
            self._status.progress = 100
            self._status.message = message
            self._status.finished_at = datetime.utcnow()
        self.store.append_audit(AuditEvent(event_type="full_setup_finished", actor="owner", message=message, metadata={"succeeded": succeeded, "can_continue": can_continue}))
