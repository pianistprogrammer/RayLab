#!/usr/bin/env python3
"""RayLab compute smoke test and benchmark.

This script connects to an already-running Ray cluster, counts primes up to a
fixed limit, and repeats the same workload with 1..N alive nodes. It pins tasks
to specific Ray nodes so the output shows which machines did work.
"""

from __future__ import annotations

import argparse
import math
import os
import platform
import socket
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

# Required by Ray when macOS or Windows machines participate in a cluster.
os.environ.setdefault("RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER", "1")

import ray
from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy


@dataclass(frozen=True)
class ClusterNode:
    node_id: str
    address: str
    hostname: str
    cpus: int


@ray.remote(num_cpus=1)
def count_primes(start: int, stop: int) -> dict[str, object]:
    begin = time.perf_counter()
    total = 0
    checksum = 0
    for value in range(max(2, start), stop):
        if is_prime(value):
            total += 1
            checksum = (checksum + value) % 1_000_000_007
    return {
        "host": socket.gethostname(),
        "platform": platform.system(),
        "range": [start, stop],
        "primes": total,
        "checksum": checksum,
        "seconds": time.perf_counter() - begin,
    }


def is_prime(value: int) -> bool:
    if value < 2:
        return False
    if value == 2:
        return True
    if value % 2 == 0:
        return False
    limit = math.isqrt(value)
    for divisor in range(3, limit + 1, 2):
        if value % divisor == 0:
            return False
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a deterministic compute benchmark on a RayLab cluster.")
    parser.add_argument("--address", default="auto", help="Ray address, usually 'auto' from the coordinator or a joined node.")
    parser.add_argument("--limit", type=int, default=350_000, help="Count primes below this number.")
    parser.add_argument("--chunks", type=int, default=64, help="Number of work chunks per benchmark run.")
    parser.add_argument("--max-nodes", type=int, default=8, help="Maximum number of alive nodes to include.")
    parser.add_argument("--quick", action="store_true", help="Use a smaller workload for a fast smoke test.")
    return parser.parse_args()


def alive_cpu_nodes() -> list[ClusterNode]:
    nodes: list[ClusterNode] = []
    for item in ray.nodes():
        if not item.get("Alive"):
            continue
        resources = item.get("Resources") or {}
        cpus = int(resources.get("CPU", 0))
        if cpus < 1:
            continue
        address = item.get("NodeManagerAddress") or item.get("NodeManagerHostname") or "unknown"
        hostname = item.get("NodeManagerHostname") or address
        nodes.append(ClusterNode(item["NodeID"], address, hostname, cpus))
    return sorted(nodes, key=lambda node: (node.address, node.hostname))


def ranges_for(limit: int, chunks: int) -> list[tuple[int, int]]:
    chunks = max(1, chunks)
    width = max(1, math.ceil((limit - 2) / chunks))
    ranges = []
    start = 2
    while start < limit:
        stop = min(limit, start + width)
        ranges.append((start, stop))
        start = stop
    return ranges


def run_once(nodes: list[ClusterNode], ranges: Iterable[tuple[int, int]]) -> dict[str, object]:
    refs = []
    start_time = time.perf_counter()
    selected_ranges = list(ranges)
    for index, (start, stop) in enumerate(selected_ranges):
        node = nodes[index % len(nodes)]
        strategy = NodeAffinitySchedulingStrategy(node_id=node.node_id, soft=False)
        refs.append(count_primes.options(scheduling_strategy=strategy).remote(start, stop))

    results = ray.get(refs)
    elapsed = time.perf_counter() - start_time
    by_host: dict[str, dict[str, object]] = defaultdict(lambda: {"chunks": 0, "primes": 0, "task_seconds": 0.0, "platforms": set()})
    total_primes = 0
    checksum = 0
    for result in results:
        host = str(result["host"])
        by_host[host]["chunks"] += 1
        by_host[host]["primes"] += int(result["primes"])
        by_host[host]["task_seconds"] += float(result["seconds"])
        by_host[host]["platforms"].add(str(result["platform"]))
        total_primes += int(result["primes"])
        checksum = (checksum + int(result["checksum"])) % 1_000_000_007

    return {
        "nodes": len(nodes),
        "elapsed": elapsed,
        "chunks": len(selected_ranges),
        "primes": total_primes,
        "checksum": checksum,
        "chunks_per_second": len(selected_ranges) / elapsed,
        "by_host": by_host,
    }


def main() -> None:
    args = parse_args()
    if args.quick:
        args.limit = min(args.limit, 120_000)
        args.chunks = min(args.chunks, 24)

    ray.init(address=args.address)
    nodes = alive_cpu_nodes()
    if not nodes:
        raise SystemExit("No alive Ray CPU nodes found. Start RayLab on the coordinator and workers first.")

    nodes = nodes[: max(1, min(args.max_nodes, len(nodes)))]
    work_ranges = ranges_for(args.limit, args.chunks)

    print("RayLab compute test")
    print(f"Connected resources: {ray.cluster_resources()}")
    print(f"Workload: count primes below {args.limit:,} split into {len(work_ranges)} chunks")
    print("Alive nodes selected:")
    for index, node in enumerate(nodes, start=1):
        print(f"  {index}. {node.address}  host={node.hostname}  cpus={node.cpus}  id={node.node_id[:10]}")

    print("\nBenchmark: same computation, increasing node count")
    print("Nodes  Seconds  Chunks/s  Speedup  Prime result  Checksum")
    print("-----  -------  --------  -------  ------------  --------")

    runs = []
    for count in range(1, len(nodes) + 1):
        run = run_once(nodes[:count], work_ranges)
        runs.append(run)
        speedup = runs[0]["elapsed"] / run["elapsed"]
        print(
            f"{run['nodes']:>5}  {run['elapsed']:>7.2f}  {run['chunks_per_second']:>8.2f}  "
            f"{speedup:>7.2f}  {run['primes']:>12}  {run['checksum']:>8}"
        )

    print("\nPer-host work in the largest run:")
    largest = runs[-1]
    for host, summary in sorted(largest["by_host"].items()):
        platforms = ",".join(sorted(summary["platforms"]))
        print(
            f"  {host:<24} chunks={summary['chunks']:>3}  primes={summary['primes']:>8}  "
            f"task_seconds={summary['task_seconds']:>7.2f}  platform={platforms}"
        )

    elapsed_values = [float(run["elapsed"]) for run in runs]
    print(f"\nBest wall time: {min(elapsed_values):.2f}s; median wall time: {statistics.median(elapsed_values):.2f}s")
    print("Success: the prime result/checksum should stay identical for every node count.")
    ray.shutdown()


if __name__ == "__main__":
    main()
