'use strict';

const net = require('net');
const os = require('os');
const { spawnSync } = require('child_process');
const { which } = require('./bootstrap');

const COMMON_RAY_PORTS = [6379, 6380, 6381, 6382, 6383, 6384, 6385];
const COMMON_DASHBOARD_PORTS = [8265, 8266, 8267, 8268, 8269, 8270];
const MAX_SCAN_HOSTS = 2048;
const MAX_SCAN_WORKERS = 64;

// ─── TCP probe ────────────────────────────────────────────────────────────────

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

function tcpOpenWithNc(host, port, timeoutMs) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const nc = fs.existsSync('/usr/bin/nc') ? '/usr/bin/nc' : (fs.existsSync('/bin/nc') ? '/bin/nc' : null);
  if (!nc) return Promise.resolve(false);
  try {
    const timeout = Math.max(1, Math.ceil(timeoutMs / 1000));
    const r = spawnSync(nc, ['-z', '-G', String(timeout), host, String(port)], { timeout: (timeout + 1) * 1000 });
    return Promise.resolve(r.status === 0);
  } catch (_) { return Promise.resolve(false); }
}

// ─── ARP cache ────────────────────────────────────────────────────────────────

function arpNeighborHosts() {
  const arpBin = ['/usr/sbin/arp', '/usr/bin/arp', '/sbin/arp'].find((p) => {
    try { return require('fs').existsSync(p); } catch (_) { return false; }
  });
  if (!arpBin) return new Set();
  try {
    const r = spawnSync(arpBin, ['-an'], { timeout: 1000, encoding: 'utf8' });
    if (r.status !== 0) return new Set();
    const hosts = new Set();
    for (const line of r.stdout.split('\n')) {
      const cleaned = line.replace(/[()]/g, ' ');
      for (const token of cleaned.split(/\s+/)) {
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(token)) {
          const ip = token;
          if (_isPrivateIp(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.')) {
            hosts.add(ip);
          }
        }
      }
    }
    return hosts;
  } catch (_) { return new Set(); }
}

// ─── Subnet enumeration ───────────────────────────────────────────────────────

function candidateHosts(configuredHost) {
  const hosts = new Set();
  if (configuredHost && !_isLoopbackHost(configuredHost)) hosts.add(configuredHost);

  // ARP neighbors
  for (const h of arpNeighborHosts()) hosts.add(h);

  // Subnet scan from network interfaces
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      if (!_isPrivateIp(ip) || ip.startsWith('169.254.')) continue;

      let prefix = _netmaskToPrefix(iface.netmask || '255.255.255.0');
      const hostCount = 2 ** (32 - prefix);
      if (hostCount > MAX_SCAN_HOSTS) prefix = 24;  // fall back to /24

      const base = _ipToInt(ip) & _prefixToMask(prefix < 24 ? 24 : prefix);
      const count = 2 ** (32 - (prefix < 24 ? 24 : prefix));
      for (let i = 1; i < count - 1 && hosts.size < MAX_SCAN_HOSTS; i++) {
        hosts.add(_intToIp(base + i));
      }
    }
  }

  return [...hosts].sort((a, b) => _ipToInt(a) - _ipToInt(b));
}

function priorityHosts(configuredHost) {
  const hosts = new Set();
  if (configuredHost && !_isLoopbackHost(configuredHost)) hosts.add(configuredHost);
  for (const h of arpNeighborHosts()) hosts.add(h);
  return [...hosts];
}

// ─── Host probing ─────────────────────────────────────────────────────────────

async function _probeHostPorts(host, rayPorts, dashPorts, timeoutMs, allowCliFallback = false) {
  let openRayPort = null;
  for (const port of rayPorts) {
    let open = await tcpOpen(host, port, timeoutMs);
    if (!open && allowCliFallback) open = await tcpOpenWithNc(host, port, timeoutMs);
    if (open) { openRayPort = port; break; }
  }
  if (!openRayPort) return null;

  let openDashPort = null;
  for (const port of dashPorts) {
    let open = await tcpOpen(host, port, timeoutMs);
    if (!open && allowCliFallback) open = await tcpOpenWithNc(host, port, timeoutMs);
    if (open) { openDashPort = port; break; }
  }

  const confidence = openDashPort ? 95 : 70;
  return {
    host,
    ray_port: openRayPort,
    dashboard_port: openDashPort,
    dashboard_url: openDashPort ? `http://${host}:${openDashPort}` : null,
    confidence,
    detail: openDashPort ? 'Ray head with dashboard found' : 'Ray head port found (no dashboard)',
  };
}

function _orderedPorts(configured, common) {
  const seen = new Set();
  const result = [];
  for (const p of [configured, ...common]) {
    if (p && !seen.has(p)) { seen.add(p); result.push(p); }
  }
  return result;
}

// ─── Concurrent batch probing ─────────────────────────────────────────────────

function _probeBatch(hosts, rayPorts, dashPorts, timeoutMs, allowCliFallback = false) {
  return new Promise((resolve) => {
    const results = [];
    let pending = hosts.length;
    if (pending === 0) { resolve([]); return; }

    const slots = Math.min(MAX_SCAN_WORKERS, hosts.length);
    let index = 0;

    function next() {
      if (index >= hosts.length) return;
      const host = hosts[index++];
      _probeHostPorts(host, rayPorts, dashPorts, timeoutMs, allowCliFallback)
        .then((r) => {
          if (r) results.push(r);
          pending--;
          if (pending === 0) resolve(results);
          else next();
        })
        .catch(() => {
          pending--;
          if (pending === 0) resolve(results);
          else next();
        });
    }

    for (let i = 0; i < slots; i++) next();
  });
}

// ─── Main discovery ───────────────────────────────────────────────────────────

async function discoverCoordinators(config, timeoutMs = 600) {
  const coord = config && config.coordinator;
  const configuredHost = coord && !_isLoopbackHost(coord.head_host) ? coord.head_host : null;
  const configuredRayPort = coord && coord.ray_port;
  const configuredDashPort = coord && coord.dashboard_port;

  const rayPorts = _orderedPorts(configuredRayPort, COMMON_RAY_PORTS);
  const dashPorts = _orderedPorts(configuredDashPort, COMMON_DASHBOARD_PORTS);

  const candidates = new Map();

  // Probe configured host first with generous timeout
  if (configuredHost) {
    const r = await _probeHostPorts(configuredHost, rayPorts, dashPorts, Math.max(timeoutMs, 1000), true);
    if (r) {
      r.confidence = Math.max(r.confidence, 98);
      r.detail = 'Saved coordinator address is reachable';
      candidates.set(configuredHost, r);
    }
  }

  // Priority hosts (ARP + configured)
  const priority = priorityHosts(configuredHost).filter((h) => !candidates.has(h));
  const priorityResults = await _probeBatch(priority, rayPorts, dashPorts, Math.max(timeoutMs, 1000), true);
  for (const r of priorityResults) candidates.set(r.host, r);

  // Full LAN scan (remaining)
  const allHosts = candidateHosts(configuredHost).filter((h) => !candidates.has(h));
  const scanResults = await _probeBatch(allHosts, rayPorts, dashPorts, timeoutMs, false);
  for (const r of scanResults) candidates.set(r.host, r);

  return [...candidates.values()]
    .sort((a, b) => b.confidence - a.confidence || a.host.localeCompare(b.host))
    .slice(0, 24);
}

// ─── LAN IP detection ─────────────────────────────────────────────────────────

function detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && _isPrivateIp(iface.address)) {
        return iface.address;
      }
    }
  }
  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function _isLoopbackHost(host) {
  if (!host) return true;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function _isPrivateIp(ip) {
  if (ip.startsWith('127.') || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && parseInt(m[1]) >= 16 && parseInt(m[1]) <= 31) return true;
  return false;
}

function _ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet), 0) >>> 0;
}

function _intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function _netmaskToPrefix(mask) {
  return mask.split('.').reduce((acc, o) => {
    let n = parseInt(o);
    let bits = 0;
    while (n) { bits += n & 1; n >>= 1; }
    return acc + bits;
  }, 0);
}

function _prefixToMask(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

const fs = require('fs');

module.exports = { discoverCoordinators, detectLanIp, priorityHosts, candidateHosts };
