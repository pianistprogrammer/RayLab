from types import SimpleNamespace

from raylab_sidecar import hardware


def test_mac_mps_detection_uses_system_profiler(monkeypatch) -> None:
    payload = '{"SPDisplaysDataType":[{"spdisplays_chipset":"Apple M3 Pro","spdisplays_metal":"spdisplays_supported"}]}'
    monkeypatch.setattr(hardware.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(hardware.shutil, "which", lambda name: "/usr/sbin/system_profiler" if name == "system_profiler" else None)
    monkeypatch.setattr(hardware.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=payload))

    assert hardware._mac_mps_gpus() == ["Apple Metal/MPS (Apple M3 Pro)"]


def test_mac_mps_detection_skips_non_macos(monkeypatch) -> None:
    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")

    assert hardware._mac_mps_gpus() == []
