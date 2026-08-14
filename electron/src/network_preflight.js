'use strict';

const http = require('http');
const http2 = require('http2');
const net = require('net');

const DEFAULT_PREFLIGHT_PORT = 18075;
const DEFAULT_TIMEOUT_MS = 4500;
const TASK_PORT_SAMPLE = 20000;

let preflightServer = null;
let preflightServerPort = null;
let preflightServerStarting = null;
let preflightServerConfig = null;

function preflightPort(config) {
  const port = Number(config?.coordinator?.preflight_port || DEFAULT_PREFLIGHT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PREFLIGHT_PORT;
}

async function ensureCoordinatorPreflightServer(config, onLog) {
  if (!config || config.app_mode !== 'coordinator') return { running: false, port: preflightPort(config), message: 'Coordinator preflight endpoint is disabled outside coordinator mode' };
  preflightServerConfig = config;
  const port = preflightPort(config);
  if (preflightServer && preflightServer.listening && preflightServerPort === port) {
    return { running: true, port, message: `Coordinator preflight endpoint listening on TCP ${port}` };
  }
  if (preflightServerStarting) return preflightServerStarting;
  if (preflightServer) {
    try { preflightServer.close(); } catch (_) {}
    preflightServer = null;
  }

  preflightServerStarting = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void _handlePreflightRequest(req, res);
    });
    server.on('error', (err) => {
      preflightServerStarting = null;
      const message = `Coordinator preflight endpoint could not bind TCP ${port}: ${err.message}`;
      onLog?.(message);
      reject(new Error(message));
    });
    server.listen(port, '0.0.0.0', () => {
      preflightServer = server;
      preflightServerPort = port;
      preflightServerStarting = null;
      const message = `Coordinator preflight endpoint listening on TCP ${port}`;
      onLog?.(message);
      resolve({ running: true, port, message });
    });
  });

  return preflightServerStarting;
}

async function runWorkerCallbackPreflight(config, onLog) {
  const coord = config?.coordinator || {};
  if (config?.app_mode !== 'node') {
    return { ok: true, status: 'pass', summary: 'Network preflight is only required on worker nodes', checks: [] };
  }

  const endpointPort = preflightPort(config);
  const endpoint = `${coord.head_host}:${endpointPort}`;
  onLog?.(`Network preflight: testing coordinator callback path through ${endpoint}`);

  const checks = [];
  for (const def of callbackPortChecks(config)) {
    checks.push(await _runWorkerPortCheck(config, def, endpointPort, onLog));
  }

  const ok = checks.every((check) => check.status === 'pass');
  const summary = ok
    ? 'Bidirectional network check passed'
    : 'Bidirectional network blocked: the coordinator cannot reach this worker on at least one Ray callback port';
  return { ok, status: ok ? 'pass' : 'fail', summary, endpoint, checks };
}

async function runCoordinatorDialTest({ host, port, timeoutMs } = {}) {
  const targetHost = normalizeRemoteHost(host);
  const targetPort = Number(port);
  const timeout = _timeout(timeoutMs);
  if (!targetHost || !_isPrivateOrLoopback(targetHost)) return { ok: false, host: targetHost, port: targetPort, error: 'Target host must be a private LAN address' };
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort >= 65536) return { ok: false, host: targetHost, port: targetPort, error: 'Invalid TCP port' };
  const result = await dialHttp2(targetHost, targetPort, timeout);
  return { ok: result.ok, host: targetHost, port: targetPort, error: result.error || null };
}

function callbackPortChecks(config) {
  const coord = config?.coordinator || {};
  const defs = [
    { id: 'node_manager', label: 'Ray node manager', port: Number(coord.node_manager_port) },
    { id: 'object_manager', label: 'Ray object manager', port: Number(coord.object_manager_port) },
    { id: 'worker_task', label: 'Ray worker task port', port: TASK_PORT_SAMPLE },
  ];
  const seen = new Set();
  return defs.filter((def) => {
    if (!Number.isInteger(def.port) || def.port <= 0 || def.port >= 65536) return false;
    if (seen.has(def.port)) return false;
    seen.add(def.port);
    return true;
  });
}

function formatPreflightFailure(result) {
  const failed = (result?.checks || []).filter((check) => check.status !== 'pass');
  const ports = failed.map((check) => `${check.port}`).join(', ');
  const first = failed[0];
  return [
    'Bidirectional HTTP/2 network blocked.',
    ports ? `The coordinator cannot complete a Ray-style HTTP/2 callback to this worker on TCP ${ports}.` : 'The coordinator could not complete the callback test.',
    first?.detail || result?.summary || 'Ray workers require coordinator-to-worker TCP callbacks for heartbeats and scheduling.',
    'Fix: allow inbound TCP on the worker for RayLab ports 18076, 18077, and 20000-29999, set the network profile to Private/Trusted, or disable router AP/client isolation.',
  ].join(' ');
}

function dialTcp(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ ok, error });
    };
    sock.setTimeout(_timeout(timeoutMs));
    sock.once('connect', () => finish(true));
    sock.once('error', (err) => finish(false, err.message || String(err)));
    sock.once('timeout', () => finish(false, 'Connection timed out'));
    try {
      sock.connect(Number(port), host);
    } catch (err) {
      finish(false, err.message || String(err));
    }
  });
}

function dialHttp2(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let session = null;
    let stream = null;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (stream) stream.close(); } catch (_) {}
      try { if (session) session.close(); } catch (_) {}
      try { if (session) session.destroy(); } catch (_) {}
      resolve({ ok, error });
    };
    const timer = setTimeout(() => finish(false, 'HTTP/2 preflight timed out'), _timeout(timeoutMs));

    try {
      session = http2.connect(`http://${host}:${Number(port)}`);
      session.once('error', (err) => finish(false, err.message || String(err)));
      session.once('connect', () => {
        try {
          stream = session.request({
            ':method': 'POST',
            ':path': '/raylab-preflight-grpc',
            'content-type': 'application/grpc',
            te: 'trailers',
          });
          let grpcStatus = null;
          let httpStatus = null;
          stream.setEncoding('utf8');
          stream.on('response', (headers) => {
            httpStatus = Number(headers[':status']);
            grpcStatus = headers['grpc-status'] != null ? String(headers['grpc-status']) : null;
          });
          stream.on('trailers', (headers) => {
            if (headers['grpc-status'] != null) grpcStatus = String(headers['grpc-status']);
          });
          stream.on('data', () => {});
          stream.once('error', (err) => finish(false, err.message || String(err)));
          stream.once('end', () => {
            if (httpStatus === 200 && (grpcStatus === null || grpcStatus === '0')) finish(true);
            else finish(false, `HTTP/2 response status ${httpStatus || 'unknown'}, grpc-status ${grpcStatus || 'missing'}`);
          });
          stream.end(Buffer.alloc(0));
        } catch (err) {
          finish(false, err.message || String(err));
        }
      });
    } catch (err) {
      finish(false, err.message || String(err));
    }
  });
}

async function _runWorkerPortCheck(config, def, endpointPort, onLog) {
  const server = http2.createServer();
  server.on('session', (session) => { session.on('error', () => {}); });
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    if (headers[':path'] !== '/raylab-preflight-grpc') {
      stream.respond({ ':status': 404, 'content-type': 'application/grpc', 'grpc-status': '12' });
      stream.end();
      return;
    }
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' });
    stream.end(Buffer.alloc(0));
  });

  try {
    await _listen(server, def.port);
  } catch (err) {
    const detail = `Cannot open temporary listener on TCP ${def.port}: ${err.message || String(err)}`;
    onLog?.(`Network preflight: ${def.label} failed - ${detail}`);
    return _check(def, 'fail', detail, 'Stop the local process using this port, then retry setup.');
  }

  onLog?.(`Network preflight: worker listening temporarily with HTTP/2 on TCP ${def.port}`);
  try {
    const result = await _requestCoordinatorDial(config.coordinator.head_host, endpointPort, def.port, DEFAULT_TIMEOUT_MS, 'h2c');
    if (result.ok) {
      const detail = `Coordinator completed HTTP/2 callback to this worker on TCP ${def.port}`;
      onLog?.(`Network preflight: ${def.label} passed - ${detail}`);
      return _check(def, 'pass', detail, null);
    }
    const detail = result.error || `Coordinator could not reach this worker on TCP ${def.port}`;
    onLog?.(`Network preflight: ${def.label} failed - ${detail}`);
    return _check(def, 'fail', detail, 'Allow inbound TCP from the coordinator/local subnet or disable AP/client isolation on the router.');
  } finally {
    await _closeServer(server);
  }
}

function _listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
}

function _closeServer(server) {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function _requestCoordinatorDial(host, endpointPort, workerPort, timeoutMs, protocol = 'h2c') {
  return new Promise((resolve) => {
    const body = JSON.stringify({ port: workerPort, timeoutMs, protocol });
    const req = http.request({
      hostname: host,
      port: endpointPort,
      path: '/preflight/dial',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs + 2500,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else resolve({ ok: false, error: parsed.error || `Coordinator preflight endpoint returned HTTP ${res.statusCode}` });
        } catch (err) {
          resolve({ ok: false, error: `Invalid coordinator preflight response: ${err.message}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: `Coordinator preflight endpoint unavailable at ${host}:${endpointPort} (${err.message})` }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `Coordinator preflight endpoint timed out at ${host}:${endpointPort}` }); });
    req.write(body);
    req.end();
  });
}

async function _handlePreflightRequest(req, res) {
  if (req.method !== 'POST' || req.url !== '/preflight/dial') {
    _json(res, 404, { ok: false, error: 'Not found' });
    return;
  }
  try {
    const body = await _readJson(req);
    const remoteHost = normalizeRemoteHost(req.socket.remoteAddress);
    const requestedHost = normalizeRemoteHost(body.host);
    const host = requestedHost && _isPrivateOrLoopback(requestedHost) ? requestedHost : remoteHost;
    const port = Number(body.port);
    const timeoutMs = _timeout(body.timeoutMs);

    if (!host || !_isPrivateOrLoopback(host)) {
      _json(res, 400, { ok: false, error: 'Preflight target must be a private LAN address' });
      return;
    }
    if (!_isAllowedCallbackPort(preflightServerConfig, port)) {
      _json(res, 400, { ok: false, error: `TCP ${port} is not a RayLab callback port` });
      return;
    }

    const protocol = body.protocol === 'tcp' ? 'tcp' : 'h2c';
    const result = protocol === 'tcp'
      ? await dialTcp(host, port, timeoutMs)
      : await dialHttp2(host, port, timeoutMs);
    _json(res, 200, { ok: result.ok, host, port, error: result.error || null });
  } catch (err) {
    _json(res, 400, { ok: false, error: err.message || String(err) });
  }
}

function _readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) reject(new Error('Preflight request too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function _json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeRemoteHost(host) {
  if (!host) return null;
  const clean = String(host).trim();
  if (clean.startsWith('::ffff:')) return clean.slice('::ffff:'.length);
  if (clean === '::1') return '127.0.0.1';
  return clean;
}

function _isAllowedCallbackPort(config, port) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return false;
  const coord = config?.coordinator || {};
  const exact = [coord.node_manager_port, coord.object_manager_port].map(Number);
  if (exact.includes(port)) return true;
  return port >= 20000 && port <= 29999;
}

function _isPrivateOrLoopback(host) {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
  const match = host.match(/^172\.(\d+)\./);
  return !!(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function _timeout(value) {
  const n = Number(value) || DEFAULT_TIMEOUT_MS;
  return Math.max(500, Math.min(15000, n));
}

function _check(def, status, detail, fix) {
  return {
    id: def.id,
    label: def.label,
    protocol: 'tcp',
    transport: 'h2c',
    direction: 'coordinator_to_worker',
    port: def.port,
    status,
    detail,
    fix,
  };
}

module.exports = {
  DEFAULT_PREFLIGHT_PORT,
  TASK_PORT_SAMPLE,
  callbackPortChecks,
  dialTcp,
  ensureCoordinatorPreflightServer,
  formatPreflightFailure,
  preflightPort,
  runCoordinatorDialTest,
  runWorkerCallbackPreflight,
};
