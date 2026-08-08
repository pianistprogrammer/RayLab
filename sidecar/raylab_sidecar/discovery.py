from __future__ import annotations

import ipaddress
import socket
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections.abc import Iterable

import psutil

from .models import AppConfig, DiscoveryCandidate

COMMON_RAY_PORTS = (6379, 6380, 6381, 6382, 6383, 6384, 6385)
COMMON_DASHBOARD_PORTS = (8265, 8266, 8267, 8268, 8269, 8270)
MAX_SCAN_HOSTS = 2048


def discover_coordinators(config: AppConfig, timeout: float = 0.3) -> list[DiscoveryCandidate]:
    ray_ports = _ordered_ports(config.coordinator.ray_port, COMMON_RAY_PORTS)
    dashboard_ports = _ordered_ports(config.coordinator.dashboard_port, COMMON_DASHBOARD_PORTS)
    candidates: list[DiscoveryCandidate] = []
    configured_host = config.coordinator.head_host.strip()
    if configured_host and not is_loopback_host(configured_host):
        configured = _probe_host_ports(configured_host, ray_ports, dashboard_ports, max(timeout, 1.0))
        if not configured:
            configured = DiscoveryCandidate(
                host=configured_host,
                ray_port=config.coordinator.ray_port,
                dashboard_port=None,
                dashboard_url=None,
                confidence=55,
                detail="Saved coordinator address",
            )
        else:
            configured.confidence = max(configured.confidence, 98)
            configured.detail = "Saved coordinator address is reachable"
        candidates.append(configured)
    hosts = _candidate_hosts(config)
    if configured_host:
        hosts = [host for host in hosts if host != configured_host]
    if not hosts:
        return candidates

    with ThreadPoolExecutor(max_workers=192) as executor:
        futures = {executor.submit(_probe_host_ports, host, ray_ports, dashboard_ports, timeout): host for host in hosts}
        for future in as_completed(futures):
            candidate = future.result()
            if candidate:
                candidates.append(candidate)

    return sorted(candidates, key=lambda item: (-item.confidence, item.host))[:24]


def _probe_host(host: str, ray_port: int, dashboard_port: int, timeout: float) -> DiscoveryCandidate | None:
    return _probe_host_ports(host, [ray_port], [dashboard_port], timeout)


def _probe_host_ports(host: str, ray_ports: Iterable[int], dashboard_ports: Iterable[int], timeout: float) -> DiscoveryCandidate | None:
    ray_port = next((port for port in ray_ports if _tcp_open(host, port, timeout)), None)
    if ray_port is None:
        return None
    dashboard_port = next((port for port in dashboard_ports if _tcp_open(host, port, timeout)), None)
    dashboard_open = dashboard_port is not None
    confidence = 95 if dashboard_open else 70
    detail = "Ray head and dashboard ports are reachable on the LAN" if dashboard_open else "Ray head port is reachable on the LAN"
    return DiscoveryCandidate(
        host=host,
        ray_port=ray_port,
        dashboard_port=dashboard_port,
        dashboard_url=f"http://{host}:{dashboard_port}" if dashboard_open else None,
        confidence=confidence,
        detail=detail,
    )


def _probe_host_legacy(host: str, ray_port: int, dashboard_port: int, timeout: float) -> DiscoveryCandidate | None:
    if not _tcp_open(host, ray_port, timeout):
        return None
    dashboard_open = _tcp_open(host, dashboard_port, timeout)
    confidence = 90 if dashboard_open else 65
    detail = "Ray head and dashboard ports are reachable" if dashboard_open else "Ray head port is reachable"
    return DiscoveryCandidate(
        host=host,
        ray_port=ray_port,
        dashboard_port=dashboard_port if dashboard_open else None,
        dashboard_url=f"http://{host}:{dashboard_port}" if dashboard_open else None,
        confidence=confidence,
        detail=detail,
    )


def _tcp_open(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _candidate_hosts(config: AppConfig | None = None) -> list[str]:
    hosts: set[str] = set()
    if config:
        configured = config.coordinator.head_host.strip()
        if configured and not is_loopback_host(configured):
            hosts.add(configured)
    hosts.update(_arp_neighbor_hosts())
    for addresses in psutil.net_if_addrs().values():
        for address in addresses:
            if address.family != socket.AF_INET or not address.address or not address.netmask:
                continue
            ip = ipaddress.ip_address(address.address)
            if ip.is_loopback or ip.is_link_local or not ip.is_private:
                continue
            try:
                network = ipaddress.ip_network(f"{address.address}/{address.netmask}", strict=False)
            except ValueError:
                continue
            if network.num_addresses > MAX_SCAN_HOSTS:
                network = ipaddress.ip_network(f"{address.address}/24", strict=False)
            for host in network.hosts():
                if host != ip:
                    hosts.add(str(host))
    return sorted(hosts)


def detect_lan_ip() -> str:
    for addresses in psutil.net_if_addrs().values():
        for address in addresses:
            if address.family != socket.AF_INET or not address.address:
                continue
            ip = ipaddress.ip_address(address.address)
            if ip.is_private and not ip.is_loopback and not ip.is_link_local:
                return str(ip)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            candidate = ipaddress.ip_address(sock.getsockname()[0])
            if candidate.is_private and not candidate.is_loopback and not candidate.is_link_local:
                return str(candidate)
    except OSError:
        pass
    return ""


def is_loopback_host(host: str) -> bool:
    value = host.strip().lower()
    if value in {"", "localhost"}:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def _ordered_ports(primary: int, defaults: Iterable[int]) -> list[int]:
    ports: list[int] = []
    for port in [primary, *defaults]:
        if 1 <= int(port) <= 65535 and int(port) not in ports:
            ports.append(int(port))
    return ports


def _arp_neighbor_hosts() -> set[str]:
    hosts: set[str] = set()
    try:
        result = subprocess.run(["arp", "-an"], check=False, capture_output=True, text=True, timeout=1)
    except Exception:
        return hosts
    for token in result.stdout.replace("(", " ").replace(")", " ").split():
        try:
            ip = ipaddress.ip_address(token)
        except ValueError:
            continue
        if ip.version == 4 and ip.is_private and not ip.is_loopback and not ip.is_link_local:
            hosts.add(str(ip))
    return hosts
