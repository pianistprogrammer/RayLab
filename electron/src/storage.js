'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ─── Config directory ─────────────────────────────────────────────────────────

function configDir() {
  if (process.env.RAYLAB_CONFIG_DIR) return process.env.RAYLAB_CONFIG_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'raylab-cluster-manager');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'raylab-cluster-manager');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'raylab-cluster-manager');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

// ─── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  app_mode: 'unconfigured',
  coordinator: {
    head_host: '127.0.0.1',
    dashboard_host: '127.0.0.1',
    node_ip_address: '',
    ray_port: 6379,
    dashboard_port: 8265,
    client_port: 10001,
    node_manager_port: 18076,
    object_manager_port: 18077,
    preflight_port: 18075,
    cluster_token_ref: 'raylab.cluster_token',
    dashboard_token_ref: 'raylab.dashboard_token',
    bind_private_only: true,
    allow_external_workers: false,
  },
  node_policy: {
    master_enabled: false,
    manual_override: 'auto',
    schedule_enabled: false,
    schedule_windows: [],
    idle_only_enabled: false,
    idle_minutes: 10,
    max_cpu_percent_for_idle: 20,
    max_gpu_percent_for_idle: 10,
  },
  resource_caps: { cpus: 4, gpus: 1, memory_gb: 16, gpu_memory_gb: 12, max_concurrent_jobs: 1 },
  privacy: {
    worker_account: 'raylab-worker',
    worker_account_required: true,
    allow_home_access: false,
    require_runtime_working_dir: true,
    container_runtime: 'docker',
    require_gpu_container_runtime: true,
  },
  object_store: { endpoint_url: '', bucket: '', region: '', access_key_ref: 'raylab.object_store_access_key', secret_key_ref: 'raylab.object_store_secret_key' },
  submitters: [],
  audit: [],
};

// ─── ConfigStore ──────────────────────────────────────────────────────────────

// Simple async mutex — serialise all writes through a promise chain.
let _writeLock = Promise.resolve();

function withWriteLock(fn) {
  _writeLock = _writeLock.then(fn).catch(fn);
  return _writeLock;
}

function load(filePath) {
  const p = filePath || configPath();
  if (!fs.existsSync(p)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    // Deep-merge with defaults so new fields are always present.
    return normalizeConfig(deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), data));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function normalizeConfig(config) {
  const coord = config.coordinator || {};

  // Migrate the previous RayLab defaults. Those ports overlapped with too many
  // common local development services and were changed before public rollout.
  if (coord.node_manager_port === 8076) coord.node_manager_port = DEFAULT_CONFIG.coordinator.node_manager_port;
  if (coord.object_manager_port === 8077) coord.object_manager_port = DEFAULT_CONFIG.coordinator.object_manager_port;

  return config;
}

function save(config, filePath) {
  const p = filePath || configPath();
  return withWriteLock(() => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
    return config;
  });
}

function appendAudit(event, filePath) {
  return withWriteLock(() => {
    const p = filePath || configPath();
    const config = load(p);
    config.audit = [event, ...(config.audit || [])].slice(0, 1000);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
    return config;
  });
}

function makeAuditEvent(eventType, message, metadata = {}) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: eventType,
    actor: 'system',
    message,
    metadata,
  };
}

// ─── SecretStore ──────────────────────────────────────────────────────────────

const KEYRING_SERVICE = 'RayLabClusterManager';

function devSecretsPath() {
  return path.join(configDir(), 'dev-secrets.json');
}

function _readDevSecrets() {
  try {
    if (fs.existsSync(devSecretsPath())) {
      return JSON.parse(fs.readFileSync(devSecretsPath(), 'utf8'));
    }
  } catch (_) {}
  return {};
}

function _writeDevSecrets(secrets) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(devSecretsPath(), JSON.stringify(secrets, null, 2), 'utf8');
}

async function getSecret(ref) {
  try {
    const keytar = require('keytar');
    const val = await keytar.getPassword(KEYRING_SERVICE, ref);
    if (val !== null) return val;
  } catch (_) {}
  return _readDevSecrets()[ref] ?? null;
}

async function setSecret(ref, value) {
  try {
    const keytar = require('keytar');
    await keytar.setPassword(KEYRING_SERVICE, ref, value);
    return;
  } catch (_) {}
  const secrets = _readDevSecrets();
  secrets[ref] = value;
  _writeDevSecrets(secrets);
}

async function getOrCreateToken(ref, length = 48) {
  const existing = await getSecret(ref);
  if (existing) return existing;
  const token = crypto.randomBytes(length).toString('base64url').slice(0, length);
  await setSecret(ref, token);
  return token;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

module.exports = {
  configDir,
  configPath,
  load,
  save,
  appendAudit,
  makeAuditEvent,
  getSecret,
  setSecret,
  getOrCreateToken,
  DEFAULT_CONFIG,
};
