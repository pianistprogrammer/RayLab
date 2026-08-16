#!/usr/bin/env python3
"""RayLab Monte Carlo benchmark.

Prices a European call option with an embarrassingly parallel Monte Carlo
simulation. Each Ray task simulates an independent chunk of paths, and the
driver repeats the same total work with 1..N alive nodes.
"""

from __future__ import annotations

import argparse
import math
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
def monte_carlo_chunk(task_id: int, paths: int, s0: float, strike: float, rate: float, sigma: float, maturity: float) -> dict[str, object]:
    import platform

    import numpy as np

    started = time.perf_counter()
    rng = np.random.default_rng(123_456_789 + task_id)
    z = rng.standard_normal(paths, dtype=np.float64)
    drift = (rate - 0.5 * sigma * sigma) * maturity
    diffusion = sigma * math.sqrt(maturity) * z
    terminal = s0 * np.exp(drift + diffusion)
    payoff = np.maximum(terminal - strike, 0.0)
    discounted = math.exp(-rate * maturity) * payoff
    elapsed = time.perf_counter() - started

    return {
        "task_id": task_id,
        "host": socket.gethostname(),
        "platform": platform.system(),
        "paths": paths,
        "sum": float(np.sum(discounted)),
        "sumsq": float(np.sum(discounted * discounted)),
        "seconds": elapsed,
        "numpy": np.__version__,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark Monte Carlo option pricing across a RayLab cluster.")
    parser.add_argument("--address", default="auto", help="Ray address. Use 'auto' inside a Ray job.")
    parser.add_argument("--max-nodes", type=int, default=8, help="Maximum alive nodes to include.")
    parser.add_argument("--tasks", type=int, default=96, help="Number of simulation chunks per benchmark run.")
    parser.add_argument("--paths-per-task", type=int, default=1_000_000, help="Monte Carlo paths per Ray task.")
    parser.add_argument("--s0", type=float, default=100.0, help="Initial asset price.")
    parser.add_argument("--strike", type=float, default=105.0, help="Option strike price.")
    parser.add_argument("--rate", type=float, default=0.04, help="Risk-free rate.")
    parser.add_argument("--sigma", type=float, default=0.30, help="Annual volatility.")
    parser.add_argument("--maturity", type=float, default=1.0, help="Maturity in years.")
    parser.add_argument("--warmup", action="store_true", help="Run a small warmup before timing.")
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


def black_scholes_call(s0: float, strike: float, rate: float, sigma: float, maturity: float) -> float:
    d1 = (math.log(s0 / strike) + (rate + 0.5 * sigma * sigma) * maturity) / (sigma * math.sqrt(maturity))
    d2 = d1 - sigma * math.sqrt(maturity)
    normal_cdf = lambda x: 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))
    return s0 * normal_cdf(d1) - strike * math.exp(-rate * maturity) * normal_cdf(d2)


def run_once(nodes: list[ClusterNode], args: argparse.Namespace) -> dict[str, object]:
    refs = []
    started = time.perf_counter()
    for task_id in range(args.tasks):
        node = nodes[task_id % len(nodes)]
        strategy = NodeAffinitySchedulingStrategy(node_id=node.node_id, soft=False)
        refs.append(
            monte_carlo_chunk.options(scheduling_strategy=strategy).remote(
                task_id,
                args.paths_per_task,
                args.s0,
                args.strike,
                args.rate,
                args.sigma,
                args.maturity,
            )
        )
    results = ray.get(refs)
    elapsed = time.perf_counter() - started

    by_host: dict[str, dict[str, object]] = defaultdict(lambda: {"tasks": 0, "paths": 0, "task_seconds": 0.0, "platforms": set()})
    total_paths = 0
    total_sum = 0.0
    total_sumsq = 0.0
    for result in results:
        host = str(result["host"])
        paths = int(result["paths"])
        by_host[host]["tasks"] += 1
        by_host[host]["paths"] += paths
        by_host[host]["task_seconds"] += float(result["seconds"])
        by_host[host]["platforms"].add(str(result["platform"]))
        total_paths += paths
        total_sum += float(result["sum"])
        total_sumsq += float(result["sumsq"])

    price = total_sum / total_paths
    variance = max(total_sumsq / total_paths - price * price, 0.0)
    standard_error = math.sqrt(variance / total_paths)
    versions = sorted({str(result["numpy"]) for result in results})
    return {
        "nodes": len(nodes),
        "elapsed": elapsed,
        "tasks": args.tasks,
        "paths": total_paths,
        "paths_per_second": total_paths / elapsed,
        "price": price,
        "standard_error": standard_error,
        "by_host": by_host,
        "numpy_versions": versions,
    }


def main() -> None:
    args = parse_args()
    ray.init(address=args.address)
    nodes = alive_cpu_nodes()
    if not nodes:
        raise SystemExit("No alive Ray CPU nodes found. Start RayLab on the coordinator and workers first.")
    nodes = nodes[: max(1, min(args.max_nodes, len(nodes)))]
    analytical = black_scholes_call(args.s0, args.strike, args.rate, args.sigma, args.maturity)

    print("RayLab Monte Carlo benchmark")
    print("Task: European call option pricing with independent Monte Carlo path chunks")
    print(f"Workload: {args.tasks} tasks x {args.paths_per_task:,} paths = {args.tasks * args.paths_per_task:,} total paths")
    print(f"Analytical Black-Scholes price: {analytical:.6f}")
    print(f"Connected resources: {ray.cluster_resources()}")
    print("Alive nodes selected:")
    for index, node in enumerate(nodes, start=1):
        print(f"  {index}. {node.address}  host={node.hostname}  cpus={node.cpus}  id={node.node_id[:10]}")

    if args.warmup:
        warm = argparse.Namespace(**{**vars(args), "tasks": min(6, args.tasks), "paths_per_task": min(50_000, args.paths_per_task)})
        run_once(nodes[:1], warm)

    print("\nBenchmark: same simulation, increasing node count")
    print("Nodes  Seconds  Paths/s       Speedup  MC price   Std error  Abs error")
    print("-----  -------  ------------  -------  ---------  ---------  ---------")
    runs = []
    for count in range(1, len(nodes) + 1):
        run = run_once(nodes[:count], args)
        runs.append(run)
        speedup = runs[0]["elapsed"] / run["elapsed"]
        abs_error = abs(float(run["price"]) - analytical)
        print(
            f"{run['nodes']:>5}  {run['elapsed']:>7.2f}  {run['paths_per_second']:>12,.0f}  "
            f"{speedup:>7.2f}  {run['price']:>9.5f}  {run['standard_error']:>9.6f}  {abs_error:>9.6f}"
        )

    largest = runs[-1]
    print("\nPer-host work in the largest run:")
    for host, summary in sorted(largest["by_host"].items()):
        platforms = ",".join(sorted(summary["platforms"]))
        print(
            f"  {host:<24} tasks={summary['tasks']:>3}  paths={summary['paths']:>12,}  "
            f"task_seconds={summary['task_seconds']:>8.2f}  platform={platforms}"
        )

    print("\nValidation:")
    print(f"  analytical_price={analytical:.6f}")
    print(f"  monte_carlo_price={largest['price']:.6f}")
    print(f"  standard_error={largest['standard_error']:.6f}")
    print(f"  numpy_versions={', '.join(largest['numpy_versions'])}")
    ray.shutdown()


if __name__ == "__main__":
    main()
