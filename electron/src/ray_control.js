'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { rayCommand, subprocessEnv, which } = require('./bootstrap');
const { diagnostics, isPortReachable } = require('./diagnostics');
const { ensureCoordinatorPreflightServer, formatPreflightFailure, runWorkerCallbackPreflight } = require('./network_preflight');
const { appendAudit, makeAuditEvent, load, save, configDir } = require('./storage');

// ─── Constants ────────────────────────────────────────────────────────────────

const RAY_PROCESS_NAMES = new Set(['raylet', 'gcs_server', 'plasma_store_server', 'dashboard', 'runtime_env_agent', 'log_monitor']);
const RAY_PROCESS_MARKERS = ['/raylet', '\\raylet', 'raylet.exe', 'gcs_server', 'plasma_store_server', 'dashboard.py', 'dashboard\\agent.py', 'runtime_env_agent', 'runtime_env\\agent', 'log_monitor.py', 'monitor.py', 'ray::'];
const SENSITIVE_FLAGS = new Set(['--redis-password', '--token']);
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

class PortConflictError extends Error {
  constructor(conflicts) {
    super(`Port conflict: ${conflicts.map((c) => `${c.name} port ${c.port}`).join(', ')} already in use. Stop the conflicting process and try again.`);
    this.name = 'PortConflictError';
    this.code = 'PORT_CONFLICT';
    this.conflicts = conflicts;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function redactCommand(cmd) {
  const out = [...cmd];
  for (let i = 0; i < out.length; i++) {
    if (SENSITIVE_FLAGS.has(out[i]) && i + 1 < out.length) {
      out[i + 1] = '<redacted>';
    }
  }
  return out;
}

function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tcpOpen(host, port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, _connectHost(host));
  });
}

function _connectHost(host) {
  if (!host || host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '*') return '127.0.0.1';
  return host;
}

// ─── Process detection ────────────────────────────────────────────────────────

function _psCommandLines() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
      ], { timeout: 4000, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) return [];
      return r.stdout.split('\n').map((l) => l.toLowerCase());
    }
    const r = spawnSync('ps', ['axww', '-o', 'command='], { timeout: 2000, encoding: 'utf8' });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').map((l) => l.toLowerCase());
  } catch (_) { return []; }
}

function _psProcesses() {
  try {
    if (process.platform === 'win32') {
      const script = [
        '$ErrorActionPreference=\'SilentlyContinue\'',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
      ].join('; ');
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 5000, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0 || !r.stdout.trim()) return [];
      const parsed = JSON.parse(r.stdout.trim());
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
        pid: Number(p.ProcessId),
        name: String(p.Name || ''),
        command: String(p.CommandLine || p.Name || ''),
      })).filter((p) => Number.isInteger(p.pid));
    }
    const r = spawnSync('ps', ['axww', '-o', 'pid=,command='], { timeout: 3000, encoding: 'utf8' });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return null;
      return { pid: Number.parseInt(match[1], 10), name: '', command: match[2] };
    }).filter(Boolean);
  } catch (_) { return []; }
}

function _isRayLine(line) {
  return RAY_PROCESS_MARKERS.some((m) => line.includes(m.toLowerCase()));
}

function _isIgnoredLine(line) {
  return line.includes('ray status') || line.includes('ray stop') || line.includes('ray start')
    || line.includes('grep ') || line.includes('ssh ') || line.includes('sshd ')
    || line.includes('electron ');
}

function _localRayProcesses() {
  const lines = _psCommandLines();
  return lines.filter((l) => !_isIgnoredLine(l) && _isRayLine(l));
}

function _localRayProcessInfos() {
  return _psProcesses().filter((p) => {
    const line = String(p.command || p.name || '').toLowerCase();
    return !_isIgnoredLine(line) && _isRayLine(line);
  });
}

function _localRayRunning(config) {
  if (!config || config.app_mode === 'unconfigured') return false;
  if (config.app_mode === 'coordinator') return _psHasHead(config);
  if (config.app_mode === 'node') return _psHasRaylet(config);
  return false;
}

function _psHasRaylet(config) {
  const addr = `${config.coordinator.head_host}:${config.coordinator.ray_port}`;
  return _psCommandLines().some((l) => {
    if (_isIgnoredLine(l)) return false;
    const isRaylet = l.includes('/site-packages/ray/core/src/ray/raylet/raylet')
      || l.includes('\\site-packages\\ray\\core\\src\\ray\\raylet\\raylet.exe')
      || l.includes('raylet.exe');
    return isRaylet && l.includes(`--gcs-address=${addr}`);
  });
}

function _psHasHead(config) {
  const host = config.coordinator.head_host;
  return _psCommandLines().some((l) => {
    if (_isIgnoredLine(l)) return false;
    const isRaylet = l.includes('/raylet') || l.includes('\\raylet') || l.includes('raylet.exe');
    return l.includes('gcs_server') || (isRaylet && (l.includes(`--node_ip_address=${host}`) || l.includes(`--node-ip-address=${host}`)));
  });
}

// ─── CommandRunner ────────────────────────────────────────────────────────────

function runRayCommand(cmd, { asWorker = false, workerAccount = 'raylab-worker', timeoutMs = 90000, onOutput } = {}) {
  return new Promise((resolve) => {
    let fullCmd = [...cmd];
    const env = subprocessEnv();

    if (asWorker && process.platform !== 'win32') {
      if (process.platform === 'darwin') {
        fullCmd = ['sudo', '-n', '-u', workerAccount, '--', 'env', 'RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER=1', ...cmd];
      } else {
        fullCmd = ['sudo', '-n', '-u', workerAccount, '--', ...cmd];
      }
    } else if (process.platform === 'darwin' || process.platform === 'win32') {
      env.RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER = '1';
    }
    env.GRPC_DNS_RESOLVER = env.GRPC_DNS_RESOLVER || 'native';
    env.NO_PROXY = _appendNoProxy(env.NO_PROXY, ['127.0.0.1', 'localhost']);
    env.no_proxy = _appendNoProxy(env.no_proxy, ['127.0.0.1', 'localhost']);

    const safe = redactCommand(fullCmd);
    if (onOutput) onOutput(`$ ${safe.join(' ')}`);

    let proc;
    try {
      proc = spawn(fullCmd[0], fullCmd.slice(1), {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ success: false, output: err.message, code: 127 });
      return;
    }

    const output = [];
    const handleChunk = (data) => {
      data.toString().split('\n').forEach((line) => {
        const clean = stripAnsi(line.replace(/\r$/, ''));
        if (!clean) return;
        output.push(clean);
        if (onOutput) onOutput(clean);
      });
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    const timer = setTimeout(() => {
      try { process.platform === 'win32' ? proc.kill() : process.kill(-proc.pid, 'SIGKILL'); } catch (_) {}
      resolve({ success: false, output: output.join('\n'), code: 124 });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0, output: output.join('\n'), code: code ?? 0 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: err.message, code: 127 });
    });
  });
}

// ─── Kill helpers ─────────────────────────────────────────────────────────────

async function _killLocalRayProcesses() {
  const procs = _localRayProcessInfos();
  if (procs.length === 0) return 0;
  try {
    spawnSync(rayCommand(), ['stop', '--force'], { timeout: 10000, env: subprocessEnv() });
  } catch (_) {}
  if (process.platform === 'win32') {
    for (const proc of procs) {
      if (proc.pid === process.pid) continue;
      try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { timeout: 8000, encoding: 'utf8', windowsHide: true }); } catch (_) {}
    }
  } else {
    for (const proc of procs) {
      if (proc.pid === process.pid) continue;
      try { process.kill(proc.pid, 'SIGTERM'); } catch (_) {}
    }
  }
  return procs.length;
}

async function _killWorkerRayProcesses(workerAccount) {
  if (process.platform === 'win32') return _killLocalRayProcesses();
  const patterns = [
    '[r]ay/core/src/ray/raylet/raylet',
    '[r]ay/core/src/ray/gcs/gcs_server',
    '[r]ay/_private/log_monitor.py',
    '[r]ay/_private/runtime_env/agent/main.py',
    '[r]ay/dashboard/dashboard.py',
  ];
  let count = 0;
  for (const pat of patterns) {
    try {
      const r = spawnSync('sudo', ['-n', '-u', workerAccount, '--', 'pkill', '-f', pat], { timeout: 5000 });
      if (r.status === 0) count++;
    } catch (_) {}
  }
  return count;
}

// ─── Wait helpers ─────────────────────────────────────────────────────────────

async function _waitForLocalStop(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!_localRayRunning(config)) return;
    await sleep(250);
  }
}

async function _waitForLocalStart(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (_localRayRunning(config)) return true;
    await sleep(250);
  }
  return false;
}

// ─── Port check ───────────────────────────────────────────────────────────────

async function _clearOrReportPortConflicts(config) {
  const conflicts = await _portConflicts(config);
  if (conflicts.length === 0) return;
  throw new PortConflictError(conflicts);
}

async function _portConflicts(config) {
  if (config.app_mode !== 'coordinator') return [];
  const coord = config.coordinator;
  const ports = [
    { host: _localBindHostForRayPort(coord), port: coord.ray_port, name: 'Ray head' },
    { host: _normalizeBindHost(coord.dashboard_host), port: coord.dashboard_port, name: 'Ray dashboard' },
    { host: _localBindHostForRayPort(coord), port: coord.client_port, name: 'Ray client' },
    { host: _localBindHostForRayPort(coord), port: coord.node_manager_port, name: 'Ray node manager' },
    { host: _localBindHostForRayPort(coord), port: coord.object_manager_port, name: 'Ray object manager' },
  ];
  const conflicts = [];
  for (const { host, port, name } of ports) {
    const owners = _portOwners(port);
    const available = await _localPortAvailable(host, port);
    if (!available || owners.length > 0) conflicts.push({ name, host, port, owners });
  }
  return conflicts;
}

function _normalizeBindHost(host) {
  if (!host || host === '*' || host === '::') return '0.0.0.0';
  if (host === 'localhost') return '127.0.0.1';
  return host;
}

function _localBindHostForRayPort(coord) {
  const configured = _normalizeIpLiteral(coord.node_ip_address);
  if (configured && _isLocalIp(configured)) return configured;
  return coord.allow_external_workers ? '0.0.0.0' : '127.0.0.1';
}

function _isLocalIp(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1') return true;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const iface of entries || []) {
      if (iface.family === 'IPv4' && iface.address === ip) return true;
    }
  }
  return false;
}

function _localPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(() => resolve(true)); });
    try {
      server.listen({ port, host: _normalizeBindHost(host), exclusive: true });
    } catch (_) {
      resolve(false);
    }
  });
}

function _portOwners(port) {
  if (process.platform === 'win32') return _windowsPortOwners(port);
  return _unixPortOwners(port);
}

function _unixPortOwners(port) {
  try {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 3000, encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout.trim()) return [];
    return r.stdout.split('\n').slice(1).map((line) => {
      const parts = line.trim().split(/\s+/);
      const pid = Number.parseInt(parts[1], 10);
      if (!Number.isInteger(pid)) return null;
      return { pid, command: parts[0] || `pid ${pid}` };
    }).filter(Boolean);
  } catch (_) { return []; }
}

function _windowsPortOwners(port) {
  const fromPowershell = _windowsPortOwnersFromPowershell(port);
  if (fromPowershell.length > 0) return fromPowershell;
  try {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { timeout: 3000, encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout.trim()) return [];
    const pids = new Set();
    for (const raw of r.stdout.split('\n')) {
      const line = raw.trim();
      if (!line.toUpperCase().startsWith('TCP')) continue;
      const parts = line.split(/\s+/);
      const local = parts[1] || '';
      const state = (parts[3] || '').toUpperCase();
      const pid = Number.parseInt(parts[4], 10);
      if (state === 'LISTENING' && local.endsWith(`:${port}`) && Number.isInteger(pid)) pids.add(pid);
    }
    return [...pids].map((pid) => ({ pid, command: `pid ${pid}` }));
  } catch (_) { return []; }
}

function _windowsPortOwnersFromPowershell(port) {
  try {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$items = foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)})) {
  $ownerPid = [int]$c.OwningProcess
  $proc = if ($ownerPid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" } else { $null }
  $command = if ($proc) { if ($proc.CommandLine) { $proc.CommandLine } else { $proc.Name } } elseif ($ownerPid -eq 4) { 'System' } else { "pid $ownerPid" }
  [pscustomobject]@{ pid = $ownerPid; command = $command }
}
$items | ConvertTo-Json -Compress
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout.trim()) return [];
    const parsed = JSON.parse(r.stdout.trim());
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const seen = new Set();
    return rows.map((row) => ({ pid: Number(row.pid), command: String(row.command || `pid ${row.pid}`) }))
      .filter((row) => Number.isInteger(row.pid) && !seen.has(row.pid) && seen.add(row.pid));
  } catch (_) { return []; }
}

async function _killPortConflicts(config, onOutput) {
  let conflicts = await _portConflicts(config);
  if (conflicts.length === 0) return { killed: 0, conflicts: [] };

  const pids = [...new Set(conflicts.flatMap((c) => c.owners || []).map((o) => o.pid))]
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  if (pids.length === 0) {
    if (onOutput) onOutput('No local port owner PID reported; trying Ray cleanup...');
    try { spawnSync(rayCommand(), ['stop', '--force'], { timeout: 10000, env: subprocessEnv() }); } catch (_) {}
    const killed = await _killLocalRayProcesses();
    if (onOutput && killed > 0) onOutput(`Fallback cleanup signalled ${killed} local Ray process(es)`);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      conflicts = await _portConflicts(config);
      if (conflicts.length === 0) {
        await appendAudit(makeAuditEvent('port_conflicts_stopped', 'Cleared configured Ray port conflicts with ray stop --force'));
        return { killed: 0, conflicts: [] };
      }
      await sleep(250);
    }
    throw new PortConflictError(conflicts);
  }

  for (const pid of pids) {
    if (onOutput) onOutput(`Stopping process ${pid} using a configured Ray port...`);
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, encoding: 'utf8' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (_) {}
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    conflicts = await _portConflicts(config);
    if (conflicts.length === 0) {
      await appendAudit(makeAuditEvent('port_conflicts_stopped', `Stopped ${pids.length} process(es) using configured Ray ports`, { pids }));
      return { killed: pids.length, conflicts: [] };
    }
    await sleep(250);
  }

  if (process.platform !== 'win32') {
    const remainingPids = [...new Set(conflicts.flatMap((c) => c.owners || []).map((o) => o.pid))]
      .filter((pid) => pids.includes(pid));
    for (const pid of remainingPids) {
      if (onOutput) onOutput(`Process ${pid} did not exit; forcing it to stop...`);
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }

    const forceDeadline = Date.now() + 3000;
    while (Date.now() < forceDeadline) {
      conflicts = await _portConflicts(config);
      if (conflicts.length === 0) {
        await appendAudit(makeAuditEvent('port_conflicts_stopped', `Force-stopped ${pids.length} process(es) using configured Ray ports`, { pids }));
        return { killed: pids.length, conflicts: [] };
      }
      await sleep(250);
    }
  }

  throw new PortConflictError(conflicts);
}

// ─── Node listing ─────────────────────────────────────────────────────────────

async function _fetchNodes(config) {
  const dashUrl = `http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}`;
  const fetchJson = (url) => new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });

  // Strategy 1: state API
  try {
    const data = await fetchJson(`${dashUrl}/api/v0/nodes`);
    const nodes = ((data.data || {}).result || {}).result || [];
    const seen = new Map();
    for (const n of nodes) {
      if (n.is_head_node) continue;
      const node = _normalizeStateApiNode(n);
      _rememberBestNode(seen, node, n);
    }
    return _sortedRememberedNodes(seen);
  } catch (_) {}

  // Strategy 2: legacy dashboard API
  try {
    const data = await fetchJson(`${dashUrl}/api/cluster_status`);
    const nodes = (data.data || {}).nodes || data.nodes || [];
    const seen = new Map();
    for (const n of nodes) {
      if (n.is_head_node || n.IsHeadNode) continue;
      const node = _normalizeLegacyNode(n);
      _rememberBestNode(seen, node, n);
    }
    return _sortedRememberedNodes(seen);
  } catch (_) {}

  return [];
}

function _normalizeStateApiNode(n) {
  const hostname = _nodeDisplayName(n);
  return {
    node_id: n.node_id || n.NodeID || hostname,
    hostname,
    status: n.state || n.State || n.status || 'unknown',
    owner: 'unknown',
    cpus_total: n.resources_total?.CPU || n.Resources?.CPU || 0,
    gpus_total: n.resources_total?.GPU || n.Resources?.GPU || 0,
    memory_total_gb: parseFloat((((n.resources_total?.memory || n.Resources?.memory || 0)) / (1024 ** 3)).toFixed(2)),
    cpu_percent: 0,
    gpu_percent: 0,
    ram_percent: 0,
    last_seen: new Date().toISOString(),
  };
}

function _normalizeLegacyNode(n) {
  const hostname = _nodeDisplayName(n);
  return {
    node_id: n.NodeID || n.node_id || hostname,
    hostname,
    status: n.State || n.state || n.status || 'unknown',
    owner: 'unknown',
    cpus_total: n.Resources?.CPU || n.resources_total?.CPU || n.CPU || 0,
    gpus_total: n.Resources?.GPU || n.resources_total?.GPU || n.GPU || 0,
    memory_total_gb: parseFloat((((n.Resources?.memory || n.resources_total?.memory || n.memory || 0)) / (1024 ** 3)).toFixed(2)),
    cpu_percent: 0,
    gpu_percent: 0,
    ram_percent: 0,
    last_seen: new Date().toISOString(),
  };
}

function _rememberBestNode(seen, node, raw) {
  const key = _nodeIdentity(raw, node);
  const rank = _nodeRank(node.status);
  const existing = seen.get(key);
  if (!existing || rank < existing.rank || (rank === existing.rank && _nodeFreshness(raw) > existing.freshness)) {
    seen.set(key, { rank, freshness: _nodeFreshness(raw), node });
  }
}

function _sortedRememberedNodes(seen) {
  return [...seen.values()]
    .filter((entry) => _isConnectedNodeStatus(entry.node.status))
    .sort((a, b) => a.rank - b.rank || a.node.hostname.localeCompare(b.node.hostname))
    .map((v) => v.node);
}

function _isConnectedNodeStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'alive' || s === 'running';
}

function _nodeRank(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'alive' || s === 'running') return 0;
  if (s === 'dead') return 2;
  return 1;
}

function _nodeFreshness(n) {
  const raw = n.last_seen || n.LastSeen || n.update_time_ms || n.UpdateTimeMs || n.start_time_ms || n.StartTimeMs || 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function _nodeIdentity(raw, node) {
  const stable = _firstString(
    raw.node_ip,
    raw.node_ip_address,
    raw.ip,
    raw.NodeManagerAddress,
    raw.nodeManagerAddress,
    raw.node_manager_address,
    raw.raylet?.nodeManagerAddress,
    raw.hostname,
    raw.node_name,
    raw.nodeName,
    raw.NodeName,
    node.hostname,
  );
  return `worker:${stable || node.node_id}`.toLowerCase();
}

function _nodeDisplayName(n) {
  return _firstString(
    n.hostname,
    n.node_name,
    n.nodeName,
    n.NodeName,
    n.node_ip,
    n.node_ip_address,
    n.ip,
    n.NodeManagerAddress,
    n.nodeManagerAddress,
    n.node_manager_address,
    n.node_id,
    n.NodeID,
  ) || 'unknown worker';
}

function _firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function _waitForCoordinatorNodeAlive(config, timeoutMs, stableMs) {
  const candidates = _localNodeIdentityCandidates(config);
  const deadline = Date.now() + timeoutMs;
  let firstSeenAt = null;

  while (Date.now() < deadline) {
    const nodes = await _fetchNodes(config);
    const alive = nodes.some((node) => candidates.has(String(node.hostname || '').toLowerCase())
      || candidates.has(String(node.node_id || '').toLowerCase()));

    if (alive) {
      if (!firstSeenAt) firstSeenAt = Date.now();
      if (Date.now() - firstSeenAt >= stableMs) return true;
    } else {
      firstSeenAt = null;
    }

    await sleep(1000);
  }

  return false;
}

function _localNodeIdentityCandidates(config) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) values.add(value.trim().toLowerCase());
  };

  add(config.coordinator.node_ip_address);
  add(os.hostname());
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const iface of entries || []) {
      if (iface.family === 'IPv4' && !iface.internal) add(iface.address);
    }
  }

  return values;
}

// ─── RayController ────────────────────────────────────────────────────────────

class RayController {
  constructor() {
    this.state = 'stopped';
    this.message = 'Not started';
    this._logs = [];
  }

  _log(message, stream = 'system') {
    const clean = stripAnsi(message);
    this._logs.push({ timestamp: new Date().toISOString(), stream, message: clean });
    if (this._logs.length > 500) this._logs.shift();
  }

  terminalLogs() {
    return this._logs.slice(-500);
  }

  async portConflicts(config) {
    return _portConflicts(config);
  }

  async clearPortConflicts(config) {
    const onOutput = (line) => this._log(line, 'stdout');
    return _killPortConflicts(config, onOutput);
  }

  async status(config) {
    const mode = config.app_mode;
    const localRunning = mode !== 'unconfigured' ? _localRayRunning(config) : false;

    if (mode === 'coordinator') {
      try {
        await ensureCoordinatorPreflightServer(config, (line) => this._log(line));
      } catch (err) {
        this._log(err.message || String(err), 'stderr');
      }
    }

    if ((this.state === 'stopped' || this.state === 'error') && localRunning) {
      this.state = 'running'; this.message = 'Ray is running';
    } else if (this.state === 'error' && !localRunning) {
      this.state = 'stopped'; this.message = 'Ray is not running locally';
    } else if (this.state === 'running' && !localRunning) {
      this.state = 'stopped'; this.message = 'Ray is not running locally';
    }

    const checks = await diagnostics(config);

    if (this.state === 'running') {
      const portCheck = checks.find((c) => c.id === 'ray_port');
      if (portCheck) {
        portCheck.status = 'pass';
        portCheck.fix = null;
        portCheck.detail = mode === 'coordinator'
          ? `${config.coordinator.head_host}:${config.coordinator.ray_port} is occupied by the running Ray head`
          : `Connected to coordinator at ${config.coordinator.head_host}:${config.coordinator.ray_port}`;
      }
      const preflightCheck = checks.find((c) => c.id === 'network_preflight');
      if (mode === 'node' && preflightCheck) {
        preflightCheck.status = 'pass';
        preflightCheck.fix = null;
        preflightCheck.detail = 'Coordinator heartbeat path is active for this worker';
      }
    }

    const address = mode === 'unconfigured' ? null
      : `${config.coordinator.head_host}:${config.coordinator.ray_port}`;
    const dashboardUrl = (mode === 'coordinator' && this.state === 'running')
      ? `http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}`
      : null;

    return {
      state: this.state,
      mode,
      address,
      dashboard_url: dashboardUrl,
      message: this.message,
      diagnostics: checks,
    };
  }

  async start(config, { ensureRayRuntime }) {
    const mode = config.app_mode;
    const coord = config.coordinator;
    const privacy = config.privacy;
    const onOutput = (line) => this._log(line, 'stdout');

    if (mode === 'unconfigured') throw new Error('Choose Coordinator or Node mode before starting Ray.');
    if (_localRayRunning(config)) {
      this.state = 'running'; this.message = 'Ray is already running';
      return this.status(config);
    }

    await _clearOrReportPortConflicts(config);

    // Bootstrap Ray runtime
    const bootstrap = await ensureRayRuntime(onOutput);
    if (!bootstrap.succeeded) {
      this.state = 'error';
      await appendAudit(makeAuditEvent('ray_bootstrap_failed', bootstrap.message));
      throw new Error(bootstrap.message);
    }

    // Clean up stale worker Ray processes if node mode
    if (mode === 'node') {
      const stopResult = await runRayCommand([rayCommand(), 'stop', '--force'], {
        asWorker: true, workerAccount: privacy.worker_account, timeoutMs: 30000, onOutput,
      });
      if (!stopResult.success) this._log('Worker cleanup returned non-zero; continuing.', 'stderr');
      await _waitForLocalStop(config, 4000);
      const remaining = _localRayProcesses();
      if (remaining.length > 0) {
        await _killWorkerRayProcesses(privacy.worker_account);
        await _waitForLocalStop(config, 3000);
      }
    }

    if (mode === 'coordinator') {
      await ensureCoordinatorPreflightServer(config, (line) => this._log(line));
    }

    if (mode === 'node') {
      const preflight = await runWorkerCallbackPreflight(config, (line) => this._log(line));
      if (!preflight.ok) {
        this.state = 'error';
        this.message = formatPreflightFailure(preflight);
        await appendAudit(makeAuditEvent('cluster_start_failed', this.message, { preflight }));
        throw new Error(this.message);
      }
    }

    const cmd = mode === 'coordinator' ? _headCommand(config) : _nodeCommand(config);
    const asWorker = mode === 'node';

    this.state = 'starting';
    this._log(`$ ${redactCommand(cmd).join(' ')}`);
    this._log('Starting Ray...');

    const result = await runRayCommand(cmd, {
      asWorker, workerAccount: privacy.worker_account, timeoutMs: 90000, onOutput,
    });

    if (!result.success) {
      this.state = 'error';
      await appendAudit(makeAuditEvent('cluster_start_failed', `Ray start failed (code ${result.code})`));
      throw new Error(`Ray failed to start. Exit code: ${result.code}\n${result.output.slice(-500)}`);
    }

    if (mode === 'node') {
      const started = await _waitForLocalStart(config, 8000);
      if (!started) {
        this.state = 'error';
        this.message = 'Ray worker exited before it became visible locally';
        await appendAudit(makeAuditEvent('cluster_start_failed', this.message));
        throw new Error(this.message);
      }

      this._log('Waiting for coordinator heartbeat confirmation...');
      const confirmed = await _waitForCoordinatorNodeAlive(config, 30000, 18000);
      if (!confirmed) {
        this.state = 'error';
        this.message = 'Ray worker started locally, but the coordinator did not keep it alive. Check inbound worker ports and firewall/network policy.';
        await appendAudit(makeAuditEvent('cluster_start_failed', this.message));
        throw new Error(this.message);
      }
    }

    this.state = 'running';
    this.message = 'Ray is running';
    this._log('Ray is running');
    await appendAudit(makeAuditEvent('cluster_started', `Ray started in ${mode} mode`, { mode }));
    return this.status(config);
  }

  async stop(config, { panic = false } = {}) {
    const mode = config.app_mode;
    const privacy = config.privacy;
    const onOutput = (line) => this._log(line, 'stdout');
    this.state = 'stopping';

    const result = await runRayCommand([rayCommand(), 'stop', '--force'], {
      asWorker: mode === 'node', workerAccount: privacy.worker_account, timeoutMs: 60000, onOutput,
    });
    if (!result.success) this._log(`ray stop returned exit code ${result.code}; verifying local Ray state anyway`, 'stderr');

    await _waitForLocalStop(config, 6000);

    if (_localRayRunning(config)) {
      this._log('Ray processes still present after ray stop; running local cleanup fallback', 'stderr');
      const killed = await _killLocalRayProcesses();
      this._log(`Fallback cleanup signalled ${killed} local Ray process(es)`);
      await _waitForLocalStop(config, 5000);
    }

    const remaining = _localRayProcesses();
    if (remaining.length > 0) {
      this.state = 'error';
      this.message = `Ray stop incomplete: ${remaining.length} local Ray process(es) still running`;
      this._log(this.message, 'stderr');
    } else {
      this.state = 'stopped';
      this.message = 'Ray stopped';
    }

    if (panic) {
      config.node_policy.manual_override = 'panic';
      await save(config);
    }

    await appendAudit(makeAuditEvent(panic ? 'panic_stop' : 'cluster_stopped', this.message));
    return this.status(config);
  }

  async nodes(config) {
    return _fetchNodes(config);
  }

  async submitJob(config, job) {
    const submitter = (config.submitters || []).find((s) => s.id === job.submitter_id && !s.revoked);
    if (!submitter) throw new Error('Unknown or revoked submitter ID');

    if (config.privacy.require_runtime_working_dir) {
      const env = job.runtime_env || {};
      if (!env.working_dir && !job.working_dir) throw new Error('working_dir is required in runtime_env');
    }

    const runtimeEnv = { ...(job.runtime_env || {}), working_dir: job.working_dir };

    const dashUrl = `http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}`;
    const body = JSON.stringify({
      entrypoint: job.entrypoint,
      runtime_env: runtimeEnv,
      metadata: {
        ...(job.metadata || {}),
        raylab_submitter_id: submitter.id,
        raylab_submitter_name: submitter.name,
      },
    });

    const jobId = await new Promise((resolve, reject) => {
      const http = require('http');
      const options = {
        hostname: config.coordinator.head_host,
        port: config.coordinator.dashboard_port,
        path: '/api/jobs/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.job_id || parsed.submission_id || 'unknown');
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Job submission timed out')); });
      req.write(body);
      req.end();
    });

    await appendAudit(makeAuditEvent('job_submitted', `Job ${jobId} submitted by ${submitter.name}`));
    return { job_id: jobId, status: 'submitted', message: 'Job submitted' };
  }

  async killJob(config, jobId) {
    const http = require('http');
    await new Promise((resolve, reject) => {
      const options = {
        hostname: config.coordinator.head_host,
        port: config.coordinator.dashboard_port,
        path: `/api/jobs/${jobId}/stop`,
        method: 'POST',
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Kill request timed out')); });
      req.end();
    });
    await appendAudit(makeAuditEvent('job_killed', `Kill requested for job ${jobId}`));
    return { job_id: jobId, status: 'killed', message: 'Job kill requested' };
  }
}

// ─── Ray command builders ─────────────────────────────────────────────────────

function _headCommand(config) {
  const coord = config.coordinator;
  const caps = config.resource_caps;
  const rayDirs = _ensureRayDataDirs();
  const cmd = [
    rayCommand(), 'start',
    '--port', String(coord.ray_port),
    '--dashboard-host', coord.dashboard_host,
    '--dashboard-port', String(coord.dashboard_port),
    '--ray-client-server-port', String(coord.client_port),
    '--node-manager-port', String(coord.node_manager_port),
    '--object-manager-port', String(coord.object_manager_port),
    '--temp-dir', rayDirs.tempDir,
    '--object-spilling-directory', rayDirs.spillDir,
    '--min-worker-port', '20000',
    '--max-worker-port', '29999',
    '--num-cpus', String(Math.floor(caps.cpus)),
    '--num-gpus', String(Math.floor(caps.gpus)),
    '--memory', String(Math.floor(caps.memory_gb * 1024 * 1024 * 1024)),
    '--resources', JSON.stringify({ raylab_max_jobs: caps.max_concurrent_jobs }),
  ];

  const configuredNodeIp = _normalizeIpLiteral(coord.node_ip_address);
  const nodeIp = configuredNodeIp && _isLocalIp(configuredNodeIp)
    ? configuredNodeIp
    : (coord.allow_external_workers ? _detectLanIp() : null);
  if (nodeIp) cmd.splice(2, 0, '--node-ip-address', nodeIp, '--head');
  else cmd.splice(2, 0, '--head');

  return cmd;
}

function _nodeCommand(config) {
  const coord = config.coordinator;
  const caps = config.resource_caps;
  const rayDirs = _ensureRayDataDirs();
  const cmd = [
    rayCommand(), 'start',
    '--address', `${coord.head_host}:${coord.ray_port}`,
    '--node-manager-port', String(coord.node_manager_port),
    '--object-manager-port', String(coord.object_manager_port),
    '--temp-dir', rayDirs.tempDir,
    '--object-spilling-directory', rayDirs.spillDir,
    '--min-worker-port', '20000',
    '--max-worker-port', '29999',
    '--num-cpus', String(Math.floor(caps.cpus)),
    '--num-gpus', String(Math.floor(caps.gpus)),
    '--memory', String(Math.floor(caps.memory_gb * 1024 * 1024 * 1024)),
    '--resources', JSON.stringify({ raylab_max_jobs: caps.max_concurrent_jobs }),
  ];

  const nodeIp = _detectNodeIpForHead(coord.head_host) || _detectLanIp();
  if (nodeIp) cmd.splice(2, 0, '--node-ip-address', nodeIp);
  return cmd;
}

function _appendNoProxy(current, hosts) {
  const parts = String(current || '').split(',').map((p) => p.trim()).filter(Boolean);
  for (const host of hosts) {
    if (!parts.some((p) => p.toLowerCase() === host.toLowerCase())) parts.push(host);
  }
  return parts.join(',');
}

function _detectNodeIpForHead(headHost) {
  const host = _normalizeIpLiteral(headHost);
  if (!host) return null;
  const routed = _detectRouteSourceIp(host);
  if (routed) return routed;
  const sameSubnet = _detectSameSubnetIp(host);
  if (sameSubnet) return sameSubnet;
  return null;
}

function _detectRouteSourceIp(host) {
  try {
    if (process.platform === 'win32') {
      const ps = `$ErrorActionPreference='SilentlyContinue'; $route = Get-NetRoute -RemoteIPAddress '${_psSingleQuote(host)}' -AddressFamily IPv4 | Sort-Object RouteMetric,InterfaceMetric | Select-Object -First 1; if ($route) { Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress }`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 4000, encoding: 'utf8', windowsHide: true });
      return _normalizeIpLiteral((r.stdout || '').trim().split(/\s+/)[0]);
    }
    if (process.platform === 'darwin') {
      const route = spawnSync('/sbin/route', ['-n', 'get', host], { timeout: 3000, encoding: 'utf8' });
      const iface = (route.stdout || '').match(/interface:\s*(\S+)/)?.[1];
      if (!iface) return null;
      const ip = spawnSync('/usr/sbin/ipconfig', ['getifaddr', iface], { timeout: 2000, encoding: 'utf8' });
      return _normalizeIpLiteral((ip.stdout || '').trim());
    }
    const route = spawnSync('ip', ['-4', 'route', 'get', host], { timeout: 3000, encoding: 'utf8' });
    return _normalizeIpLiteral((route.stdout || '').match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/)?.[1]);
  } catch (_) {
    return null;
  }
}

function _detectSameSubnetIp(host) {
  const prefix = host.match(/^(\d+\.\d+\.\d+)\./)?.[1];
  if (!prefix) return null;
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const iface of entries || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith(`${prefix}.`)) return iface.address;
    }
  }
  return null;
}

function _normalizeIpLiteral(value) {
  const text = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(text)) return null;
  if (text.startsWith('169.254.')) return null;
  return text;
}

function _psSingleQuote(value) {
  return String(value || '').replace(/'/g, "''");
}

function _ensureRayDataDirs() {
  const root = process.platform === 'darwin'
    ? '/Users/Shared/RayLab/ray'
    : path.join(configDir(), 'ray');
  const tempDir = path.join(root, 'tmp');
  const spillDir = path.join(root, 'spill');
  for (const dir of [root, tempDir, spillDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (process.platform !== 'win32') fs.chmodSync(dir, 0o777);
    } catch (_) {}
  }
  return { tempDir, spillDir };
}

function _detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip = iface.address;
        if (ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) {
          return ip;
        }
      }
    }
  }
  return null;
}

module.exports = { RayController };
