'use strict';

const os = require('os');
const { spawnSync } = require('child_process');
const { which } = require('./bootstrap');

// ─── Hardware detection ───────────────────────────────────────────────────────

async function detectHardware() {
  const cpuLogical = os.cpus().length;
  const memoryTotalGb = parseFloat((os.totalmem() / (1024 ** 3)).toFixed(1));

  let cpuPhysical = null;
  try {
    const si = require('systeminformation');
    const cpuInfo = await si.cpu();
    cpuPhysical = cpuInfo.physicalCores || null;
  } catch (_) {}

  const { gpuNames, gpuType, source } = _detectGpus();
  const gpuMemoryTotalGb = _gpuMemoryGb(gpuType, memoryTotalGb);

  return {
    cpu_logical: cpuLogical,
    cpu_physical: cpuPhysical,
    memory_total_gb: memoryTotalGb,
    gpu_count: gpuNames.length,
    gpu_names: gpuNames,
    gpu_type: gpuType,
    gpu_memory_total_gb: gpuMemoryTotalGb,
    gpu_memory_shared: gpuType === 'mps' && gpuMemoryTotalGb !== null,
    source,
  };
}

function _detectGpus() {
  // 1. NVIDIA
  const nvidiaSmi = which('nvidia-smi');
  if (nvidiaSmi) {
    try {
      const result = spawnSync(nvidiaSmi, ['--query-gpu=name', '--format=csv,noheader'], {
        timeout: 5000, encoding: 'utf8',
      });
      if (result.status === 0 && result.stdout.trim()) {
        const names = result.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
        if (names.length > 0) return { gpuNames: names, gpuType: 'cuda', source: 'nvidia-smi' };
      }
    } catch (_) {}
  }

  // 2. Apple MPS
  if (process.platform === 'darwin') {
    const profiler = '/usr/sbin/system_profiler';
    try {
      const result = spawnSync(profiler, ['SPDisplaysDataType', '-json'], {
        timeout: 10000, encoding: 'utf8',
      });
      if (result.status === 0) {
        const data = JSON.parse(result.stdout);
        const displays = data.SPDisplaysDataType || [];
        const gpuNames = [];
        for (const item of displays) {
          const hasMetal =
            (item.spdisplays_metal || '').toLowerCase().includes('supported') ||
            (item.sppci_metal || '').toLowerCase().includes('supported');
          const isApple =
            (item.sppci_model || item.spdisplays_chipset || item._name || '')
              .toLowerCase().startsWith('apple ');
          if (hasMetal || isApple) {
            const label = item.sppci_model || item.spdisplays_chipset || item._name || 'GPU';
            gpuNames.push(`Apple Metal/MPS (${label})`);
          }
        }
        if (gpuNames.length > 0) return { gpuNames, gpuType: 'mps', source: 'system_profiler' };
      }
    } catch (_) {}
  }

  // 3. Ray fallback
  const python3 = which('python3') || 'python3';
  try {
    const result = spawnSync(
      python3,
      ['-c', "import ray._private.utils as u, json; print(json.dumps(u.get_visible_accelerator_ids().get('GPU', [])))"],
      { timeout: 5000, encoding: 'utf8' }
    );
    if (result.status === 0) {
      const ids = JSON.parse(result.stdout.trim());
      if (Array.isArray(ids) && ids.length > 0) {
        return { gpuNames: ids.map((id) => `GPU ${id}`), gpuType: 'ray', source: 'ray' };
      }
    }
  } catch (_) {}

  return { gpuNames: [], gpuType: 'none', source: 'psutil' };
}

function _gpuMemoryGb(gpuType, systemMemoryGb) {
  if (gpuType === 'none') return null;

  if (gpuType === 'cuda') {
    const nvidiaSmi = which('nvidia-smi');
    if (nvidiaSmi) {
      try {
        const result = spawnSync(
          nvidiaSmi,
          ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
          { timeout: 5000, encoding: 'utf8' }
        );
        if (result.status === 0 && result.stdout.trim()) {
          const totalMiB = result.stdout.trim().split('\n')
            .map((l) => parseFloat(l.trim()))
            .filter((n) => !isNaN(n))
            .reduce((a, b) => a + b, 0);
          if (totalMiB > 0) return parseFloat((totalMiB / 1024).toFixed(1));
        }
      } catch (_) {}
    }
  }

  if (gpuType === 'mps') return systemMemoryGb;  // shared memory

  return null;
}

module.exports = { detectHardware };
