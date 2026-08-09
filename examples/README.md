# RayLab Examples

## Cluster benchmark

Run this from any RayLab machine that can reach the coordinator dashboard:

```bash
/Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.14:8265 \
  --working-dir examples \
  -- /Users/Shared/RayLab/runtime/venv/bin/python ray_cluster_benchmark.py \
  --address auto \
  --max-nodes 3 \
  --workers-per-node 2 \
  --tasks 60 \
  --iterations 300000
```

The benchmark keeps the total work fixed and repeats it with 1, 2, and 3 nodes.
It pins actors to distinct Ray nodes, so the output shows whether more machines are
actually being used.

For a quick smoke test, lower the work:

```bash
/Users/Shared/RayLab/runtime/venv/bin/ray job submit \
  --address http://192.168.33.14:8265 \
  --working-dir examples \
  -- /Users/Shared/RayLab/runtime/venv/bin/python ray_cluster_benchmark.py \
  --address auto \
  --max-nodes 3 \
  --workers-per-node 1 \
  --tasks 12 \
  --iterations 50000
```

You can also run directly on the coordinator over SSH:

```bash
ssh baddestm4@192.168.33.14
cd ~/RayLab-benchmarks
/Users/Shared/RayLab/runtime/venv/bin/python ray_cluster_benchmark.py --address auto
```
