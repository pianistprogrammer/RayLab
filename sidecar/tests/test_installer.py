from pathlib import Path

from raylab_sidecar.installer import RAY_REQUIREMENT, RayInstaller
from raylab_sidecar.storage import ConfigStore


def test_installer_uses_bootstrap_runtime(tmp_path: Path) -> None:
    installer = RayInstaller(ConfigStore(tmp_path / "config.json"))

    command = installer.command()

    assert command == ["raylab-bootstrap", RAY_REQUIREMENT]


def test_status_starts_idle(tmp_path: Path) -> None:
    installer = RayInstaller(ConfigStore(tmp_path / "config.json"))

    status = installer.status()

    assert status.running is False
    assert status.message == "Not started"
