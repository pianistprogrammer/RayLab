#!/usr/bin/env python3
"""Small RayLab cluster benchmark.

Run this from a machine that has joined the Ray cluster, or run it on the
coordinator. It compares the same CPU workload using 1, 2, then 3 Ray nodes.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import socket
import statistics
import time
from dataclasses import dataclass

# Ray blocks multi-node clusters on macOS unless this is set. RayLab starts Ray
# with the same flag, and the benchmark driver needs it too when run on macOS.
os.environ.setdefault("RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER", "1")

import ray
from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy


@dataclass(frozen=True)
class RayNode:
    node_id: str
    address: str
    cpus: int
    name: str


@ray.remote
class CpuWorker:
    def identity(self) -> dict[str, str]:
        return {
            "host": socket.gethostname(),
            "platform": platform.platform(),
        }

    def burn(self, task_id: int, iterations: int) -> tuple[int, str]:
        payload = f"raylab:{socket.gethostname()}:{task_id}".encode()
        digest = payload
        for i in range(iterations):
            digest = hashlib.blake2b(digest + i.to_bytes(4, "little", signed=False), digest_size=32).digest()
        return task_id, digest.hex()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark a RayLab cluster across 1, 2, and 3 nodes.")
    parser.add_argument(
        "--address",
        default="auto",
        help="Ray address. Use 'auto' from a joined node/coordinator, or ray://HOST:10001 from outside the cluster.",
    )
    parser.add_argument("--max-nodes", type=int, default=3, help="Largest node count to test.")
    parser.add_argument("--workers-per-node", type=int, default=2, help="Parallel Ray actors to place on each selected node.")
    parser.add_argument("--tasks", type=int, default=36, help="Total fixed work chunks per benchmark run.")
    parser.add_argument("--iterations", type=int, default=250_000, help="CPU loop iterations per work chunk.")
    parser.add_argument("--warmup", action="store_true", help="Run a small warmup before timing.")
    return parser.parse_args()


def alive_nodes() -> list[RayNode]:
    nodes: list[RayNode] = []
    for item in ray.nodes():
        if not item.get("Alive"):
            continue
        resources = item.get("Resources") or {}
        cpus = int(resources.get("CPU", 0))
        if cpus <= 0:
            continue
        address = item.get("NodeManagerAddress") or item.get("NodeManagerHostname") or "unknown"
        name = item.get("NodeManagerHostname") or address
        nodes.append(RayNode(node_id=item["NodeID"], address=address, cpus=cpus, name=name))
    return sorted(nodes, key=lambda node: node.address)


def make_worker(node: RayNode) -> ray.actor.ActorHandle:
    return CpuWorker.options(
        num_cpus=1,
        scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=node.node_id, soft=False),
    ).remote()


def benchmark(nodes: list[RayNode], workers_per_node: int, tasks: int, iterations: int) -> dict[str, object]:
    workers = [make_worker(node) for node in nodes for _ in range(max(1, min(workers_per_node, node.cpus)))]
    identities = ray.get([worker.identity.remote() for worker in workers])

    start = time.perf_counter()
    refs = [workers[i % len(workers)].burn.remote(i, iterations) for i in range(tasks)]
    ray.get(refs)
    elapsed = time.perf_counter() - start

    hosts = sorted({identity["host"] for identity in identities})
    return {
        "nodes": len(nodes),
        "actors": len(workers),
        "hosts": hosts,
        "elapsed": elapsed,
        "tasks_per_second": tasks / elapsed,
    }


def main() -> None:
    args = parse_args()
    ray.init(address=args.address)

    nodes = alive_nodes()
    if not nodes:
        raise SystemExit("No alive Ray nodes with CPU resources were found.")

    limit = min(args.max_nodes, len(nodes))
    print(f"Connected to Ray cluster: {ray.cluster_resources()}")
    print("Alive nodes:")
    for index, node in enumerate(nodes, start=1):
        print(f"  {index}. {node.address}  cpus={node.cpus}  id={node.node_id[:10]}")

    if args.warmup:
        print("\nWarmup...")
        benchmark(nodes[:1], workers_per_node=1, tasks=min(4, args.tasks), iterations=max(1, args.iterations // 10))

    print("\nBenchmark: fixed total work, increasing node count")
    print(f"Workload: {args.tasks} tasks x {args.iterations:,} iterations")
    print("\nNodes  Actors  Seconds   Tasks/s  Speedup  Hosts")
    print("-----  ------  -------  --------  -------  -----")

    results = []
    for count in range(1, limit + 1):
        result = benchmark(nodes[:count], args.workers_per_node, args.tasks, args.iterations)
        results.append(result)
        baseline = results[0]["elapsed"]
        speedup = baseline / result["elapsed"]
        print(
            f"{result['nodes']:>5}  {result['actors']:>6}  {result['elapsed']:>7.2f}  "
            f"{result['tasks_per_second']:>8.2f}  {speedup:>7.2f}  {', '.join(result['hosts'])}"
        )

    elapsed_values = [float(result["elapsed"]) for result in results]
    if len(elapsed_values) > 1:
        print(f"\nBest time: {min(elapsed_values):.2f}s; median time: {statistics.median(elapsed_values):.2f}s")

    ray.shutdown()


if __name__ == "__main__":
    main()
