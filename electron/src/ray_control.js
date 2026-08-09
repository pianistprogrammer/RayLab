'use strict';

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const { rayCommand, subprocessEnv, which } = require('./bootstrap');
const { diagnostics, isPortReachable } = require('./diagnostics');
const { appendAudit, makeAuditEvent, load, save } = require('./storage');

// ─── Constants ────────────────────────────────────────────────────────────────

const RAY_PROCESS_NAMES = new Set(['raylet', 'gcs_server', 'plasma_store_server', 'dashboard', 'runtime_env_agent', 'log_monitor']);
const RAY_PROCESS_MARKERS = ['/raylet', 'gcs_server', 'plasma_store_server', 'dashboard.py', 'runtime_env_agent', 'log_monitor.py', 'monitor.py', 'ray::'];
const SENSITIVE_FLAGS = new Set(['--redis-password', '--token']);
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

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
    sock.connect(port, host === 'localhost' ? '127.0.0.1' : host);
  });
}

// ─── Process detection ────────────────────────────────────────────────────────

function _psCommandLines() {
  try {
    const r = spawnSync('ps', ['axww', '-o', 'command='], { timeout: 2000, encoding: 'utf8' });
    if (r.status !== 0) return [];
    return r.stdout.split('\n').map((l) => l.toLowerCase());
  } catch (_) { return []; }
}

function _isRayLine(line) {
  return RAY_PROCESS_MARKERS.some((m) => line.includes(m.toLowerCase()));
}

function _isIgnoredLine(line) {
  return line.includes('ray status') || line.includes('ray stop') || line.includes('ray start')
    || line.includes('grep ') || line.includes('ssh ') || line.includes('sshd ')
    || line.includes('raylab-sidecar') || line.includes('electron ');
}

function _localRayProcesses() {
  const lines = _psCommandLines();
  return lines.filter((l) => !_isIgnoredLine(l) && _isRayLine(l));
}

function _localRayRunning(config) {
  return _localRayProcesses().length > 0;
}

function _psHasRaylet(config) {
  const addr = `${config.coordinator.head_host}:${config.coordinator.ray_port}`;
  return _psCommandLines().some((l) =>
    l.includes('/site-packages/ray/core/src/ray/raylet/raylet') &&
    l.includes(`--gcs-address=${addr}`) &&
    !_isIgnoredLine(l)
  );
}

function _psHasHead(config) {
  const host = config.coordinator.head_host;
  return _psCommandLines().some((l) => {
    if (_isIgnoredLine(l)) return false;
    return l.includes('gcs_server') || (l.includes('/raylet') && (l.includes(`--node_ip_address=${host}`) || l.includes(`--node-ip-address=${host}`)));
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
  const procs = _localRayProcesses();
  if (procs.length === 0) return 0;
  // We don't have PIDs from ps -o command= output, so run ray stop --force as fallback.
  // Actual process kill is handled by ray stop; this is an emergency fallback.
  try {
    spawnSync(rayCommand(), ['stop', '--force'], { timeout: 10000, env: subprocessEnv() });
  } catch (_) {}
  return procs.length;
}

async function _killWorkerRayProcesses(workerAccount) {
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
  const mode = config.app_mode;
  if (mode !== 'coordinator') return;
  const coord = config.coordinator;
  const ports = [
    { host: coord.node_ip_address || coord.head_host, port: coord.ray_port, name: 'Ray head' },
    { host: coord.dashboard_host, port: coord.dashboard_port, name: 'Ray dashboard' },
    { host: coord.node_ip_address || coord.head_host, port: coord.client_port, name: 'Ray client' },
  ];
  const conflicts = [];
  for (const { host, port, name } of ports) {
    const open = await tcpOpen(host, port, 250);
    if (open) conflicts.push(`${name} port ${port}`);
  }
  if (conflicts.length === 0) return;
  throw new Error(`Port conflict: ${conflicts.join(', ')} already in use. Stop the conflicting process and try again.`);
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
      const key = n.hostname || n.node_id;
      const rank = n.state === 'alive' ? 0 : n.state === 'dead' ? 2 : 1;
      if (!seen.has(key) || rank < seen.get(key).rank) {
        seen.set(key, {
          rank,
          node: {
            node_id: n.node_id || '',
            hostname: n.hostname || n.node_id || '',
            status: n.state || 'unknown',
            owner: 'unknown',
            cpus_total: n.resources_total?.CPU || 0,
            gpus_total: n.resources_total?.GPU || 0,
            memory_total_gb: parseFloat(((n.resources_total?.memory || 0) / (1024 ** 3)).toFixed(2)),
            cpu_percent: 0,
            gpu_percent: 0,
            ram_percent: 0,
            last_seen: new Date().toISOString(),
          },
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.rank - b.rank).map((v) => v.node);
  } catch (_) {}

  // Strategy 2: legacy dashboard API
  try {
    const data = await fetchJson(`${dashUrl}/api/cluster_status`);
    const nodes = (data.data || {}).nodes || data.nodes || [];
    return nodes.map((n) => ({
      node_id: n.NodeID || n.node_id || '',
      hostname: n.NodeName || n.node_name || n.ip || '',
      status: n.State || n.status || 'unknown',
      owner: 'unknown',
      cpus_total: n.Resources?.CPU || n.CPU || 0,
      gpus_total: n.Resources?.GPU || n.GPU || 0,
      memory_total_gb: parseFloat((((n.Resources?.memory || n.memory || 0)) / (1024 ** 3)).toFixed(2)),
      cpu_percent: 0,
      gpu_percent: 0,
      ram_percent: 0,
      last_seen: new Date().toISOString(),
    }));
  } catch (_) {}

  return [];
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

  async status(config) {
    const mode = config.app_mode;
    const localRunning = mode !== 'unconfigured' ? _localRayRunning(config) : false;

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
  const cmd = [
    rayCommand(), 'start',
    '--port', String(coord.ray_port),
    '--dashboard-host', coord.dashboard_host,
    '--dashboard-port', String(coord.dashboard_port),
    '--ray-client-server-port', String(coord.client_port),
    '--min-worker-port', '20000',
    '--max-worker-port', '29999',
    '--num-cpus', String(Math.floor(caps.cpus)),
    '--num-gpus', String(Math.floor(caps.gpus)),
    '--memory', String(Math.floor(caps.memory_gb * 1024 * 1024 * 1024)),
    '--resources', JSON.stringify({ raylab_max_jobs: caps.max_concurrent_jobs }),
  ];

  const nodeIp = coord.node_ip_address || (coord.allow_external_workers ? _detectLanIp() : null);
  if (nodeIp) cmd.splice(2, 0, '--node-ip-address', nodeIp, '--head');
  else cmd.splice(2, 0, '--head');

  return cmd;
}

function _nodeCommand(config) {
  const coord = config.coordinator;
  const caps = config.resource_caps;
  return [
    rayCommand(), 'start',
    '--address', `${coord.head_host}:${coord.ray_port}`,
    '--min-worker-port', '20000',
    '--max-worker-port', '29999',
    '--num-cpus', String(Math.floor(caps.cpus)),
    '--num-gpus', String(Math.floor(caps.gpus)),
    '--memory', String(Math.floor(caps.memory_gb * 1024 * 1024 * 1024)),
    '--resources', JSON.stringify({ raylab_max_jobs: caps.max_concurrent_jobs }),
  ];
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
