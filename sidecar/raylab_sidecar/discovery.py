from __future__ import annotations

import ipaddress
import math
import platform
import re
import shutil
import socket
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections.abc import Iterable
from pathlib import Path

import psutil

from .models import AppConfig, DiscoveryCandidate

COMMON_RAY_PORTS = (6379, 6380, 6381, 6382, 6383, 6384, 6385)
COMMON_DASHBOARD_PORTS = (8265, 8266, 8267, 8268, 8269, 8270)
MAX_SCAN_HOSTS = 2048
MAX_SCAN_WORKERS = 64


def discover_coordinators(config: AppConfig, timeout: float = 0.6) -> list[DiscoveryCandidate]:
    ray_ports = _ordered_ports(config.coordinator.ray_port, COMMON_RAY_PORTS)
    dashboard_ports = _ordered_ports(config.coordinator.dashboard_port, COMMON_DASHBOARD_PORTS)
    cli_user = _probe_user(config)
    candidates: dict[str, DiscoveryCandidate] = {}
    configured_host = config.coordinator.head_host.strip()
    if configured_host and not is_loopback_host(configured_host):
        configured = _probe_host_ports(configured_host, ray_ports, dashboard_ports, max(timeout, 1.0), allow_cli_fallback=True, cli_user=cli_user)
        if configured:
            configured.confidence = max(configured.confidence, 98)
            configured.detail = "Saved coordinator address is reachable"
            candidates[configured.host] = configured

    priority_hosts = _priority_hosts(config)
    if configured_host:
        priority_hosts = [host for host in priority_hosts if host != configured_host]
    _probe_hosts_concurrently(priority_hosts, ray_ports, dashboard_ports, max(timeout, 1.0), candidates, allow_cli_fallback=True, cli_user=cli_user)

    hosts = _candidate_hosts(config)
    already_probed = {configured_host, *priority_hosts, *candidates.keys()}
    hosts = [host for host in hosts if host not in already_probed]
    if not hosts:
        return _sorted_candidates(candidates.values())

    with ThreadPoolExecutor(max_workers=MAX_SCAN_WORKERS) as executor:
        futures = {executor.submit(_probe_host_ports, host, ray_ports, dashboard_ports, timeout): host for host in hosts}
        for future in as_completed(futures):
            candidate = future.result()
            if candidate:
                candidates[candidate.host] = candidate

    return _sorted_candidates(candidates.values())


def _probe_hosts_concurrently(
    hosts: Iterable[str],
    ray_ports: Iterable[int],
    dashboard_ports: Iterable[int],
    timeout: float,
    candidates: dict[str, DiscoveryCandidate],
    allow_cli_fallback: bool = False,
    cli_user: str | None = None,
) -> None:
    host_list = [host for host in hosts if host not in candidates]
    if not host_list:
        return
    with ThreadPoolExecutor(max_workers=min(MAX_SCAN_WORKERS, len(host_list))) as executor:
        futures = {
            executor.submit(_probe_host_ports, host, ray_ports, dashboard_ports, timeout, allow_cli_fallback, cli_user): host
            for host in host_list
        }
        for future in as_completed(futures):
            candidate = future.result()
            if candidate:
                candidates[candidate.host] = candidate


def discovery_debug(config: AppConfig, timeout: float = 1.0) -> dict[str, object]:
    configured_host = config.coordinator.head_host.strip()
    priority_hosts = _priority_hosts(config)
    hosts = []
    for host in [configured_host, *priority_hosts]:
        if host and host not in hosts:
            hosts.append(host)
    probes = []
    ray_ports = _ordered_ports(config.coordinator.ray_port, COMMON_RAY_PORTS)
    dashboard_ports = _ordered_ports(config.coordinator.dashboard_port, COMMON_DASHBOARD_PORTS)
    cli_user = _probe_user(config)
    for host in hosts[:16]:
        probes.append(
            {
                "host": host,
                "socket_ray": _tcp_open(host, config.coordinator.ray_port, timeout, allow_cli_fallback=False),
                "cli_ray": _tcp_open_with_nc(host, config.coordinator.ray_port, timeout),
                "worker_cli_ray": _tcp_open_with_nc(host, config.coordinator.ray_port, timeout, cli_user),
                "socket_dashboard": _tcp_open(host, config.coordinator.dashboard_port, timeout, allow_cli_fallback=False),
                "cli_dashboard": _tcp_open_with_nc(host, config.coordinator.dashboard_port, timeout),
                "worker_cli_dashboard": _tcp_open_with_nc(host, config.coordinator.dashboard_port, timeout, cli_user),
                "candidate": (_probe_host_ports(host, ray_ports, dashboard_ports, timeout, allow_cli_fallback=True, cli_user=cli_user) or None),
            }
        )
    return {
        "platform": platform.system(),
        "path": _command_path("sh", ["/bin/sh"]),
        "nc_path": _command_path("nc", ["/usr/bin/nc", "/bin/nc"]),
        "arp_path": _command_path("arp", ["/usr/sbin/arp", "/usr/bin/arp", "/sbin/arp"]),
        "configured_host": configured_host,
        "worker_probe_user": cli_user,
        "arp_hosts": sorted(_arp_neighbor_hosts()),
        "priority_hosts": priority_hosts,
        "probes": probes,
    }


def _sorted_candidates(candidates: Iterable[DiscoveryCandidate]) -> list[DiscoveryCandidate]:
    return sorted(candidates, key=lambda item: (-item.confidence, item.host))[:24]


def _probe_host(host: str, ray_port: int, dashboard_port: int, timeout: float) -> DiscoveryCandidate | None:
    return _probe_host_ports(host, [ray_port], [dashboard_port], timeout)


def _probe_host_ports(
    host: str,
    ray_ports: Iterable[int],
    dashboard_ports: Iterable[int],
    timeout: float,
    allow_cli_fallback: bool = False,
    cli_user: str | None = None,
) -> DiscoveryCandidate | None:
    ray_port = next((port for port in ray_ports if _tcp_open(host, port, timeout, allow_cli_fallback, cli_user)), None)
    if ray_port is None:
        return None
    dashboard_port = next((port for port in dashboard_ports if _tcp_open(host, port, timeout, allow_cli_fallback, cli_user)), None)
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


def _tcp_open(host: str, port: int, timeout: float, allow_cli_fallback: bool = False, cli_user: str | None = None) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        if allow_cli_fallback:
            return _tcp_open_with_nc(host, port, timeout, cli_user)
        return False


def _tcp_open_with_nc(host: str, port: int, timeout: float, cli_user: str | None = None) -> bool:
    nc_path = _command_path("nc", ["/usr/bin/nc", "/bin/nc"])
    if platform.system() != "Darwin" or not nc_path:
        return False
    args = [nc_path, "-z", "-G", str(max(1, math.ceil(timeout))), host, str(port)]
    try:
        result = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=max(2, math.ceil(timeout) + 1),
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    if result and result.returncode == 0:
        return True
    if not cli_user or not _valid_local_user(cli_user) or not shutil.which("sudo"):
        return False
    try:
        worker_result = subprocess.run(
            ["sudo", "-n", "-u", cli_user, "--", *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=max(2, math.ceil(timeout) + 1),
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return worker_result.returncode == 0


def _probe_user(config: AppConfig) -> str | None:
    worker_account = config.privacy.worker_account.strip()
    return worker_account if _valid_local_user(worker_account) else None


def _valid_local_user(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}", value))


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
    return _sort_hosts(hosts)


def _priority_hosts(config: AppConfig | None = None) -> list[str]:
    hosts = set(_arp_neighbor_hosts())
    if config:
        configured = config.coordinator.head_host.strip()
        if configured and not is_loopback_host(configured):
            hosts.add(configured)
    return _sort_hosts(hosts)


def _sort_hosts(hosts: Iterable[str]) -> list[str]:
    def key(host: str) -> tuple[int, int | str]:
        try:
            return (0, int(ipaddress.ip_address(host)))
        except ValueError:
            return (1, host)

    return sorted(set(hosts), key=key)


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
    arp_path = _command_path("arp", ["/usr/sbin/arp", "/usr/bin/arp", "/sbin/arp"])
    if not arp_path:
        return hosts
    try:
        result = subprocess.run([arp_path, "-an"], check=False, capture_output=True, text=True, timeout=1)
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


def _command_path(name: str, fallbacks: Iterable[str]) -> str | None:
    path = shutil.which(name)
    if path:
        return path
    for fallback in fallbacks:
        if shutil.which(fallback) or Path(fallback).exists():
            return fallback
    return None
