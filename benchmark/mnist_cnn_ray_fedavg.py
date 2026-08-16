#!/usr/bin/env python3
"""RayLab MNIST CNN benchmark using Ray actors and weight averaging.

This trains a simple CNN on real MNIST data across Ray nodes using synchronous
weight averaging. Each Ray worker receives a shard of MNIST, trains locally for
one or more epochs, returns updated weights, and the driver averages those
weights before the next round.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import platform
import socket
import struct
import time
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

os.environ.setdefault("RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")

import numpy as np
import ray
from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy

MNIST_BASE_URLS = [
    "https://storage.googleapis.com/cvdf-datasets/mnist",
    "https://ossci-datasets.s3.amazonaws.com/mnist",
]

MNIST_FILES = {
    "train_images": "train-images-idx3-ubyte.gz",
    "train_labels": "train-labels-idx1-ubyte.gz",
    "test_images": "t10k-images-idx3-ubyte.gz",
    "test_labels": "t10k-labels-idx1-ubyte.gz",
}


@dataclass(frozen=True)
class ClusterNode:
    node_id: str
    address: str
    hostname: str
    cpus: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train a simple CNN on MNIST across RayLab nodes using weight averaging.")
    parser.add_argument("--address", default="auto", help="Ray address. Use 'auto' inside a Ray job.")
    parser.add_argument("--max-nodes", type=int, default=3, help="Maximum alive nodes to include.")
    parser.add_argument("--rounds", type=int, default=3, help="Global synchronization rounds.")
    parser.add_argument("--local-epochs", type=int, default=1, help="Local epochs per worker per round.")
    parser.add_argument("--batch-size", type=int, default=128, help="Training batch size per worker.")
    parser.add_argument("--train-samples", type=int, default=24000, help="Training samples to use from MNIST.")
    parser.add_argument("--test-samples", type=int, default=5000, help="Test samples to evaluate.")
    parser.add_argument("--learning-rate", type=float, default=0.05, help="SGD learning rate.")
    parser.add_argument("--momentum", type=float, default=0.9, help="SGD momentum.")
    parser.add_argument("--seed", type=int, default=2026, help="Random seed.")
    parser.add_argument("--torch-threads", type=int, default=1, help="Torch intra-op threads per worker.")
    parser.add_argument("--data-dir", default="data/mnist", help="Where to cache MNIST files in the job working directory.")
    parser.add_argument("--output-json", default="reports/mnist-cnn-ray-results.json", help="Where to write result JSON, or '-' to skip writing.")
    parser.add_argument("--print-json", action="store_true", help="Print result JSON between machine-readable markers.")
    return parser.parse_args()


def download_file(filename: str, data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    target = data_dir / filename
    if target.exists() and target.stat().st_size > 0:
        return target
    errors = []
    for base in MNIST_BASE_URLS:
        url = f"{base}/{filename}"
        try:
            print(f"Downloading {url}")
            with urllib.request.urlopen(url, timeout=60) as response:
                target.write_bytes(response.read())
            return target
        except Exception as exc:  # pragma: no cover - network fallback path
            errors.append(f"{url}: {exc}")
    raise RuntimeError("Unable to download MNIST file. Tried: " + "; ".join(errors))


def read_images(path: Path) -> np.ndarray:
    with gzip.open(path, "rb") as handle:
        magic, count, rows, cols = struct.unpack(">IIII", handle.read(16))
        if magic != 2051:
            raise ValueError(f"Unexpected MNIST image magic {magic} in {path}")
        data = np.frombuffer(handle.read(), dtype=np.uint8).reshape(count, 1, rows, cols)
    images = data.astype(np.float32) / 255.0
    return (images - 0.1307) / 0.3081


def read_labels(path: Path) -> np.ndarray:
    with gzip.open(path, "rb") as handle:
        magic, count = struct.unpack(">II", handle.read(8))
        if magic != 2049:
            raise ValueError(f"Unexpected MNIST label magic {magic} in {path}")
        labels = np.frombuffer(handle.read(), dtype=np.uint8)
    if labels.shape[0] != count:
        raise ValueError(f"Expected {count} labels in {path}, got {labels.shape[0]}")
    return labels.astype(np.int64)


def load_mnist(data_dir: Path, train_samples: int, test_samples: int, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    paths = {key: download_file(filename, data_dir) for key, filename in MNIST_FILES.items()}
    train_images = read_images(paths["train_images"])
    train_labels = read_labels(paths["train_labels"])
    test_images = read_images(paths["test_images"])
    test_labels = read_labels(paths["test_labels"])

    rng = np.random.default_rng(seed)
    train_take = min(train_samples, train_images.shape[0])
    test_take = min(test_samples, test_images.shape[0])
    train_index = rng.permutation(train_images.shape[0])[:train_take]
    test_index = np.arange(test_take)
    return train_images[train_index], train_labels[train_index], test_images[test_index], test_labels[test_index]


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


def make_model():
    import torch
    import torch.nn as nn

    class SimpleCNN(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.conv = nn.Conv2d(1, 10, kernel_size=5)
            self.fc = nn.Linear(1440, 10)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            x = torch.relu(self.conv(x))
            x = torch.max_pool2d(x, 2)
            x = x.view(x.size(0), -1)
            return self.fc(x)

    return SimpleCNN()


def initial_state(seed: int) -> dict[str, np.ndarray]:
    import torch

    torch.manual_seed(seed)
    model = make_model()
    return {key: value.detach().cpu().numpy().copy() for key, value in model.state_dict().items()}


def load_state_into_model(model: Any, state: dict[str, np.ndarray]) -> None:
    import torch

    model.load_state_dict({key: torch.from_numpy(value.copy()) for key, value in state.items()})


def average_states(results: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    total = sum(int(item["samples"]) for item in results)
    averaged: dict[str, np.ndarray] = {}
    for key in results[0]["state"]:
        acc = None
        for item in results:
            weight = int(item["samples"]) / total
            value = item["state"][key].astype(np.float64) * weight
            acc = value if acc is None else acc + value
        averaged[key] = acc.astype(np.float32)
    return averaged


def train_model_on_arrays(
    state: dict[str, np.ndarray],
    images: np.ndarray,
    labels: np.ndarray,
    round_index: int,
    worker_index: int,
    config: dict[str, Any],
) -> dict[str, Any]:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    from torch.utils.data import DataLoader, TensorDataset

    torch.set_num_threads(int(config["torch_threads"]))
    torch.manual_seed(int(config["seed"]) + round_index * 100 + worker_index)
    model = make_model()
    load_state_into_model(model, state)
    model.train()

    dataset = TensorDataset(torch.from_numpy(images.copy()), torch.from_numpy(labels.copy()))
    generator = torch.Generator()
    generator.manual_seed(int(config["seed"]) + round_index * 1000 + worker_index)
    loader = DataLoader(dataset, batch_size=int(config["batch_size"]), shuffle=True, generator=generator)

    criterion = nn.CrossEntropyLoss()
    optimizer = optim.SGD(model.parameters(), lr=float(config["learning_rate"]), momentum=float(config["momentum"]))

    started = time.perf_counter()
    loss_sum = 0.0
    correct = 0
    seen = 0
    for _ in range(int(config["local_epochs"])):
        for batch_x, batch_y in loader:
            optimizer.zero_grad(set_to_none=True)
            output = model(batch_x)
            loss = criterion(output, batch_y)
            loss.backward()
            optimizer.step()
            batch_size = int(batch_y.shape[0])
            loss_sum += float(loss.detach()) * batch_size
            correct += int((output.argmax(dim=1) == batch_y).sum().item())
            seen += batch_size

    elapsed = time.perf_counter() - started
    return {
        "round": round_index,
        "worker": worker_index,
        "host": socket.gethostname(),
        "platform": platform.system(),
        "samples": seen,
        "seconds": elapsed,
        "train_loss": loss_sum / seen if seen else math.nan,
        "train_accuracy": correct / seen if seen else math.nan,
        "state": {key: value.detach().cpu().numpy().copy() for key, value in model.state_dict().items()},
    }


@ray.remote(num_cpus=1)
class ShardTrainer:
    def __init__(self, images: np.ndarray, labels: np.ndarray, worker_index: int, config: dict[str, Any]) -> None:
        self.images = images
        self.labels = labels
        self.worker_index = worker_index
        self.config = config
        self.host = socket.gethostname()
        self.platform = platform.system()

    def train_round(self, state: dict[str, np.ndarray], round_index: int) -> dict[str, Any]:
        result = train_model_on_arrays(state, self.images, self.labels, round_index, self.worker_index, self.config)
        result["host"] = self.host
        result["platform"] = self.platform
        return result


def evaluate(state: dict[str, np.ndarray], images: np.ndarray, labels: np.ndarray, batch_size: int, torch_threads: int) -> dict[str, float]:
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, TensorDataset

    torch.set_num_threads(torch_threads)
    model = make_model()
    load_state_into_model(model, state)
    model.eval()
    loader = DataLoader(TensorDataset(torch.from_numpy(images.copy()), torch.from_numpy(labels.copy())), batch_size=batch_size)
    criterion = nn.CrossEntropyLoss(reduction="sum")
    total_loss = 0.0
    correct = 0
    total = 0
    started = time.perf_counter()
    with torch.no_grad():
        for batch_x, batch_y in loader:
            output = model(batch_x)
            total_loss += float(criterion(output, batch_y).item())
            correct += int((output.argmax(dim=1) == batch_y).sum().item())
            total += int(batch_y.shape[0])
    elapsed = time.perf_counter() - started
    return {"test_loss": total_loss / total, "test_accuracy": correct / total, "test_seconds": elapsed}


def split_indices(total: int, parts: int) -> list[np.ndarray]:
    indices = np.arange(total)
    return [chunk for chunk in np.array_split(indices, parts) if chunk.size]


def train_with_nodes(nodes: list[ClusterNode], args: argparse.Namespace, train_images: np.ndarray, train_labels: np.ndarray, test_images: np.ndarray, test_labels: np.ndarray) -> dict[str, Any]:
    config = {
        "batch_size": args.batch_size,
        "learning_rate": args.learning_rate,
        "momentum": args.momentum,
        "local_epochs": args.local_epochs,
        "torch_threads": args.torch_threads,
        "seed": args.seed,
    }
    state = initial_state(args.seed)
    partitions = split_indices(train_images.shape[0], len(nodes))
    total_started = time.perf_counter()
    history = []
    host_totals: dict[str, dict[str, Any]] = defaultdict(lambda: {"rounds": 0, "samples": 0, "seconds": 0.0, "platforms": set()})
    trainers = []
    for worker_index, node in enumerate(nodes):
        part = partitions[worker_index]
        strategy = NodeAffinitySchedulingStrategy(node_id=node.node_id, soft=False)
        trainers.append(
            ShardTrainer.options(scheduling_strategy=strategy).remote(
                train_images[part],
                train_labels[part],
                worker_index,
                config,
            )
        )

    for round_index in range(1, args.rounds + 1):
        refs = [trainer.train_round.remote(state, round_index) for trainer in trainers]
        results = ray.get(refs)
        state = average_states(results)
        evaluation = evaluate(state, test_images, test_labels, args.batch_size * 2, args.torch_threads)
        round_seconds = max(float(item["seconds"]) for item in results)
        train_samples = sum(int(item["samples"]) for item in results)
        train_loss = sum(float(item["train_loss"]) * int(item["samples"]) for item in results) / train_samples
        train_accuracy = sum(float(item["train_accuracy"]) * int(item["samples"]) for item in results) / train_samples
        for item in results:
            summary = host_totals[str(item["host"])]
            summary["rounds"] += 1
            summary["samples"] += int(item["samples"])
            summary["seconds"] += float(item["seconds"])
            summary["platforms"].add(str(item["platform"]))
        history.append(
            {
                "round": round_index,
                "seconds": round_seconds,
                "train_loss": train_loss,
                "train_accuracy": train_accuracy,
                **evaluation,
                "workers": [
                    {
                        "host": item["host"],
                        "platform": item["platform"],
                        "samples": item["samples"],
                        "seconds": item["seconds"],
                        "train_loss": item["train_loss"],
                        "train_accuracy": item["train_accuracy"],
                    }
                    for item in sorted(results, key=lambda value: str(value["host"]))
                ],
            }
        )

    total_elapsed = time.perf_counter() - total_started
    final_eval = history[-1]
    return {
        "nodes": len(nodes),
        "seconds": total_elapsed,
        "images_per_second": (args.rounds * args.local_epochs * train_images.shape[0]) / total_elapsed,
        "final_train_loss": final_eval["train_loss"],
        "final_train_accuracy": final_eval["train_accuracy"],
        "final_test_loss": final_eval["test_loss"],
        "final_test_accuracy": final_eval["test_accuracy"],
        "history": history,
        "by_host": {
            host: {
                "rounds": item["rounds"],
                "samples": item["samples"],
                "seconds": item["seconds"],
                "platforms": sorted(item["platforms"]),
            }
            for host, item in sorted(host_totals.items())
        },
    }


def write_json(path: str, payload: dict[str, Any]) -> None:
    if path == "-":
        return
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    args = parse_args()
    ray.init(address=args.address)
    nodes = alive_cpu_nodes()
    if not nodes:
        raise SystemExit("No alive Ray CPU nodes found. Start RayLab on the coordinator and workers first.")
    nodes = nodes[: max(1, min(args.max_nodes, len(nodes)))]

    print("RayLab MNIST CNN benchmark")
    print("Task: train a simple CNN on real MNIST using Ray workers and synchronized weight averaging")
    print(f"Workload: {args.train_samples:,} train images, {args.test_samples:,} test images, {args.rounds} rounds")
    print(f"Connected resources: {ray.cluster_resources()}")
    print("Alive nodes selected:")
    for index, node in enumerate(nodes, start=1):
        print(f"  {index}. {node.address}  host={node.hostname}  cpus={node.cpus}  id={node.node_id[:10]}")

    train_images, train_labels, test_images, test_labels = load_mnist(Path(args.data_dir), args.train_samples, args.test_samples, args.seed)
    print(f"MNIST loaded: train={train_images.shape[0]:,}, test={test_images.shape[0]:,}")

    print("\nBenchmark: same MNIST subset, increasing Ray worker count")
    print("Nodes  Seconds  Images/s  Speedup  Test accuracy  Test loss")
    print("-----  -------  --------  -------  -------------  ---------")
    runs = []
    for count in range(1, len(nodes) + 1):
        run = train_with_nodes(nodes[:count], args, train_images, train_labels, test_images, test_labels)
        speedup = runs[0]["seconds"] / run["seconds"] if runs else 1.0
        run["speedup"] = speedup
        runs.append(run)
        print(
            f"{run['nodes']:>5}  {run['seconds']:>7.2f}  {run['images_per_second']:>8.0f}  "
            f"{speedup:>7.2f}  {run['final_test_accuracy'] * 100:>12.2f}%  {run['final_test_loss']:>9.4f}"
        )

    largest = runs[-1]
    print("\nPer-host work in the largest run:")
    for host, item in largest["by_host"].items():
        print(
            f"  {host:<24} rounds={item['rounds']:>2}  samples={item['samples']:>8,}  "
            f"seconds={item['seconds']:>7.2f}  platform={','.join(item['platforms'])}"
        )

    payload = {
        "benchmark": "mnist_cnn_ray_weight_averaging",
        "task": "Train a simple CNN on real MNIST using Ray workers and synchronized weight averaging",
        "workload": {
            "train_samples": int(train_images.shape[0]),
            "test_samples": int(test_images.shape[0]),
            "rounds": args.rounds,
            "local_epochs": args.local_epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "momentum": args.momentum,
        },
        "nodes_selected": [node.__dict__ for node in nodes],
        "runs": runs,
    }
    write_json(args.output_json, payload)
    if args.print_json:
        print("\n#RAYLAB_MNIST_CNN_JSON_BEGIN#")
        print(json.dumps(payload, indent=2))
        print("#RAYLAB_MNIST_CNN_JSON_END#")
    print(f"\nWrote results: {args.output_json}")
    ray.shutdown()


if __name__ == "__main__":
    main()
