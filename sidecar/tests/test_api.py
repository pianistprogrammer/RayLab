from pathlib import Path

from fastapi.testclient import TestClient

from raylab_sidecar import main
from raylab_sidecar.models import AppConfig, AppMode, ClusterState
from raylab_sidecar.storage import ConfigStore


def test_health_endpoint() -> None:
    client = TestClient(main.app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_hardware_endpoint() -> None:
    client = TestClient(main.app)
    response = client.get("/hardware")
    assert response.status_code == 200
    assert response.json()["cpu_logical"] >= 1
    assert "gpu_type" in response.json()


def test_terminal_logs_endpoint() -> None:
    client = TestClient(main.app)
    response = client.get("/terminal/logs")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_discovery_endpoint(monkeypatch) -> None:
    monkeypatch.setattr(main, "discover_coordinators", lambda config: [])
    client = TestClient(main.app)
    response = client.get("/discovery/coordinators")
    assert response.status_code == 200
    assert response.json() == []


def test_config_roundtrip(tmp_path: Path, monkeypatch) -> None:
    test_store = ConfigStore(tmp_path / "config.json")
    monkeypatch.setattr(main, "store", test_store)
    payload = AppConfig(app_mode=AppMode.node).model_dump(mode="json")
    client = TestClient(main.app)

    response = client.put("/config", json=payload)

    assert response.status_code == 200
    assert response.json()["app_mode"] == "node"


def test_config_external_host_replaces_loopback_with_lan_ip(tmp_path: Path, monkeypatch) -> None:
    test_store = ConfigStore(tmp_path / "config.json")
    monkeypatch.setattr(main, "store", test_store)
    monkeypatch.setattr(main, "detect_lan_ip", lambda: "192.168.1.44")
    payload = AppConfig(app_mode=AppMode.coordinator).model_dump(mode="json")
    payload["coordinator"]["allow_external_workers"] = True
    payload["coordinator"]["dashboard_host"] = "0.0.0.0"
    client = TestClient(main.app)

    response = client.put("/config", json=payload)

    assert response.status_code == 200
    assert response.json()["coordinator"]["head_host"] == "192.168.1.44"
    assert response.json()["coordinator"]["node_ip_address"] == "192.168.1.44"


def test_config_rejects_mode_switch_while_ray_running(tmp_path: Path, monkeypatch) -> None:
    test_store = ConfigStore(tmp_path / "config.json")
    test_store.save(AppConfig(app_mode=AppMode.coordinator))
    monkeypatch.setattr(main, "store", test_store)
    monkeypatch.setattr(main.controller, "store", test_store)
    monkeypatch.setattr(main.controller, "_local_ray_running", lambda config: True)
    main.controller.state = ClusterState.running
    payload = AppConfig(app_mode=AppMode.node).model_dump(mode="json")
    client = TestClient(main.app)

    response = client.put("/config", json=payload)

    assert response.status_code == 409
    assert test_store.load().app_mode == AppMode.coordinator
    main.controller.state = ClusterState.stopped
