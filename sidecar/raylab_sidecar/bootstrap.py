from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from .storage import config_dir


PINNED_PYTHON = os.environ.get("RAYLAB_PYTHON_VERSION", "3.11.14")
PINNED_RAY_VERSION = os.environ.get("RAYLAB_RAY_VERSION", "2.56.1")
RAY_REQUIREMENT = f"ray[default]=={PINNED_RAY_VERSION}"

ProgressCallback = Callable[[str], None]


@dataclass
class BootstrapResult:
    succeeded: bool
    message: str
    ray_executable: str | None = None
    ray_version: str | None = None
    command: list[str] = field(default_factory=list)
    log_tail: list[str] = field(default_factory=list)


_LOCK = threading.Lock()


def runtime_dir() -> Path:
    override = os.environ.get("RAYLAB_RUNTIME_DIR")
    if override:
        return Path(override)
    if platform.system() == "Darwin":
        return Path("/Users/Shared/RayLab/runtime")
    return config_dir() / "runtime"


def venv_dir() -> Path:
    return runtime_dir() / "venv"


def vendor_wheels_dir() -> Path | None:
    candidates: list[Path] = []
    override = os.environ.get("RAYLAB_VENDOR_WHEELS")
    if override:
        candidates.append(Path(override))
    here = Path(__file__).resolve()
    candidates.extend(
        [
            here.parents[2] / "vendor" / "wheels" if len(here.parents) > 2 else here.parent / "vendor" / "wheels",
            here.parent.parent / "vendor" / "wheels",
            Path(sys.argv[0]).resolve().parent / "vendor" / "wheels",
        ]
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _resource_roots() -> list[Path]:
    here = Path(__file__).resolve()
    executable_dir = Path(sys.argv[0]).resolve().parent
    roots = [executable_dir, executable_dir.parent]
    if len(here.parents) > 2:
        roots.append(here.parents[2])
    roots.append(here.parent.parent)
    unique: list[Path] = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return unique


def marker_path() -> Path:
    return runtime_dir() / "ray-runtime.json"


def ray_executable_path(base: Path | None = None) -> Path:
    root = base or venv_dir()
    if os.name == "nt":
        return root / "Scripts" / "ray.exe"
    return root / "bin" / "ray"


def venv_python_path(base: Path | None = None) -> Path:
    root = base or venv_dir()
    if os.name == "nt":
        return root / "Scripts" / "python.exe"
    return root / "bin" / "python"


def find_uv() -> str | None:
    override = os.environ.get("RAYLAB_UV_BIN")
    if override and Path(override).exists():
        return override
    for root in _resource_roots():
        bundled = root / "vendor" / "bin" / ("uv.exe" if os.name == "nt" else "uv")
        if bundled.exists():
            return str(bundled)
    found = shutil.which("uv")
    if found:
        return found
    candidates = [
        Path.home() / ".local" / "bin" / "uv",
        Path.home() / ".cargo" / "bin" / "uv",
        Path("/opt/homebrew/bin/uv"),
        Path("/usr/local/bin/uv"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def ray_version(ray_bin: str | Path | None = None, timeout: int = 20) -> str | None:
    executable = str(ray_bin or resolved_ray_executable() or "ray")
    try:
        result = subprocess.run([executable, "--version"], check=False, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    output = (result.stdout or result.stderr).strip()
    if not output:
        return None
    return output.split()[-1]


def python_version(python_bin: str | Path | None = None, timeout: int = 20) -> str | None:
    executable = str(python_bin or venv_python_path())
    try:
        result = subprocess.run([executable, "--version"], check=False, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    output = (result.stdout or result.stderr).strip()
    if not output:
        return None
    return output.split()[-1]


def has_compatible_python() -> bool:
    return python_version() == PINNED_PYTHON


def resolved_ray_executable() -> str | None:
    override = os.environ.get("RAYLAB_RAY_BIN")
    if override and Path(override).exists():
        return override
    local = ray_executable_path()
    if local.exists():
        return str(local)
    if os.environ.get("RAYLAB_ALLOW_SYSTEM_RAY") == "1":
        return shutil.which("ray")
    return None


def ray_command() -> str:
    return resolved_ray_executable() or "ray"


def has_compatible_ray() -> bool:
    executable = resolved_ray_executable()
    if not executable:
        return False
    return ray_version(executable) == PINNED_RAY_VERSION


def _record_marker(ray_bin: Path, version: str) -> None:
    marker_path().write_text(
        json.dumps(
            {
                "python": PINNED_PYTHON,
                "ray": version,
                "ray_executable": str(ray_bin),
                "created_at": datetime.utcnow().isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _make_runtime_accessible() -> None:
    if platform.system() != "Darwin":
        return
    root = runtime_dir()
    if not root.exists():
        return
    paths: list[Path] = []
    if root.parent == Path("/Users/Shared/RayLab"):
        paths.append(root.parent)
    paths.extend([root, *root.rglob("*")])
    for shared_path in [Path("/Users/Shared/RayLab/python"), Path("/Users/Shared/RayLab/uv-cache")]:
        if shared_path.exists():
            paths.extend([shared_path, *shared_path.rglob("*")])
    for path in paths:
        try:
            mode = path.stat().st_mode
            if path.is_dir():
                path.chmod(mode | 0o755)
            else:
                path.chmod(mode | 0o644)
        except OSError:
            continue
    ray_bin = ray_executable_path()
    python_bin = venv_python_path()
    for executable in [ray_bin, python_bin]:
        if executable.exists():
            try:
                executable.chmod(executable.stat().st_mode | 0o755)
            except OSError:
                pass


def _subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    if platform.system() == "Darwin" and not os.environ.get("RAYLAB_RUNTIME_DIR"):
        shared_root = Path("/Users/Shared/RayLab")
        env.setdefault("UV_PYTHON_INSTALL_DIR", str(shared_root / "python"))
        env.setdefault("UV_CACHE_DIR", str(shared_root / "uv-cache"))
    return env


def _run(command: list[str], *, timeout: int, on_output: ProgressCallback | None, log_tail: list[str]) -> tuple[bool, str]:
    if on_output:
        on_output("$ " + " ".join(command))
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=_subprocess_env())
    except OSError as exc:
        return False, str(exc)
    assert process.stdout is not None
    output_lock = threading.Lock()

    def read_output() -> None:
        for line in process.stdout or []:
            text = line.rstrip()
            if text:
                with output_lock:
                    log_tail.append(text)
                    del log_tail[:-30]
                if on_output:
                    on_output(text)

    reader = threading.Thread(target=read_output, name="raylab-bootstrap-output", daemon=True)
    reader.start()
    started = time.monotonic()
    while process.poll() is None:
        if time.monotonic() - started > timeout:
            process.kill()
            reader.join(timeout=1)
            return False, f"Command timed out after {timeout} seconds"
        time.sleep(0.1)
    reader.join(timeout=2)
    returncode = process.returncode or 0
    with output_lock:
        output = "\n".join(log_tail[-30:])
    if returncode != 0 and not output:
        output = f"Command failed with exit code {returncode}"
    return returncode == 0, output


def _uv_venv_command(uv: str) -> list[str]:
    return [uv, "venv", str(venv_dir()), "--python", PINNED_PYTHON, "--managed-python"]


def ensure_ray_runtime(on_output: ProgressCallback | None = None) -> BootstrapResult:
    with _LOCK:
        runtime_dir().mkdir(parents=True, exist_ok=True)
        local_ray = ray_executable_path()
        if local_ray.exists():
            version = ray_version(local_ray)
            py_version = python_version()
            if version == PINNED_RAY_VERSION and py_version == PINNED_PYTHON:
                _make_runtime_accessible()
                _record_marker(local_ray, version)
                return BootstrapResult(True, f"Ray runtime is ready: {version}", str(local_ray), version)
            if py_version and py_version != PINNED_PYTHON:
                if on_output:
                    on_output(f"Replacing Ray runtime Python {py_version} with pinned Python {PINNED_PYTHON}...")
                shutil.rmtree(venv_dir(), ignore_errors=True)

        log_tail: list[str] = []
        uv = find_uv()
        if uv:
            if on_output:
                on_output(f"Preparing app-local Python {PINNED_PYTHON} and Ray {PINNED_RAY_VERSION} with uv...")
            venv_command = _uv_venv_command(uv)
            ok, output = _run(venv_command, timeout=600, on_output=on_output, log_tail=log_tail)
            if not ok:
                if on_output:
                    on_output(f"Python {PINNED_PYTHON} was not available to uv; installing it now...")
                install_python_command = [uv, "python", "install", PINNED_PYTHON]
                installed, install_output = _run(install_python_command, timeout=600, on_output=on_output, log_tail=log_tail)
                if not installed:
                    return BootstrapResult(False, "Could not install the app-local Python runtime", command=install_python_command, log_tail=log_tail or [install_output])
                ok, output = _run(venv_command, timeout=600, on_output=on_output, log_tail=log_tail)
            if not ok:
                return BootstrapResult(False, "Could not create the app-local Python environment", command=venv_command, log_tail=log_tail or [output])
            install_command = [uv, "pip", "install", "--python", str(venv_python_path()), RAY_REQUIREMENT]
            ok, output = _run(install_command, timeout=300, on_output=on_output, log_tail=log_tail)
            if not ok:
                wheels = vendor_wheels_dir()
                if wheels:
                    if on_output:
                        on_output(f"Online Ray install failed; retrying from bundled wheels at {wheels}")
                    offline = [uv, "pip", "install", "--python", str(venv_python_path()), "--no-index", "--find-links", str(wheels), RAY_REQUIREMENT]
                    ok, output = _run(offline, timeout=300, on_output=on_output, log_tail=log_tail)
                    install_command = offline
            if not ok:
                return BootstrapResult(False, "Ray installation failed", command=install_command, log_tail=log_tail or [output])
        else:
            if on_output:
                on_output("uv was not found; falling back to Python venv + pip for Ray runtime setup.")
            ok, output = _run([sys.executable, "-m", "venv", str(venv_dir())], timeout=300, on_output=on_output, log_tail=log_tail)
            if not ok:
                return BootstrapResult(False, "Could not create the app-local Python environment and uv is not available", command=[sys.executable, "-m", "venv", str(venv_dir())], log_tail=log_tail or [output])
            pip = [str(venv_python_path()), "-m", "pip", "install", RAY_REQUIREMENT]
            ok, output = _run(pip, timeout=600, on_output=on_output, log_tail=log_tail)
            if not ok:
                wheels = vendor_wheels_dir()
                if wheels:
                    offline = [str(venv_python_path()), "-m", "pip", "install", "--no-index", "--find-links", str(wheels), RAY_REQUIREMENT]
                    ok, output = _run(offline, timeout=600, on_output=on_output, log_tail=log_tail)
                    pip = offline
            if not ok:
                return BootstrapResult(False, "Ray installation failed", command=pip, log_tail=log_tail or [output])

        version = ray_version(local_ray)
        if version != PINNED_RAY_VERSION:
            return BootstrapResult(False, f"Ray runtime validation failed: expected {PINNED_RAY_VERSION}, got {version or 'none'}", str(local_ray), version, log_tail=log_tail)
        py_version = python_version()
        if py_version != PINNED_PYTHON:
            return BootstrapResult(False, f"Python runtime validation failed: expected {PINNED_PYTHON}, got {py_version or 'none'}", str(local_ray), version, log_tail=log_tail)
        _make_runtime_accessible()
        _record_marker(local_ray, version)
        return BootstrapResult(True, f"Ray runtime is ready: {version}", str(local_ray), version, log_tail=log_tail)
