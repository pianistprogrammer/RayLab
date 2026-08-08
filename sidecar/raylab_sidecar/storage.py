from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    import keyring
except Exception:  # pragma: no cover - depends on local Python environment
    keyring = None  # type: ignore[assignment]

from .models import AppConfig, AuditEvent, ResourceCaps


APP_NAME = "RayLabClusterManager"
LEGACY_DEFAULT_CAPS = ResourceCaps()


def config_dir() -> Path:
    override = os.environ.get("RAYLAB_CONFIG_DIR")
    if override:
        return Path(override)
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "raylab-cluster-manager"


def config_path() -> Path:
    return config_dir() / "config.json"


class ConfigStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or config_path()

    def load(self) -> AppConfig:
        if not self.path.exists():
            return AppConfig(resource_caps=_detected_resource_caps())
        data = json.loads(self.path.read_text(encoding="utf-8"))
        config = AppConfig.model_validate(data)
        if _uses_legacy_default_caps(config.resource_caps):
            config.resource_caps = _detected_resource_caps()
            self.save(config)
        return config

    def save(self, config: AppConfig) -> AppConfig:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(config.model_dump_json(indent=2), encoding="utf-8")
        return config

    def append_audit(self, event: AuditEvent) -> AppConfig:
        config = self.load()
        config.audit.insert(0, event)
        config.audit = config.audit[:1000]
        return self.save(config)


def _uses_legacy_default_caps(caps: ResourceCaps) -> bool:
    return (
        caps.cpus == LEGACY_DEFAULT_CAPS.cpus
        and caps.gpus == LEGACY_DEFAULT_CAPS.gpus
        and caps.memory_gb == LEGACY_DEFAULT_CAPS.memory_gb
        and caps.gpu_memory_gb == LEGACY_DEFAULT_CAPS.gpu_memory_gb
        and caps.max_concurrent_jobs == LEGACY_DEFAULT_CAPS.max_concurrent_jobs
    )


def _detected_resource_caps() -> ResourceCaps:
    try:
        from .hardware import detect_hardware

        hardware = detect_hardware()
    except Exception:
        return LEGACY_DEFAULT_CAPS.model_copy()

    return ResourceCaps(
        cpus=max(1, hardware.cpu_logical or int(LEGACY_DEFAULT_CAPS.cpus)),
        gpus=max(0, hardware.gpu_count),
        memory_gb=max(0.1, hardware.memory_total_gb or LEGACY_DEFAULT_CAPS.memory_gb),
        gpu_memory_gb=max(0, hardware.gpu_memory_total_gb or 0),
        max_concurrent_jobs=LEGACY_DEFAULT_CAPS.max_concurrent_jobs,
    )


class SecretStore:
    def get(self, ref: str) -> str | None:
        fallback = config_dir() / "dev-secrets.json"
        if keyring is None:
            if fallback.exists():
                return json.loads(fallback.read_text(encoding="utf-8")).get(ref)
            return None
        try:
            return keyring.get_password(APP_NAME, ref)
        except Exception:
            if fallback.exists():
                return json.loads(fallback.read_text(encoding="utf-8")).get(ref)
            return None

    def set(self, ref: str, value: str) -> None:
        fallback = config_dir() / "dev-secrets.json"
        if keyring is None:
            fallback.parent.mkdir(parents=True, exist_ok=True)
            data: dict[str, Any] = {}
            if fallback.exists():
                data = json.loads(fallback.read_text(encoding="utf-8"))
            data[ref] = value
            fallback.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return
        try:
            keyring.set_password(APP_NAME, ref, value)
        except Exception:
            fallback.parent.mkdir(parents=True, exist_ok=True)
            data: dict[str, Any] = {}
            if fallback.exists():
                data = json.loads(fallback.read_text(encoding="utf-8"))
            data[ref] = value
            fallback.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def get_or_create_token(self, ref: str, length: int = 48) -> str:
        import secrets

        existing = self.get(ref)
        if existing:
            return existing
        token = secrets.token_urlsafe(length)
        self.set(ref, token)
        return token
