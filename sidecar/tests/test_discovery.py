from raylab_sidecar.discovery import _candidate_hosts, _ordered_ports, _probe_host, _probe_host_ports, discover_coordinators
from raylab_sidecar.models import AppConfig, AppMode


def test_probe_host_returns_candidate_when_ray_port_open(monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.discovery._tcp_open", lambda host, port, timeout, allow_cli_fallback=False, cli_user=None: port == 6379)

    candidate = _probe_host("192.168.1.20", 6379, 8265, 0.01)

    assert candidate is not None
    assert candidate.host == "192.168.1.20"
    assert candidate.ray_port == 6379
    assert candidate.dashboard_url is None
    assert candidate.confidence == 70


def test_probe_host_includes_dashboard_when_reachable(monkeypatch) -> None:
    monkeypatch.setattr("raylab_sidecar.discovery._tcp_open", lambda host, port, timeout, allow_cli_fallback=False, cli_user=None: True)

    candidate = _probe_host("192.168.1.20", 6379, 8265, 0.01)

    assert candidate is not None
    assert candidate.dashboard_url == "http://192.168.1.20:8265"
    assert candidate.confidence == 95


def test_probe_host_ports_finds_non_default_ray_port(monkeypatch) -> None:
    open_ports = {6382, 8266}
    monkeypatch.setattr("raylab_sidecar.discovery._tcp_open", lambda host, port, timeout, allow_cli_fallback=False, cli_user=None: port in open_ports)

    candidate = _probe_host_ports("192.168.1.20", [6379, 6382], [8265, 8266], 0.01)

    assert candidate is not None
    assert candidate.ray_port == 6382
    assert candidate.dashboard_port == 8266
    assert candidate.dashboard_url == "http://192.168.1.20:8266"


def test_ordered_ports_keeps_configured_port_first() -> None:
    assert _ordered_ports(6382, [6379, 6382, 6383]) == [6382, 6379, 6383]


def test_candidate_hosts_includes_configured_non_loopback_host(monkeypatch) -> None:
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.17"
    monkeypatch.setattr("raylab_sidecar.discovery._arp_neighbor_hosts", lambda: set())
    monkeypatch.setattr("raylab_sidecar.discovery.psutil.net_if_addrs", lambda: {})

    assert _candidate_hosts(config) == ["192.168.33.17"]


def test_candidate_hosts_ignores_configured_loopback_host(monkeypatch) -> None:
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "127.0.0.1"
    monkeypatch.setattr("raylab_sidecar.discovery._arp_neighbor_hosts", lambda: set())
    monkeypatch.setattr("raylab_sidecar.discovery.psutil.net_if_addrs", lambda: {})

    assert _candidate_hosts(config) == []


def test_discovery_returns_reachable_configured_host_even_when_lan_scan_is_empty(monkeypatch) -> None:
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.17"
    monkeypatch.setattr("raylab_sidecar.discovery._arp_neighbor_hosts", lambda: set())
    monkeypatch.setattr("raylab_sidecar.discovery.psutil.net_if_addrs", lambda: {})
    monkeypatch.setattr("raylab_sidecar.discovery._tcp_open", lambda host, port, timeout, allow_cli_fallback=False, cli_user=None: host == "192.168.33.17" and port == 6379)

    candidates = discover_coordinators(config)

    assert len(candidates) == 1
    assert candidates[0].host == "192.168.33.17"
    assert candidates[0].confidence == 98
    assert candidates[0].detail == "Saved coordinator address is reachable"


def test_discovery_does_not_surface_saved_host_when_probe_is_inconclusive(monkeypatch) -> None:
    config = AppConfig(app_mode=AppMode.node)
    config.coordinator.head_host = "192.168.33.17"
    monkeypatch.setattr("raylab_sidecar.discovery._arp_neighbor_hosts", lambda: set())
    monkeypatch.setattr("raylab_sidecar.discovery.psutil.net_if_addrs", lambda: {})
    monkeypatch.setattr("raylab_sidecar.discovery._tcp_open", lambda host, port, timeout, allow_cli_fallback=False, cli_user=None: False)

    candidates = discover_coordinators(config)

    assert candidates == []
