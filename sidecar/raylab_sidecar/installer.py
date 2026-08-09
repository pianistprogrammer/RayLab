from __future__ import annotations

import threading
from datetime import datetime
from typing import Callable

from .bootstrap import PINNED_RAY_VERSION, RAY_REQUIREMENT, ensure_ray_runtime, has_compatible_ray, ray_version
from .models import AuditEvent, InstallStatus
from .storage import ConfigStore


class RayInstaller:
    def __init__(self, store: ConfigStore, on_log: Callable[[str, str], None] | None = None) -> None:
        self.store = store
        self.on_log = on_log
        self._lock = threading.Lock()
        self._status = InstallStatus(command=self.command())

    def command(self) -> list[str]:
        return ["raylab-bootstrap", RAY_REQUIREMENT]

    def status(self) -> InstallStatus:
        with self._lock:
            return self._status.model_copy(deep=True)

    def start(self) -> InstallStatus:
        with self._lock:
            if self._status.running:
                return self._status.model_copy(deep=True)
            if has_compatible_ray():
                self._log(f"Pinned Ray runtime is already installed: {ray_version() or PINNED_RAY_VERSION}")
                self._status = InstallStatus(
                    running=False,
                    succeeded=True,
                    message=f"Pinned Ray runtime is already installed: {ray_version() or PINNED_RAY_VERSION}",
                    command=self.command(),
                    finished_at=datetime.utcnow(),
                )
                return self._status.model_copy(deep=True)
            self._status = InstallStatus(
                running=True,
                succeeded=None,
                message=f"Installing app-local Ray runtime {PINNED_RAY_VERSION}...",
                command=self.command(),
                started_at=datetime.utcnow(),
            )
            self._log(f"Installing app-local Ray runtime {PINNED_RAY_VERSION}...")
            self._log(f"$ {' '.join(self.command())}")
        thread = threading.Thread(target=self._run, name="ray-installer", daemon=True)
        thread.start()
        return self.status()

    def _log(self, message: str, stream: str = "system") -> None:
        if self.on_log:
            self.on_log(message, stream)

    def _run(self) -> None:
        command = self.command()
        log_tail: list[str] = []
        try:
            def progress(line: str) -> None:
                self._log(line, "stdout")
                log_tail.append(line)
                del log_tail[:-30]
                with self._lock:
                    self._status.log_tail = list(log_tail)
                    self._status.message = line[-240:]

            result = ensure_ray_runtime(on_output=progress)
            succeeded = result.succeeded
            log_tail = result.log_tail or log_tail
            message = result.message
            command = result.command or command
        except Exception as exc:  # pragma: no cover - depends on local installer/runtime state
            succeeded = False
            message = f"Ray installation failed: {exc}"
            log_tail.append(message)
            self._log(message, "stderr")
        with self._lock:
            self._status.running = False
            self._status.succeeded = succeeded
            self._status.message = message
            self._status.finished_at = datetime.utcnow()
            self._status.log_tail = log_tail[-30:]
        self._log(message, "system" if succeeded else "stderr")
        self.store.append_audit(
            AuditEvent(
                event_type="ray_install_finished",
                actor="owner",
                message=message,
                metadata={"succeeded": succeeded, "command": command},
            )
        )
