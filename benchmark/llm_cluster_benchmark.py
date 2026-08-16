#!/usr/bin/env python3
"""RayLab LLM inference benchmark.

Runs a batch of prompts across the alive Ray nodes. For a real LLM run, install
`llama-cpp-python` in the RayLab runtime on each worker and provide a GGUF model
with --model or --model-url. Use --backend dry-run first to verify scheduling.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import socket
import sys
import time
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

os.environ.setdefault("RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER", "1")

import ray
from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy


DEFAULT_PROMPTS = [
    "Summarize the benefit of pooling idle lab computers for AI workloads.",
    "Write a short explanation of distributed batch inference for a non-technical buyer.",
    "Extract three risks from running compute jobs across mixed operating systems.",
    "Draft a two-sentence pitch for RayLab to a university research lab.",
    "Classify this support ticket as networking, runtime, hardware, or user setup: worker disappears after joining cluster.",
    "Generate a JSON object with fields product, workload, and outcome for a cluster benchmark.",
    "Explain why many small LLM requests can be distributed across several machines.",
    "Create a concise headline for a chart showing 2.31x faster runtime with two nodes.",
]


@dataclass(frozen=True)
class ClusterNode:
    node_id: str
    address: str
    hostname: str
    cpus: int


@ray.remote(num_cpus=1)
class LlmWorker:
    def __init__(self, backend: str, model: str | None, model_url: str | None, model_cache_dir: str | None, max_tokens: int, temperature: float, n_ctx: int, n_threads: int, n_gpu_layers: int):
        self.backend = backend
        self.host = socket.gethostname()
        self.platform = platform.system()
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.model_path = None
        self.load_seconds = 0.0
        self.llm = None

        started = time.perf_counter()
        if backend == "llama-cpp":
            self.model_path = ensure_model(model, model_url, model_cache_dir)
            try:
                from llama_cpp import Llama
            except Exception as exc:
                raise RuntimeError(
                    "llama-cpp-python is not installed in this node's RayLab runtime. "
                    "Install it on every participating node, or run with --backend dry-run first."
                ) from exc
            self.llm = Llama(
                model_path=self.model_path,
                n_ctx=n_ctx,
                n_threads=n_threads,
                n_gpu_layers=n_gpu_layers,
                verbose=False,
            )
        elif backend != "dry-run":
            raise ValueError(f"Unsupported backend: {backend}")
        self.load_seconds = time.perf_counter() - started

    def identity(self) -> dict[str, object]:
        return {
            "host": self.host,
            "platform": self.platform,
            "backend": self.backend,
            "model_path": self.model_path,
            "load_seconds": self.load_seconds,
        }

    def generate(self, request_id: int, prompt: str) -> dict[str, object]:
        started = time.perf_counter()
        if self.backend == "dry-run":
            text = dry_run_completion(prompt, self.host, request_id, self.max_tokens)
            output_tokens = count_tokens(text)
        else:
            result = self.llm(
                prompt,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                echo=False,
            )
            text = str(result["choices"][0].get("text", "")).strip()
            usage = result.get("usage") or {}
            output_tokens = int(usage.get("completion_tokens") or count_tokens(text))

        return {
            "request_id": request_id,
            "host": self.host,
            "platform": self.platform,
            "seconds": time.perf_counter() - started,
            "output_tokens": output_tokens,
            "prompt": prompt,
            "text": text,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark LLM batch inference across a RayLab cluster.")
    parser.add_argument("--address", default="auto", help="Ray address. Use 'auto' inside a Ray job.")
    parser.add_argument("--backend", choices=["llama-cpp", "dry-run"], default="llama-cpp", help="Inference backend.")
    parser.add_argument("--model", help="Path to a GGUF model available on each node.")
    parser.add_argument("--model-url", help="Download a GGUF model to each node cache if --model is not provided.")
    parser.add_argument("--model-cache-dir", help="Directory used for downloaded models on each node.")
    parser.add_argument("--requests", type=int, default=32, help="Total prompt requests per benchmark run.")
    parser.add_argument("--max-nodes", type=int, default=8, help="Maximum alive nodes to include.")
    parser.add_argument("--workers-per-node", type=int, default=1, help="LLM actors to start on each selected node.")
    parser.add_argument("--max-tokens", type=int, default=64, help="Maximum generated tokens per prompt.")
    parser.add_argument("--temperature", type=float, default=0.2, help="Sampling temperature for llama-cpp.")
    parser.add_argument("--n-ctx", type=int, default=2048, help="llama.cpp context size.")
    parser.add_argument("--n-threads", type=int, default=0, help="llama.cpp CPU threads per actor. 0 lets llama.cpp decide.")
    parser.add_argument("--n-gpu-layers", type=int, default=0, help="llama.cpp GPU layers. Use 0 for CPU-only portability.")
    parser.add_argument("--prompts-file", help="Optional text file with one prompt per line.")
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


def ensure_model(model: str | None, model_url: str | None, model_cache_dir: str | None) -> str:
    if model:
        path = Path(model).expanduser()
        if path.exists():
            return str(path)
        raise FileNotFoundError(f"Model file not found on {socket.gethostname()}: {path}")

    if not model_url:
        raise ValueError("Real LLM mode needs --model or --model-url. Use --backend dry-run to test scheduling only.")

    cache_dir = Path(model_cache_dir or default_model_cache_dir()).expanduser()
    cache_dir.mkdir(parents=True, exist_ok=True)
    filename = model_url.rstrip("/").split("/")[-1] or "model.gguf"
    target = cache_dir / filename
    if target.exists() and target.stat().st_size > 0:
        return str(target)

    print(f"[{socket.gethostname()}] downloading model to {target}", flush=True)
    urllib.request.urlretrieve(model_url, target)
    return str(target)


def default_model_cache_dir() -> str:
    if sys.platform == "darwin":
        return "/Users/Shared/RayLab/models/llm"
    if sys.platform == "win32":
        root = os.environ.get("APPDATA") or str(Path.home())
        return str(Path(root) / "raylab-cluster-manager" / "models" / "llm")
    return str(Path.home() / ".cache" / "raylab" / "models" / "llm")


def dry_run_completion(prompt: str, host: str, request_id: int, max_tokens: int) -> str:
    digest = hashlib.sha256(f"{host}:{request_id}:{prompt}".encode()).hexdigest()
    words = ["analysis", "summary", "cluster", "node", "throughput", "prompt", "result", "raylab"]
    pieces = [words[int(digest[i:i + 2], 16) % len(words)] for i in range(0, min(len(digest), max_tokens * 2), 2)]
    return " ".join(pieces[:max_tokens])


def count_tokens(text: str) -> int:
    return max(1, len(text.split())) if text else 0


def load_prompts(prompts_file: str | None, requests: int) -> list[str]:
    prompts = DEFAULT_PROMPTS
    if prompts_file:
        lines = [line.strip() for line in Path(prompts_file).read_text(encoding="utf-8").splitlines()]
        prompts = [line for line in lines if line and not line.startswith("#")]
    if not prompts:
        raise ValueError("No prompts available")
    return [prompts[i % len(prompts)] for i in range(requests)]


def make_workers(nodes: list[ClusterNode], args: argparse.Namespace) -> list[ray.actor.ActorHandle]:
    workers = []
    for node in nodes:
        count = max(1, min(args.workers_per_node, node.cpus))
        for _ in range(count):
            strategy = NodeAffinitySchedulingStrategy(node_id=node.node_id, soft=False)
            workers.append(
                LlmWorker.options(scheduling_strategy=strategy).remote(
                    args.backend,
                    args.model,
                    args.model_url,
                    args.model_cache_dir,
                    args.max_tokens,
                    args.temperature,
                    args.n_ctx,
                    args.n_threads,
                    args.n_gpu_layers,
                )
            )
    return workers


def benchmark(nodes: list[ClusterNode], prompts: Iterable[str], args: argparse.Namespace) -> dict[str, object]:
    workers = make_workers(nodes, args)
    identities = ray.get([worker.identity.remote() for worker in workers])

    selected_prompts = list(prompts)
    started = time.perf_counter()
    refs = [workers[index % len(workers)].generate.remote(index, prompt) for index, prompt in enumerate(selected_prompts)]
    results = ray.get(refs)
    elapsed = time.perf_counter() - started

    by_host: dict[str, dict[str, object]] = defaultdict(lambda: {"requests": 0, "tokens": 0, "task_seconds": 0.0, "platforms": set()})
    for result in results:
        host = str(result["host"])
        by_host[host]["requests"] += 1
        by_host[host]["tokens"] += int(result["output_tokens"])
        by_host[host]["task_seconds"] += float(result["seconds"])
        by_host[host]["platforms"].add(str(result["platform"]))

    total_tokens = sum(int(result["output_tokens"]) for result in results)
    return {
        "nodes": len(nodes),
        "actors": len(workers),
        "identities": identities,
        "elapsed": elapsed,
        "requests": len(selected_prompts),
        "tokens": total_tokens,
        "requests_per_second": len(selected_prompts) / elapsed,
        "tokens_per_second": total_tokens / elapsed,
        "by_host": by_host,
        "samples": sorted(results, key=lambda item: int(item["request_id"]))[:3],
    }


def main() -> None:
    args = parse_args()
    ray.init(address=args.address)
    nodes = alive_cpu_nodes()
    if not nodes:
        raise SystemExit("No alive Ray CPU nodes found. Start RayLab on the coordinator and workers first.")
    nodes = nodes[: max(1, min(args.max_nodes, len(nodes)))]
    prompts = load_prompts(args.prompts_file, args.requests)

    print("RayLab LLM cluster benchmark")
    print(f"Backend: {args.backend}")
    if args.backend == "llama-cpp":
        print(f"Model: {args.model or args.model_url}")
    print(f"Requests: {len(prompts)}  max_tokens/request: {args.max_tokens}")
    print(f"Connected resources: {ray.cluster_resources()}")
    print("Alive nodes selected:")
    for index, node in enumerate(nodes, start=1):
        print(f"  {index}. {node.address}  host={node.hostname}  cpus={node.cpus}  id={node.node_id[:10]}")

    print("\nBenchmark: same prompt batch, increasing node count")
    print("Nodes  Actors  Seconds  Req/s  Tok/s  Speedup")
    print("-----  ------  -------  -----  -----  -------")
    runs = []
    for count in range(1, len(nodes) + 1):
        run = benchmark(nodes[:count], prompts, args)
        runs.append(run)
        speedup = runs[0]["elapsed"] / run["elapsed"]
        print(
            f"{run['nodes']:>5}  {run['actors']:>6}  {run['elapsed']:>7.2f}  "
            f"{run['requests_per_second']:>5.2f}  {run['tokens_per_second']:>5.1f}  {speedup:>7.2f}"
        )

    largest = runs[-1]
    print("\nPer-host work in the largest run:")
    for host, summary in sorted(largest["by_host"].items()):
        platforms = ",".join(sorted(summary["platforms"]))
        print(
            f"  {host:<24} requests={summary['requests']:>3}  tokens={summary['tokens']:>5}  "
            f"task_seconds={summary['task_seconds']:>7.2f}  platform={platforms}"
        )

    print("\nSample outputs:")
    for sample in largest["samples"]:
        text = " ".join(str(sample["text"]).split())[:220]
        print(f"  [{sample['host']}] prompt={sample['request_id']} output={text}")

    ray.shutdown()


if __name__ == "__main__":
    main()
