from pathlib import Path

from raylab_sidecar import bootstrap


def test_macos_runtime_defaults_to_shared_location(monkeypatch) -> None:
    monkeypatch.delenv("RAYLAB_RUNTIME_DIR", raising=False)
    monkeypatch.setattr(bootstrap.platform, "system", lambda: "Darwin")

    assert bootstrap.runtime_dir() == Path("/Users/Shared/RayLab/runtime")


def test_macos_uv_environment_uses_shared_locations(monkeypatch) -> None:
    monkeypatch.delenv("RAYLAB_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("UV_PYTHON_INSTALL_DIR", raising=False)
    monkeypatch.delenv("UV_CACHE_DIR", raising=False)
    monkeypatch.setattr(bootstrap.platform, "system", lambda: "Darwin")

    env = bootstrap._subprocess_env()

    assert env["UV_PYTHON_INSTALL_DIR"] == "/Users/Shared/RayLab/python"
    assert env["UV_CACHE_DIR"] == "/Users/Shared/RayLab/uv-cache"


def test_runtime_override_still_wins(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("RAYLAB_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setattr(bootstrap.platform, "system", lambda: "Darwin")

    assert bootstrap.runtime_dir() == tmp_path / "runtime"


def test_bootstrap_requires_exact_pinned_python(monkeypatch) -> None:
    monkeypatch.setattr(bootstrap, "python_version", lambda python_bin=None, timeout=20: "3.11.15")

    assert bootstrap.has_compatible_python() is False


def test_uv_bootstrap_installs_missing_managed_python(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("RAYLAB_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setattr(bootstrap, "find_uv", lambda: "/bundle/vendor/bin/uv")
    monkeypatch.setattr(bootstrap, "ray_version", lambda ray_bin=None, timeout=20: bootstrap.PINNED_RAY_VERSION)
    monkeypatch.setattr(bootstrap, "python_version", lambda python_bin=None, timeout=20: bootstrap.PINNED_PYTHON)
    monkeypatch.setattr(bootstrap, "_make_runtime_accessible", lambda: None)

    calls: list[list[str]] = []

    def fake_run(command, *, timeout, on_output, log_tail):
        calls.append(command)
        if command[:2] == ["/bundle/vendor/bin/uv", "venv"] and len(calls) == 1:
            log_tail.append("No interpreter found for Python 3.11.14 in managed installations")
            return False, log_tail[-1]
        return True, "ok"

    monkeypatch.setattr(bootstrap, "_run", fake_run)

    result = bootstrap.ensure_ray_runtime()

    assert result.succeeded is True
    assert calls[0] == bootstrap._uv_venv_command("/bundle/vendor/bin/uv")
    assert calls[1] == ["/bundle/vendor/bin/uv", "python", "install", bootstrap.PINNED_PYTHON]
    assert calls[2] == bootstrap._uv_venv_command("/bundle/vendor/bin/uv")
    assert calls[3][:4] == ["/bundle/vendor/bin/uv", "pip", "install", "--python"]
