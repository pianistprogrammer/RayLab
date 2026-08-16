# RayLab Benchmarks

This folder contains the benchmark scripts and shareable report artifacts used to demonstrate RayLab cluster compute.

## Files

- `ray_compute_test.py` - deterministic CPU benchmark. Counts all prime numbers below a limit and compares 1, 2, and 3 nodes.
- `monte_carlo_benchmark.py` - recommended demo benchmark. Prices a European call option by splitting Monte Carlo paths across Ray nodes.
- `mnist_cnn_ray_fedavg.py` - real MNIST CNN training benchmark using Ray actors and synchronized weight averaging.
- `cleanup_placement_groups.py` - maintenance helper used to remove leaked Ray placement groups.
- `llm_cluster_benchmark.py` - LLM batch-inference benchmark. Runs many prompts across the alive Ray nodes.
- `prompts.txt` - sample prompts for the LLM benchmark.
- `reports/raylab-benchmark-charts.html` - browser report with charts.
- `reports/monte-carlo-results.json` - source data for the recommended Monte Carlo report.
- `reports/raylab-mnist-cnn-report.html` - real MNIST CNN training report.
- `reports/mnist-cnn-ray-results.json` - source data for the MNIST CNN training report.
- `reports/raylab-benchmark-charts.pdf` - PDF report for sharing.
- `reports/screenshots/raylab-benchmark-charts-full.png` - image version of the report.

## Recommended Demo: Monte Carlo Simulation

This is the cleanest scaling story for prospective users. The task is European call option pricing with independent Monte Carlo path chunks. Each Ray task simulates market paths locally and returns only a small aggregate result, so most of the runtime is useful computation instead of cluster communication.

From a Mac submitting to the Windows coordinator:

```bash
RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 /Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.12:8265 \
  --working-dir benchmark \
  -- C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe \
     monte_carlo_benchmark.py \
     --address auto \
     --tasks 96 \
     --paths-per-task 5000000 \
     --max-nodes 2 \
     --warmup
```

The benchmark task is: price a European call option with `96` chunks x `5,000,000` paths = `480,000,000` simulated paths per run.

Measured demo result:

| Nodes | Seconds | Paths/s | Speedup | Monte Carlo price | Std error |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 7.77 | 61.8M | 1.00x | 11.539097 | 0.000945 |
| 2 | 3.44 | 139.7M | 2.26x | 11.539097 | 0.000945 |

Analytical Black-Scholes price: `11.539831`.

The shareable charts in `reports/` are based on this Monte Carlo run.

## Real MNIST CNN Training Benchmark

This is the working neural-network benchmark. It trains a simple convolutional neural network on real MNIST data across RayLab nodes. Each node keeps a local MNIST shard in a Ray actor, trains a local CNN replica, and returns model weights for synchronized averaging after each round.

It uses the RayLab runtime virtual environment on whichever machine is currently running the Ray coordinator. The participating worker nodes also need `torch` installed in their RayLab runtime because the training actors execute there.

Run from a Mac submitting to the Windows coordinator:

```bash
RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 /Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.12:8265 \
  --working-dir benchmark \
  -- C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe \
     mnist_cnn_ray_fedavg.py \
     --address auto \
     --max-nodes 3 \
     --rounds 5 \
     --train-samples 24000 \
     --test-samples 5000 \
     --batch-size 128 \
     --output-json - \
     --print-json
```

Measured result on the current mixed Windows/macOS cluster:

| Nodes | Seconds | Images/s | Speedup | Test accuracy | Test loss |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 18.56 | 6,467 | 1.00x | 96.98% | 0.0887 |
| 2 | 15.06 | 7,967 | 1.23x | 96.96% | 0.0892 |
| 3 | 13.83 | 8,678 | 1.34x | 96.54% | 0.1028 |

Largest-run host contribution with CPU share:

| Host | Platform | CPU cores | CPU share | Samples | Local train seconds |
| --- | --- | ---: | ---: | ---: | ---: |
| Abimbolas | Windows | 4 | 15.4% | 40,000 | 4.26 |
| BaddestM4.local | Darwin | 10 | 38.5% | 40,000 | 2.73 |
| F6TMFW21C3 | Darwin | 12 | 46.2% | 40,000 | 1.54 |

The shareable neural-network report is `reports/raylab-mnist-cnn-report.html`, with source data in `reports/mnist-cnn-ray-results.json`.

## Prime Compute Benchmark

From a Mac submitting to the Windows coordinator:

```bash
RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 /Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.12:8265 \
  --working-dir benchmark \
  -- C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe \
     ray_compute_test.py \
     --address auto \
     --limit 10000000 \
     --chunks 96
```

The benchmark task is: count all prime numbers below `10,000,000`, split into `96` Ray tasks.

## LLM Benchmark: Scheduling Smoke Test

Run this first. It does not require a model. It verifies that RayLab can distribute prompt-like requests across every alive node.

```bash
RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 /Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.12:8265 \
  --working-dir benchmark \
  -- C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe \
     llm_cluster_benchmark.py \
     --address auto \
     --backend dry-run \
     --requests 48 \
     --max-tokens 64 \
     --prompts-file prompts.txt
```

## LLM Benchmark: Real GGUF Inference

For a real LLM run, `llama-cpp-python` must be available on every node that executes the benchmark actor. You do not necessarily need to SSH into every node and install it manually. Ray can create a job-specific runtime environment and install the Python dependency on each participating node.

### Option A: Let Ray install the dependency for this job

Use `--runtime-env-json` with `llm-runtime-env.json`:

```bash
RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 /Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.12:8265 \
  --working-dir benchmark \
  --runtime-env-json "$(cat benchmark/llm-runtime-env.json)" \
  -- python \
     llm_cluster_benchmark.py \
     --address auto \
     --backend llama-cpp \
     --model-url "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf" \
     --requests 48 \
     --max-tokens 64 \
     --prompts-file prompts.txt
```

This is the least manual path. The tradeoff is that the first run can be slow, and `llama-cpp-python` may need platform-specific wheels or native build tools. If a node cannot build or install the package, use Option B or add an app-level "Install LLM support" step.

### Option B: Preinstall once in the RayLab runtime

This is more predictable for demos because the expensive package install happens before the benchmark starts.

Example installer commands:

```bash
# macOS RayLab runtime
/Users/Shared/RayLab/runtime/venv/bin/python -m pip install llama-cpp-python

# Windows RayLab runtime, run in PowerShell
C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe -m pip install llama-cpp-python
```

Then run with a model URL. Each node downloads the model into its local RayLab model cache if it is not already present.

```bash
RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 /Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.12:8265 \
  --working-dir benchmark \
  -- C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe \
     llm_cluster_benchmark.py \
     --address auto \
     --backend llama-cpp \
     --model-url "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf" \
     --requests 48 \
     --max-tokens 64 \
     --prompts-file prompts.txt
```

The real LLM benchmark measures prompt requests per second, generated tokens per second, speedup, and per-host contribution.

## Honest Positioning

This demonstrates batch LLM inference: many prompt requests are distributed across many machines. It does not shard one giant model across a mixed Windows/macOS cluster. That larger-model sharding use case normally needs a more specialized Linux/CUDA stack.

## NumPy/SciPy Benchmark

This benchmark runs deterministic numerical linear algebra across the cluster: each task performs a NumPy dense matrix multiplication and a SciPy Cholesky solve.

The RayLab runtime on each node needs NumPy and SciPy. The most reliable local-lab path is to install them once with the bundled `uv` tool:

```bash
# macOS RayLab runtime
/Applications/RayLab.app/Contents/Resources/vendor/bin/uv pip install \
  --python /Users/Shared/RayLab/runtime/venv/bin/python \
  numpy scipy

# Windows RayLab runtime, run in PowerShell
C:/Users/sarag/AppData/Local/Programs/@raylabelectron/resources/vendor/bin/uv.exe pip install \
  --python C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe \
  numpy scipy
```

Then submit the benchmark:

```bash
RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1 /Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.12:8265 \
  --working-dir benchmark \
  -- C:/Users/sarag/AppData/Roaming/raylab-cluster-manager/runtime/venv/Scripts/python.exe \
     numpy_scipy_benchmark.py \
     --address auto \
     --tasks 48 \
     --matrix-size 600
```

The output reports wall time, tasks per second, estimated GFLOP/s, speedup, residual error, and per-host contribution.

Ray `runtime_env` can also install NumPy/SciPy dynamically using `numpy-scipy-runtime-env.json`, but on the current Windows coordinator it hit a Windows path-length failure while cloning the runtime environment. Preinstalling with `uv` avoids that for demos.
