from __future__ import annotations

import json
import platform
import shutil
import subprocess

import psutil

from .models import HardwareInfo


def detect_hardware() -> HardwareInfo:
    gpu_names, gpu_type, source = _detect_gpus()
    memory_total_gb = _system_memory_gb()
    gpu_memory_total_gb = _gpu_memory_gb(gpu_type, memory_total_gb)
    return HardwareInfo(
        cpu_logical=psutil.cpu_count(logical=True) or 0,
        cpu_physical=psutil.cpu_count(logical=False),
        memory_total_gb=memory_total_gb,
        gpu_count=len(gpu_names),
        gpu_names=gpu_names,
        gpu_type=gpu_type,
        gpu_memory_total_gb=gpu_memory_total_gb,
        gpu_memory_shared=gpu_type == "mps" and gpu_memory_total_gb is not None,
        source=source,
    )


def _system_memory_gb() -> float:
    return round(psutil.virtual_memory().total / 1024 / 1024 / 1024, 1)


def _gpu_memory_gb(gpu_type: str, system_memory_gb: float) -> float | None:
    if gpu_type == "cuda":
        return _nvidia_gpu_memory_gb()
    if gpu_type == "mps":
        return system_memory_gb
    return None


def _detect_gpus() -> tuple[list[str], str, str]:
    nvidia = _nvidia_gpus()
    if nvidia:
        return nvidia, "cuda", "nvidia-smi"

    mps = _mac_mps_gpus()
    if mps:
        return mps, "mps", "system_profiler"

    ray = _ray_gpus()
    if ray:
        return ray, "ray", "ray"

    return [], "none", "psutil"


def _nvidia_gpus() -> list[str]:
    if not shutil.which("nvidia-smi"):
        return []
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _nvidia_gpu_memory_gb() -> float | None:
    if not shutil.which("nvidia-smi"):
        return None
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None

    total_mib = 0.0
    for line in result.stdout.splitlines():
        try:
            total_mib += float(line.strip())
        except ValueError:
            continue
    if total_mib <= 0:
        return None
    return round(total_mib / 1024, 1)


def _mac_mps_gpus() -> list[str]:
    if platform.system() != "Darwin":
        return []
    if not shutil.which("system_profiler"):
        return []
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType", "-json"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        return []
    if result.returncode != 0:
        return []
    try:
        payload = json.loads(result.stdout.strip() or "{}")
    except json.JSONDecodeError:
        return []

    displays = payload.get("SPDisplaysDataType", [])
    if not isinstance(displays, list):
        return []

    names: list[str] = []
    for item in displays:
        if not isinstance(item, dict):
            continue
        metal = str(item.get("spdisplays_metal") or item.get("sppci_metal") or "").lower()
        chipset = str(item.get("sppci_model") or item.get("spdisplays_chipset") or item.get("_name") or "").strip()
        if "supported" in metal or chipset.lower().startswith("apple "):
            names.append(f"Apple Metal/MPS ({chipset or 'GPU'})")
    return names


def _ray_gpus() -> list[str]:
    try:
        script = "import ray._private.utils as u, json; print(json.dumps(u.get_visible_accelerator_ids().get('GPU', [])))"
        result = subprocess.run(["python3", "-c", script], check=False, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    try:
        ids = json.loads(result.stdout.strip() or "[]")
    except json.JSONDecodeError:
        return []
    if not ids:
        return []
    return [f"GPU {item}" for item in ids]
