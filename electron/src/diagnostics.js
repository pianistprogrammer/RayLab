'use strict';

const net = require('net');
const dns = require('dns');
const { spawnSync } = require('child_process');
const { rayVersion, pythonVersion, rayCommand, PINNED_RAY_VERSION, PINNED_PYTHON, resolvedRayExecutable, which } = require('./bootstrap');

// ─── Private-host check ───────────────────────────────────────────────────────

async function isPrivateHost(host) {
  if (!host) return false;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return true;
  try {
    const { address } = await dns.promises.lookup(host);
    return _isPrivateIp(address);
  } catch (_) {
    return false;
  }
}

function _isPrivateIp(ip) {
  if (ip.startsWith('127.') || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const match = ip.match(/^172\.(\d+)\./);
  if (match && parseInt(match[1]) >= 16 && parseInt(match[1]) <= 31) return true;
  return false;
}

// ─── Port helpers ─────────────────────────────────────────────────────────────

function isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, host === 'localhost' ? '127.0.0.1' : host);
  });
}

function isPortReachable(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

async function findAvailablePort(host, preferred, limit = 200) {
  for (let port = preferred; port < preferred + limit; port++) {
    if (await isPortAvailable(host, port)) return port;
  }
  throw new Error(`No available port found in range ${preferred}–${preferred + limit - 1}`);
}

// ─── Coordinator reachability ─────────────────────────────────────────────────

async function isCoordinatorReachable(config) {
  const host = config.coordinator.head_host;
  const port = config.coordinator.ray_port;
  if (await isPortReachable(host, port, 1000)) return true;
  // nc CLI fallback (macOS)
  if (process.platform === 'darwin') {
    const nc = '/usr/bin/nc';
    try {
      const result = spawnSync(nc, ['-z', '-G', '2', host, String(port)], { timeout: 3000 });
      if (result.status === 0) return true;
    } catch (_) {}
  }
  return false;
}

// ─── Worker account checks ────────────────────────────────────────────────────

function hasWorkerAccount(account) {
  if (!account) return false;
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('net', ['user', account], { timeout: 5000, encoding: 'utf8' });
      return r.status === 0;
    } catch (_) { return false; }
  }
  try {
    const r = spawnSync('id', [account], { timeout: 5000, encoding: 'utf8' });
    return r.status === 0;
  } catch (_) { return false; }
}

function hasWorkerLaunchPermission(account) {
  if (!account) return true;
  if (process.platform !== 'darwin') return true;
  try {
    const r = spawnSync('sudo', ['-n', '-u', account, '--', 'true'], { timeout: 5000 });
    return r.status === 0;
  } catch (_) { return false; }
}

// ─── Container runtime checks ─────────────────────────────────────────────────

function containerRuntimeStatus(runtime) {
  const name = 'docker';
  const bin = dockerExecutable();
  if (!bin) return { ok: false, detail: 'Docker is not installed or not on PATH' };
  try {
    const r = spawnSync(bin, ['--version'], { timeout: 5000, encoding: 'utf8' });
    const detail = (r.stdout || r.stderr || '').trim();
    return { ok: r.status === 0, detail: detail || `${name} found` };
  } catch (_) {
    return { ok: false, detail: 'Docker is not available' };
  }
}

function dockerExecutable() {
  const fromPath = which('docker');
  if (fromPath) return fromPath;
  if (process.platform === 'win32') {
    const fs = require('fs');
    const candidates = [
      'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
      'C:\\Program Files\\Docker\\Docker\\resources\\docker.exe',
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }
  return null;
}

function gpuRuntimeStatus(runtime) {
  try {
    const docker = dockerExecutable() || 'docker';
    const result = spawnSync(docker, ['info', '--format', '{{json .Runtimes}}'], { timeout: 8000, encoding: 'utf8' });
    const text = ((result.stdout || '') + (result.stderr || '')).toLowerCase();
    if (text.includes('nvidia') || text.includes('gpu')) {
      return { ok: true, detail: 'GPU runtime appears configured' };
    }
    return { ok: false, detail: 'No NVIDIA/GPU runtime detected' };
  } catch (_) {
    return { ok: false, detail: 'Container runtime check failed' };
  }
}

// ─── 7 diagnostic checks ─────────────────────────────────────────────────────

async function diagnostics(config) {
  const checks = [];
  const mode = config.app_mode;
  const coord = config.coordinator;
  const privacy = config.privacy;
  const store = config.object_store;

  // 1 — Ray CLI
  const rayExe = resolvedRayExecutable();
  const rv = rayExe ? rayVersion(rayExe) : null;
  const pv = pythonVersion();
  const rayOk = rv === PINNED_RAY_VERSION && pv === PINNED_PYTHON;
  checks.push({
    id: 'ray',
    label: 'Ray CLI',
    status: rayOk ? 'pass' : 'fail',
    detail: rayOk
      ? `Ray ${rv}, Python ${pv} at ${rayExe}`
      : (rv ? `Ray ${rv} found but expected ${PINNED_RAY_VERSION}` : 'Ray CLI not found'),
    fix: rayOk ? null : `Install the app-local pinned Ray runtime (${PINNED_RAY_VERSION}) with Python ${PINNED_PYTHON} from Setup.`,
  });

  // 2 — Private network
  const privateOk = await isPrivateHost(coord.head_host);
  checks.push({
    id: 'private_network',
    label: 'Private VLAN address',
    status: privateOk ? 'pass' : 'fail',
    detail: privateOk
      ? `Coordinator host ${coord.head_host} is private`
      : `${coord.head_host} is not private or cannot be resolved`,
    fix: privateOk ? null : 'Use a private VLAN IP/DNS name; do not bind Ray to public campus or internet interfaces.',
  });

  // 3 — Ray port
  if (mode === 'node') {
    const reachable = await isCoordinatorReachable(config);
    checks.push({
      id: 'ray_port',
      label: 'Coordinator reachability',
      status: reachable ? 'pass' : 'warn',
      detail: reachable
        ? `Coordinator reachable at ${coord.head_host}:${coord.ray_port}`
        : `Cannot reach ${coord.head_host}:${coord.ray_port}`,
      fix: reachable ? null : 'Start the host in External workers mode or save the host machine\'s LAN IP address.',
    });
  } else {
    const portFree = await isPortAvailable(coord.head_host, coord.ray_port);
    checks.push({
      id: 'ray_port',
      label: 'Ray head port',
      status: portFree ? 'pass' : 'fail',
      detail: portFree
        ? `Port ${coord.ray_port} is available on ${coord.head_host}`
        : `Port ${coord.ray_port} on ${coord.head_host} is already in use`,
      fix: portFree ? null : 'Run Full machine setup to automatically select an available Ray head port.',
    });
  }

  // 4 — Worker account
  const account = privacy.worker_account || 'raylab-worker';
  const accountExists = hasWorkerAccount(account);
  let workerStatus, workerDetail, workerFix;
  if (process.platform === 'darwin' && mode === 'node' && accountExists && !hasWorkerLaunchPermission(account)) {
    workerStatus = 'fail';
    workerDetail = `Account ${account} exists but sudo launch permission not yet granted`;
    workerFix = 'Run Full machine setup and approve the macOS administrator prompt.';
  } else if (accountExists) {
    workerStatus = 'pass';
    workerDetail = `Dedicated account ${account} is ready`;
    workerFix = null;
  } else if (process.platform === 'darwin' && mode === 'coordinator') {
    workerStatus = 'warn';
    workerDetail = 'macOS Coordinator/UI mode can continue; production GPU worker isolation is Windows/Linux only';
    workerFix = null;
  } else {
    workerStatus = 'fail';
    workerDetail = `Account ${account} does not exist`;
    workerFix = 'Use Create account to create the dedicated worker account with administrator approval.';
  }
  checks.push({ id: 'worker_account', label: 'Dedicated worker account', status: workerStatus, detail: workerDetail, fix: workerFix });

  // 5 — Container runtime
  const runtime = 'docker';
  const containerStatus = containerRuntimeStatus(runtime);
  checks.push({
    id: 'container_runtime',
    label: 'Container runtime',
    status: containerStatus.ok ? 'pass' : 'fail',
    detail: containerStatus.detail,
    fix: containerStatus.ok ? null : 'Use Install Docker to install Docker Desktop, then restart Docker if Windows asks.',
  });

  // 6 — GPU container runtime
  if (!containerStatus.ok) {
    checks.push({ id: 'gpu_container_runtime', label: 'GPU container runtime', status: 'warn', detail: 'Skipped (container runtime not available)', fix: null });
  } else {
    const gpuStatus = gpuRuntimeStatus(runtime);
    checks.push({
      id: 'gpu_container_runtime',
      label: 'GPU container runtime',
      status: gpuStatus.ok ? 'pass' : 'warn',
      detail: gpuStatus.detail,
      fix: gpuStatus.ok ? null : 'Install NVIDIA Container Toolkit or equivalent GPU support for the selected runtime.',
    });
  }

  // 7 — Object store
  const storeOk = !!(store.endpoint_url && store.bucket);
  checks.push({
    id: 'object_store',
    label: 'Lab object store',
    status: storeOk ? 'pass' : 'warn',
    detail: storeOk ? `${store.endpoint_url} / ${store.bucket}` : 'Object store is not configured yet',
    fix: storeOk ? null : 'Set endpoint and bucket before submitting real LLM/data jobs.',
  });

  return checks;
}

module.exports = {
  diagnostics,
  isPrivateHost,
  isPortAvailable,
  isPortReachable,
  findAvailablePort,
  isCoordinatorReachable,
  hasWorkerAccount,
  hasWorkerLaunchPermission,
  containerRuntimeStatus,
  gpuRuntimeStatus,
  dockerExecutable,
};
