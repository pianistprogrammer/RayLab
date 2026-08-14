'use strict';

const crypto = require('crypto');
const { load, save, appendAudit, makeAuditEvent, getSecret, setSecret, getOrCreateToken } = require('./storage');
const { ensureRayRuntime, hasCompatibleRay, PINNED_RAY_VERSION, rayVersion, pythonVersion, resolvedRayExecutable } = require('./bootstrap');
const { RayController } = require('./ray_control');
const { RayInstaller } = require('./installer');
const { SetupRunner } = require('./setup_runner');
const { diagnostics } = require('./diagnostics');
const { detectHardware } = require('./hardware');
const { discoverCoordinators } = require('./discovery');
const { createWorkerAccount } = require('./worker_account');
const { installDocker } = require('./docker_installer');

// Module-level singletons — shared state across all IPC calls.
const controller = new RayController();
const installer = new RayInstaller();
const setupRunner = new SetupRunner();

// ─── Config helpers ───────────────────────────────────────────────────────────

function coordinatorProps(config) {
  const c = config.coordinator;
  return {
    ray_address: `${c.head_host}:${c.ray_port}`,
    dashboard_url: `http://${c.head_host}:${c.dashboard_port}`,
  };
}

function sanitizeConfig(config) {
  // Always force worker_account to the expected value.
  if (config.privacy) config.privacy.worker_account = 'raylab-worker';
  if (config.privacy) config.privacy.container_runtime = 'docker';
  return config;
}

// ─── Health ───────────────────────────────────────────────────────────────────

function handleHealth() {
  const rayExe = resolvedRayExecutable();
  const rv = rayExe ? rayVersion(rayExe) : null;
  return {
    ok: true,
    version: '0.1.0',
    ray_available: !!rv,
    ray_version: rv || null,
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

function handleGetConfig() {
  return load();
}

async function handleSaveConfig(args) {
  const current = load();
  const next = sanitizeConfig({ ...current, ...args });

  // Block mode switch while Ray is running.
  if (
    current.app_mode !== 'unconfigured' &&
    next.app_mode !== current.app_mode &&
    controller.state !== 'stopped' &&
    controller.state !== 'error'
  ) {
    throw new Error('Stop Ray before switching Host/Join mode.');
  }

  // Auto-detect LAN IP for external workers if coordinator is on loopback.
  if (
    next.app_mode === 'coordinator' &&
    next.coordinator.allow_external_workers &&
    _isLoopbackHost(next.coordinator.head_host)
  ) {
    const { detectLanIp } = require('./discovery');
    const lanIp = detectLanIp();
    if (lanIp) {
      next.coordinator.head_host = lanIp;
      if (!next.coordinator.node_ip_address) next.coordinator.node_ip_address = lanIp;
    }
  }

  await save(next);
  await appendAudit(makeAuditEvent('config_updated', `Configuration saved for ${next.app_mode} mode`));
  return load();
}

// ─── Cluster ──────────────────────────────────────────────────────────────────

async function handleClusterStatus() {
  const config = load();
  return controller.status(config);
}

async function handleClusterStart() {
  const config = load();
  return controller.start(config, { ensureRayRuntime });
}

async function handleClusterPortConflicts() {
  const config = load();
  return controller.portConflicts(config);
}

async function handleClusterClearPortConflicts() {
  const config = load();
  return controller.clearPortConflicts(config);
}

async function handleClusterStop() {
  const config = load();
  return controller.stop(config, { panic: false });
}

async function handleClusterPanic() {
  const config = load();
  return controller.stop(config, { panic: true });
}

// ─── Terminal logs ────────────────────────────────────────────────────────────

function handleTerminalLogs() {
  return [...controller.terminalLogs(), ...setupRunner.terminalLogs()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-500);
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

async function handleDiagnostics() {
  const config = load();
  return diagnostics(config);
}

// ─── Hardware ────────────────────────────────────────────────────────────────

async function handleHardware() {
  return detectHardware();
}

// ─── Discovery ────────────────────────────────────────────────────────────────

async function handleDiscoveryCoordinators() {
  const config = load();
  return discoverCoordinators(config, 600);
}

// ─── Ray install ──────────────────────────────────────────────────────────────

function handleRayInstallStatus() {
  return installer.status();
}

function handleInstallRay() {
  return installer.start();
}

// ─── Setup runner ─────────────────────────────────────────────────────────────

function handleSetupStatus() {
  return setupRunner.status();
}

function handleRunSetup() {
  return setupRunner.start(() => load());
}

async function handleCreateWorkerAccount() {
  const config = load();
  const account = config.privacy?.worker_account || 'raylab-worker';
  setupRunner.logMessage(`Dedicated worker account: creating ${account}...`);
  try {
    const result = await createWorkerAccount(account);
    setupRunner.markWorkerAccountReady(result.message);
    return result;
  } catch (err) {
    setupRunner.logMessage(`Dedicated worker account: failed - ${err.message || String(err)}`, 'stderr');
    throw err;
  }
}

async function handleInstallDocker() {
  setupRunner.logMessage('Docker runtime: installing Docker...');
  try {
    const result = await installDocker((line) => setupRunner.logMessage(line));
    setupRunner.logMessage(`Docker runtime: ${result.message}`);
    return result;
  } catch (err) {
    setupRunner.logMessage(`Docker runtime: failed - ${err.message || String(err)}`, 'stderr');
    throw err;
  }
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

async function handleNodes() {
  const config = load();
  return controller.nodes(config);
}

// ─── Audit ────────────────────────────────────────────────────────────────────

function handleAudit() {
  return load().audit || [];
}

// ─── Submitters ───────────────────────────────────────────────────────────────

async function handleCreateSubmitter({ name }) {
  if (!name || !name.trim()) throw new Error('Submitter name is required');
  const config = load();
  const id = crypto.randomUUID();
  const tokenRef = `raylab.submitter.${crypto.randomUUID()}`;
  const token = await getOrCreateToken(tokenRef, 32);
  const submitter = {
    id,
    name: name.trim(),
    token_ref: tokenRef,
    revoked: false,
    created_at: new Date().toISOString(),
  };
  config.submitters = [...(config.submitters || []), submitter];
  await save(config);
  return { ...submitter, token };
}

async function handleRevokeSubmitter({ id }) {
  const config = load();
  const submitter = (config.submitters || []).find((s) => s.id === id);
  if (!submitter) throw new Error(`Submitter ${id} not found`);
  submitter.revoked = true;
  await save(config);
  return load();
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

async function handleSubmitJob(args) {
  const config = load();
  return controller.submitJob(config, args);
}

async function handleKillJob({ id }) {
  const config = load();
  return controller.killJob(config, id);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function _isLoopbackHost(host) {
  return !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ─── Registration ─────────────────────────────────────────────────────────────

function registerHandlers(ipcMain) {
  const wrap = (fn) => async (_event, args) => {
    try {
      return await fn(args);
    } catch (err) {
      // Throw so Electron serialises it as a rejected promise on the renderer side.
      throw new Error(err.message || String(err));
    }
  };

  ipcMain.handle('health',                 wrap(handleHealth));
  ipcMain.handle('get_config',             wrap(handleGetConfig));
  ipcMain.handle('save_config',            wrap(handleSaveConfig));
  ipcMain.handle('cluster_status',         wrap(handleClusterStatus));
  ipcMain.handle('cluster_start',          wrap(handleClusterStart));
  ipcMain.handle('cluster_port_conflicts', wrap(handleClusterPortConflicts));
  ipcMain.handle('cluster_clear_port_conflicts', wrap(handleClusterClearPortConflicts));
  ipcMain.handle('cluster_stop',           wrap(handleClusterStop));
  ipcMain.handle('cluster_panic',          wrap(handleClusterPanic));
  ipcMain.handle('terminal_logs',          wrap(handleTerminalLogs));
  ipcMain.handle('diagnostics',            wrap(handleDiagnostics));
  ipcMain.handle('hardware',               wrap(handleHardware));
  ipcMain.handle('discovery_coordinators', wrap(handleDiscoveryCoordinators));
  ipcMain.handle('ray_install_status',     wrap(handleRayInstallStatus));
  ipcMain.handle('install_ray',            wrap(handleInstallRay));
  ipcMain.handle('setup_status',           wrap(handleSetupStatus));
  ipcMain.handle('run_setup',              wrap(handleRunSetup));
  ipcMain.handle('create_worker_account',  wrap(handleCreateWorkerAccount));
  ipcMain.handle('install_docker',         wrap(handleInstallDocker));
  ipcMain.handle('nodes',                  wrap(handleNodes));
  ipcMain.handle('audit',                  wrap(handleAudit));
  ipcMain.handle('create_submitter',       wrap(handleCreateSubmitter));
  ipcMain.handle('revoke_submitter',       wrap(handleRevokeSubmitter));
  ipcMain.handle('submit_job',             wrap(handleSubmitJob));
  ipcMain.handle('kill_job',               wrap(handleKillJob));
}

module.exports = { registerHandlers };
