from raylab_sidecar.diagnostics import diagnostics
from raylab_sidecar.models import AppConfig, AppMode


def test_macos_node_worker_account_requires_launch_permission(monkeypatch) -> None:
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.14"
    monkeypatch.setattr("raylab_sidecar.diagnostics.platform.system", lambda: "Darwin")
    monkeypatch.setattr("raylab_sidecar.diagnostics.ray_version", lambda: "2.56.1")
    monkeypatch.setattr("raylab_sidecar.diagnostics.python_version", lambda: "3.11.14")
    monkeypatch.setattr("raylab_sidecar.diagnostics.resolved_ray_executable", lambda: "/runtime/bin/ray")
    monkeypatch.setattr("raylab_sidecar.diagnostics.is_coordinator_reachable", lambda config: True)
    monkeypatch.setattr("raylab_sidecar.diagnostics.has_worker_account", lambda account: True)
    monkeypatch.setattr("raylab_sidecar.diagnostics.has_worker_launch_permission", lambda account: False)
    monkeypatch.setattr("raylab_sidecar.diagnostics.container_runtime_status", lambda runtime: (False, "missing"))

    checks = diagnostics(config)

    worker = next(check for check in checks if check.id == "worker_account")
    assert worker.status == "fail"
    assert "administrator approval" in worker.detail
