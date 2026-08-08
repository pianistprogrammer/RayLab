from pathlib import Path
import sys
import time

from raylab_sidecar.bootstrap import BootstrapResult
from raylab_sidecar.models import AppConfig, AppMode, AuditEvent, ClusterState, Submitter
from raylab_sidecar.ray_control import CommandResult, CommandRunner, RayController, redact_command
from raylab_sidecar.storage import ConfigStore, SecretStore


class FakeRunner:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []

    def run(self, command: list[str], **kwargs: object) -> CommandResult:
        self.commands.append(command)
        return CommandResult(command, 0, "ok", "")


class FakeSecrets(SecretStore):
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get(self, ref: str) -> str | None:
        return self.values.get(ref)

    def set(self, ref: str, value: str) -> None:
        self.values[ref] = value

    def get_or_create_token(self, ref: str, length: int = 48) -> str:
        self.values.setdefault(ref, "secret-token")
        return self.values[ref]


class FakeProcess:
    def __init__(self, name: str, cmdline: list[str]) -> None:
        self.info = {"name": name, "cmdline": cmdline}

    def name(self) -> str:
        return str(self.info["name"])

    def cmdline(self) -> list[str]:
        return list(self.info["cmdline"])


def test_redacts_secret_flag_values() -> None:
    assert redact_command(["ray", "start", "--redis-password", "secret"])[-1] == "<redacted>"


def test_coordinator_start_builds_real_ray_head_command(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.ray_control.has_worker_account", lambda account: True)
    monkeypatch.setattr("raylab_sidecar.ray_control.is_port_available", lambda host, port: True)
    monkeypatch.setattr("raylab_sidecar.ray_control.ray_command", lambda: "/app/runtime/bin/ray")
    monkeypatch.setattr("raylab_sidecar.ray_control.ensure_ray_runtime", lambda on_output=None: BootstrapResult(True, "ready", "/app/runtime/bin/ray", "2.56.1"))
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    config.coordinator.head_host = "127.0.0.1"
    config.resource_caps.max_concurrent_jobs = 2
    store.save(config)
    runner = FakeRunner()
    controller = RayController(store, FakeSecrets(), runner=runner)  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_ray_status_ok", lambda config: False)

    controller.start()

    command = runner.commands[0]
    assert command[:3] == ["/app/runtime/bin/ray", "start", "--head"]
    assert "--redis-password" not in command
    assert "--dashboard-host" in command
    assert command[command.index("--num-cpus") + 1] == "4"
    assert any("Starting Ray" in entry.message for entry in controller.terminal_logs())
    assert any("Ray is running" in entry.message for entry in controller.terminal_logs())


def test_external_coordinator_start_saves_detected_join_address(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.ray_control.has_worker_account", lambda account: True)
    monkeypatch.setattr("raylab_sidecar.ray_control.is_port_available", lambda host, port: True)
    monkeypatch.setattr("raylab_sidecar.ray_control.ray_command", lambda: "/app/runtime/bin/ray")
    monkeypatch.setattr("raylab_sidecar.ray_control.ensure_ray_runtime", lambda on_output=None: BootstrapResult(True, "ready", "/app/runtime/bin/ray", "2.56.1"))
    monkeypatch.setattr("raylab_sidecar.ray_control.detect_lan_ip", lambda: "192.168.1.44")
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    config.coordinator.allow_external_workers = True
    config.coordinator.dashboard_host = "0.0.0.0"
    store.save(config)
    runner = FakeRunner()
    controller = RayController(store, FakeSecrets(), runner=runner)  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_ray_status_ok", lambda config: False)

    status = controller.start()

    saved = store.load()
    assert saved.coordinator.head_host == "192.168.1.44"
    assert saved.coordinator.node_ip_address == "192.168.1.44"
    assert status.address == "192.168.1.44:6379"
    command = runner.commands[0]
    assert command[command.index("--node-ip-address") + 1] == "192.168.1.44"


def test_external_coordinator_status_repairs_loopback_join_address(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.ray_control.detect_lan_ip", lambda: "192.168.1.55")
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    config.coordinator.allow_external_workers = True
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_ray_status_ok", lambda config: True)

    status = controller.status()

    assert status.address == "192.168.1.55:6379"
    assert store.load().coordinator.head_host == "192.168.1.55"


def test_exposed_dashboard_status_repairs_loopback_join_address(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.ray_control.detect_lan_ip", lambda: "192.168.33.17")
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    config.coordinator.dashboard_host = "0.0.0.0"
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_ray_status_ok", lambda config: True)

    status = controller.status()

    assert status.address == "192.168.33.17:6379"
    assert store.load().coordinator.head_host == "192.168.33.17"


def test_running_coordinator_status_publishes_lan_address_even_with_stale_loopback(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.ray_control.detect_lan_ip", lambda: "192.168.33.17")
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    config.coordinator.head_host = "127.0.0.1"
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_ray_status_ok", lambda config: True)

    status = controller.status()

    assert status.address == "192.168.33.17:6379"
    assert store.load().coordinator.head_host == "192.168.33.17"


def test_running_node_status_marks_coordinator_reachable(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.diagnostics.ray_version", lambda: "2.56.1")
    monkeypatch.setattr("raylab_sidecar.diagnostics.python_version", lambda: "3.11.14")
    monkeypatch.setattr("raylab_sidecar.ray_control.has_worker_account", lambda account: True)
    monkeypatch.setattr("raylab_sidecar.diagnostics.resolved_ray_executable", lambda: "/runtime/bin/ray")
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.17"
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_ray_status_ok", lambda config: True)

    status = controller.status()

    ray_port = next(check for check in status.diagnostics if check.id == "ray_port")
    assert ray_port.status == "pass"
    assert ray_port.detail == "Connected to coordinator at 192.168.33.17:6379"


def test_node_running_requires_raylet_not_log_monitor(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.node)
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_local_ray_processes", lambda: [FakeProcess("python", ["log_monitor.py"])])

    assert controller._local_ray_running(config) is False

    monkeypatch.setattr(controller, "_local_ray_processes", lambda: [FakeProcess("raylet", ["/path/raylet"])])

    assert controller._local_ray_running(config) is True


def test_node_running_uses_ps_fallback_for_worker_account_raylet(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.14"
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_local_ray_processes", lambda: [])
    monkeypatch.setattr(controller, "_ps_command_lines", lambda: ["/path/raylet --gcs-address=192.168.33.14:6379"])

    assert controller._local_ray_running(config) is True


def test_nodes_parse_ray_256_cluster_status_usage_by_node(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    config.coordinator.head_host = "192.168.33.14"
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, object]:
            return {
                "data": {
                    "clusterStatus": {
                        "autoscalerReport": {
                            "nodeTypeMapping": {
                                "head-node-id": "node_head",
                                "worker-node-id": "node_worker",
                            }
                        },
                        "loadMetricsReport": {
                            "usageByNode": {
                                "head-node-id": {},
                                "worker-node-id": {
                                    "CPU": [0.0, 4.0],
                                    "GPU": [0.0, 1.0],
                                    "memory": [0.0, 17179869184.0],
                                    "node:192.168.33.16": [0.0, 1.0],
                                },
                            }
                        },
                    }
                }
            }

    monkeypatch.setattr("raylab_sidecar.ray_control.requests.get", lambda url, timeout: Response())

    nodes = controller.nodes()

    assert len(nodes) == 1
    assert nodes[0].node_id == "worker-node-id"
    assert nodes[0].hostname == "192.168.33.16"
    assert nodes[0].status == "active"
    assert nodes[0].cpus_total == 4
    assert nodes[0].gpus_total == 1


def test_audit_append_is_capped(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path / "config.json")
    store.save(AppConfig())
    for index in range(1005):
        store.append_audit(AuditEvent(event_type="test", message=str(index)))

    assert len(store.load().audit) == 1000


def test_submitter_revocation_shape() -> None:
    submitter = Submitter(name="Ada")
    assert submitter.revoked is False


def test_stop_uses_force_and_verifies_local_shutdown(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.ray_control.ray_command", lambda: "/app/runtime/bin/ray")
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    store.save(config)
    runner = FakeRunner()
    controller = RayController(store, FakeSecrets(), runner=runner)  # type: ignore[arg-type]
    monkeypatch.setattr(controller, "_local_ray_processes", lambda: [])
    monkeypatch.setattr(controller, "_tcp_open", lambda host, port: False)
    monkeypatch.setattr(controller, "_ray_status_ok", lambda config: False)

    status = controller.stop()

    assert runner.commands[0] == ["/app/runtime/bin/ray", "stop", "--force"]
    assert status.state == ClusterState.stopped
    assert any("port 6379 is free" in entry.message for entry in controller.terminal_logs())


def test_stop_runs_cleanup_fallback_when_ray_survives(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    store.save(AppConfig(app_mode=AppMode.node))
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    checks = iter([True, False])
    monkeypatch.setattr(controller, "_wait_for_local_stop", lambda config, timeout: None)
    monkeypatch.setattr(controller, "_local_ray_running", lambda config: next(checks))
    monkeypatch.setattr(controller, "_kill_local_ray_processes", lambda: 2)
    monkeypatch.setattr(controller, "_local_ray_processes", lambda: [])

    status = controller.stop()

    assert status.state == ClusterState.stopped
    assert any("Fallback cleanup signaled 2" in entry.message for entry in controller.terminal_logs())


def test_command_runner_timeout_kills_silent_process() -> None:
    started = time.monotonic()
    result = CommandRunner().run([sys.executable, "-c", "import time; time.sleep(5)"], timeout=1)

    assert result.returncode == 124
    assert time.monotonic() - started < 4


def test_worker_wrapper_uses_non_interactive_sudo() -> None:
    command = CommandRunner()._wrap_as_worker(["ray", "start"], "raylab-worker")

    assert command[:5] == ["sudo", "-n", "-u", "raylab-worker", "--"]


def test_macos_worker_wrapper_enables_ray_multinode(monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.ray_control.platform.system", lambda: "Darwin")

    command = CommandRunner()._wrap_as_worker(["ray", "start"], "raylab-worker")

    assert command[:7] == ["sudo", "-n", "-u", "raylab-worker", "--", "env", "RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1"]
    assert command[-2:] == ["ray", "start"]


def test_start_port_conflict_reports_owner(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    monkeypatch.setattr("raylab_sidecar.ray_control.is_port_available", lambda host, port: False)
    monkeypatch.setattr(controller, "_local_ray_processes", lambda: [])
    monkeypatch.setattr(controller, "_port_owner_summary", lambda port: "PID 123 (python -m something)")

    try:
        controller._clear_or_report_port_conflicts(config)
    except ValueError as exc:
        message = str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("expected port conflict")

    assert "Port conflict" in message
    assert "PID 123" in message


def test_start_port_conflict_clears_stale_ray(tmp_path: Path, monkeypatch) -> None:
    store = ConfigStore(tmp_path / "config.json")
    config = AppConfig(app_mode=AppMode.coordinator)
    store.save(config)
    controller = RayController(store, FakeSecrets(), runner=FakeRunner())  # type: ignore[arg-type]
    checks = iter([False, False, False, True, True, True])
    stopped: list[bool] = []
    monkeypatch.setattr("raylab_sidecar.ray_control.is_port_available", lambda host, port: next(checks))
    monkeypatch.setattr(controller, "_local_ray_processes", lambda: [object()])
    monkeypatch.setattr(controller, "stop", lambda: stopped.append(True))

    controller._clear_or_report_port_conflicts(config)

    assert stopped == [True]
