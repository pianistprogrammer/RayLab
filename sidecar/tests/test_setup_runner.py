from pathlib import Path

from raylab_sidecar.models import AppConfig, AppMode
from raylab_sidecar.setup_runner import SetupRunner
from raylab_sidecar.storage import ConfigStore


def test_macos_node_setup_creates_missing_worker_account(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.node)
    store.save(config)
    runner = SetupRunner(store)
    checks = iter([False, True])
    monkeypatch.setattr("raylab_sidecar.setup_runner.platform.system", lambda: "Darwin")
    monkeypatch.setattr("raylab_sidecar.setup_runner.has_worker_account", lambda account: next(checks))
    monkeypatch.setattr(runner, "_create_macos_worker_account", lambda account: (True, "created"))

    runner._ensure_worker_account(config)

    task = next(task for task in runner.status().tasks if task.id == "worker_account")
    assert task.status == "pass"
    assert "Created account raylab-worker" in task.detail


def test_macos_existing_worker_account_gets_launch_permission(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.node)
    store.save(config)
    runner = SetupRunner(store)
    launch_checks = iter([False, True])
    monkeypatch.setattr("raylab_sidecar.setup_runner.platform.system", lambda: "Darwin")
    monkeypatch.setattr("raylab_sidecar.setup_runner.has_worker_account", lambda account: True)
    monkeypatch.setattr(runner, "_can_launch_as_worker", lambda account: next(launch_checks))
    monkeypatch.setattr(runner, "_create_macos_worker_account", lambda account: (True, "approved"))

    runner._ensure_worker_account(config)

    task = next(task for task in runner.status().tasks if task.id == "worker_account")
    assert task.status == "pass"
    assert "worker launch permission is approved" in task.detail


def test_macos_worker_account_script_uses_admin_prompt_and_sudoers(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    runner = SetupRunner(store)
    commands: list[list[str]] = []
    monkeypatch.setattr(runner, "_owner_short_name", lambda: "alice")

    def fake_run(command: list[str], timeout: int = 600) -> tuple[bool, str]:
        commands.append(command)
        return True, "ok"

    monkeypatch.setattr(runner, "_run_command", fake_run)

    ok, _output = runner._create_macos_worker_account("raylab-worker")

    assert ok is True
    command = commands[0]
    assert command[:2] == ["osascript", "-e"]
    script = command[2]
    assert "with administrator privileges" in script
    assert "RayLab needs administrator permission" in script
    assert "IsHidden 1" in script
    assert "/var/lib/$ACCOUNT/jobs" in script
    assert "$OWNER ALL=($ACCOUNT) NOPASSWD: ALL" in script


def test_node_setup_warns_when_coordinator_is_unreachable_without_scanning_local_ports(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.17"
    store.save(config)
    runner = SetupRunner(store)
    monkeypatch.setattr("raylab_sidecar.setup_runner.is_port_reachable", lambda host, port: False)

    next_config = runner._ensure_ports(config)

    task = next(task for task in runner.status().tasks if task.id == "ports")
    assert next_config.coordinator.ray_port == 6379
    assert task.status == "warn"
    assert "Coordinator is not reachable" in task.detail


def test_node_setup_passes_when_coordinator_is_reachable(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.17"
    store.save(config)
    runner = SetupRunner(store)
    monkeypatch.setattr("raylab_sidecar.setup_runner.is_port_reachable", lambda host, port: True)

    runner._ensure_ports(config)

    task = next(task for task in runner.status().tasks if task.id == "ports")
    assert task.status == "pass"
    assert "192.168.33.17:6379" in task.detail


def test_ray_setup_reinstalls_when_python_patch_version_mismatches(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    runner = SetupRunner(store)
    calls: list[bool] = []
    monkeypatch.setattr("raylab_sidecar.setup_runner.ray_version", lambda: "2.56.1")
    versions = iter(["3.11.15", "3.11.14"])
    monkeypatch.setattr("raylab_sidecar.setup_runner.python_version", lambda: next(versions))

    def fake_ensure_ray_runtime(on_output=None):
        from raylab_sidecar.bootstrap import BootstrapResult

        calls.append(True)
        return BootstrapResult(True, "ready", "/runtime/bin/ray", "2.56.1")

    monkeypatch.setattr("raylab_sidecar.setup_runner.ensure_ray_runtime", fake_ensure_ray_runtime)

    runner._ensure_ray()

    task = next(task for task in runner.status().tasks if task.id == "ray")
    assert calls == [True]
    assert task.status == "pass"
    assert "Python 3.11.14" in task.detail
