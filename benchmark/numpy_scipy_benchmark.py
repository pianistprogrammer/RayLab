#!/usr/bin/env python3
"""RayLab NumPy/SciPy benchmark.

Runs deterministic numerical linear algebra tasks across alive Ray nodes. Each
task performs dense NumPy matrix multiplication and a SciPy Cholesky solve.
"""

from __future__ import annotations

import argparse
import os
import socket
import time
from collections import defaultdict
from dataclasses import dataclass

os.environ.setdefault("RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

import ray
from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy


@dataclass(frozen=True)
class ClusterNode:
    node_id: str
    address: str
    hostname: str
    cpus: int


@ray.remote(num_cpus=1)
def linear_algebra_task(task_id: int, matrix_size: int) -> dict[str, object]:
    import platform

    import numpy as np
    import scipy
    import scipy.linalg

    started = time.perf_counter()
    rng = np.random.default_rng(10_000 + task_id)

    a = rng.standard_normal((matrix_size, matrix_size), dtype=np.float64)
    b = rng.standard_normal((matrix_size, matrix_size), dtype=np.float64)
    product = a @ b

    # Build a symmetric positive definite system and solve it with SciPy.
    rhs = rng.standard_normal(matrix_size, dtype=np.float64)
    spd = (a.T @ a) + (matrix_size * np.eye(matrix_size, dtype=np.float64))
    factor = scipy.linalg.cho_factor(spd, lower=True, check_finite=False)
    solution = scipy.linalg.cho_solve(factor, rhs, check_finite=False)
    residual = np.linalg.norm(spd @ solution - rhs) / max(np.linalg.norm(rhs), 1e-12)

    checksum = float(np.sum(product[:8, :8]) + np.sum(solution[:32]))
    elapsed = time.perf_counter() - started

    return {
        "task_id": task_id,
        "host": socket.gethostname(),
        "platform": platform.system(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "seconds": elapsed,
        "residual": float(residual),
        "checksum": checksum,
        "gflop_estimate": estimated_gflops(matrix_size),
    }


def estimated_gflops(matrix_size: int) -> float:
    # Rough operation count: one dense matmul plus one SPD construction/Cholesky
    # and solve. Good enough for relative throughput, not a formal LINPACK score.
    n = float(matrix_size)
    operations = (2 * n**3) + (n**3) + (n**3 / 3) + (2 * n**2)
    return operations / 1e9


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark NumPy/SciPy workloads across a RayLab cluster.")
    parser.add_argument("--address", default="auto", help="Ray address. Use 'auto' inside a Ray job.")
    parser.add_argument("--max-nodes", type=int, default=8, help="Maximum alive nodes to include.")
    parser.add_argument("--tasks", type=int, default=48, help="Number of numeric tasks per benchmark run.")
    parser.add_argument("--matrix-size", type=int, default=600, help="Square matrix size for each task.")
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


def run_once(nodes: list[ClusterNode], tasks: int, matrix_size: int) -> dict[str, object]:
    refs = []
    started = time.perf_counter()
    for task_id in range(tasks):
        node = nodes[task_id % len(nodes)]
        strategy = NodeAffinitySchedulingStrategy(node_id=node.node_id, soft=False)
        refs.append(linear_algebra_task.options(scheduling_strategy=strategy).remote(task_id, matrix_size))
    results = ray.get(refs)
    elapsed = time.perf_counter() - started

    by_host: dict[str, dict[str, object]] = defaultdict(lambda: {"tasks": 0, "task_seconds": 0.0, "gflops": 0.0, "platforms": set()})
    checksum = 0.0
    max_residual = 0.0
    for result in results:
        host = str(result["host"])
        by_host[host]["tasks"] += 1
        by_host[host]["task_seconds"] += float(result["seconds"])
        by_host[host]["gflops"] += float(result["gflop_estimate"])
        by_host[host]["platforms"].add(str(result["platform"]))
        checksum += float(result["checksum"])
        max_residual = max(max_residual, float(result["residual"]))

    total_gflops = sum(float(result["gflop_estimate"]) for result in results)
    versions = sorted({f"numpy {r['numpy']} / scipy {r['scipy']}" for r in results})
    return {
        "nodes": len(nodes),
        "elapsed": elapsed,
        "tasks": tasks,
        "matrix_size": matrix_size,
        "tasks_per_second": tasks / elapsed,
        "gflops_per_second": total_gflops / elapsed,
        "checksum": checksum,
        "max_residual": max_residual,
        "by_host": by_host,
        "versions": versions,
    }


def main() -> None:
    args = parse_args()
    ray.init(address=args.address)
    nodes = alive_cpu_nodes()
    if not nodes:
        raise SystemExit("No alive Ray CPU nodes found. Start RayLab on the coordinator and workers first.")
    nodes = nodes[: max(1, min(args.max_nodes, len(nodes)))]

    print("RayLab NumPy/SciPy benchmark")
    print(f"Task: NumPy matrix multiply + SciPy Cholesky solve")
    print(f"Workload: {args.tasks} tasks, matrix size {args.matrix_size}x{args.matrix_size}")
    print(f"Connected resources: {ray.cluster_resources()}")
    print("Alive nodes selected:")
    for index, node in enumerate(nodes, start=1):
        print(f"  {index}. {node.address}  host={node.hostname}  cpus={node.cpus}  id={node.node_id[:10]}")

    print("\nBenchmark: same numeric workload, increasing node count")
    print("Nodes  Seconds  Tasks/s  Est GFLOP/s  Speedup  Max residual")
    print("-----  -------  -------  -----------  -------  ------------")
    runs = []
    for count in range(1, len(nodes) + 1):
        run = run_once(nodes[:count], args.tasks, args.matrix_size)
        runs.append(run)
        speedup = runs[0]["elapsed"] / run["elapsed"]
        print(
            f"{run['nodes']:>5}  {run['elapsed']:>7.2f}  {run['tasks_per_second']:>7.2f}  "
            f"{run['gflops_per_second']:>11.2f}  {speedup:>7.2f}  {run['max_residual']:.2e}"
        )

    largest = runs[-1]
    print("\nPer-host work in the largest run:")
    for host, summary in sorted(largest["by_host"].items()):
        platforms = ",".join(sorted(summary["platforms"]))
        print(
            f"  {host:<24} tasks={summary['tasks']:>3}  "
            f"task_seconds={summary['task_seconds']:>8.2f}  est_gflop={summary['gflops']:>7.2f}  platform={platforms}"
        )

    print("\nNumeric validation:")
    print(f"  checksum={largest['checksum']:.6f}")
    print(f"  max_residual={largest['max_residual']:.2e}")
    print("  versions:")
    for version in largest["versions"]:
        print(f"    {version}")

    ray.shutdown()


if __name__ == "__main__":
    main()
