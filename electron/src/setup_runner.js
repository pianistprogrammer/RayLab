'use strict';

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const { hasCompatibleRay, ensureRayRuntime, pythonVersion, rayVersion, PINNED_RAY_VERSION, PINNED_PYTHON, which } = require('./bootstrap');
const { configDir, save, appendAudit, makeAuditEvent } = require('./storage');
const { isPrivateHost, isPortAvailable, findAvailablePort, isCoordinatorReachable, hasWorkerAccount, hasWorkerLaunchPermission } = require('./diagnostics');

const SETUP_TASKS = [
  { id: 'python',         label: 'Python environment' },
  { id: 'ray',            label: 'Ray 2.56+' },
  { id: 'config_dir',     label: 'Local app storage' },
  { id: 'network',        label: 'Private coordinator address' },
  { id: 'ports',          label: 'Ray ports' },
  { id: 'worker_account', label: 'Dedicated worker account' },
  { id: 'container',      label: 'Container runtime' },
  { id: 'gpu_container',  label: 'GPU container runtime' },
  { id: 'object_store',   label: 'Lab object store' },
  { id: 'final',          label: 'Readiness' },
];

class SetupRunner {
  constructor() {
    this._status = {
      running: false,
      succeeded: null,
      can_continue: false,
      progress: 0,
      message: 'Not started',
      started_at: null,
      finished_at: null,
      tasks: SETUP_TASKS.map((t) => ({ ...t, status: 'pending', detail: 'Waiting', fix: null })),
    };
    this._running = false;
  }

  status() {
    return { ...this._status, tasks: this._status.tasks.map((t) => ({ ...t })) };
  }

  start(configLoader) {
    if (this._running) return this.status();
    this._running = true;
    this._status = {
      ...this._status,
      running: true,
      succeeded: null,
      can_continue: false,
      progress: 0,
      message: 'Running setup...',
      started_at: new Date().toISOString(),
      finished_at: null,
      tasks: SETUP_TASKS.map((t) => ({ ...t, status: 'pending', detail: 'Waiting', fix: null })),
    };
    this._run(configLoader).catch(() => {});
    return this.status();
  }

  _setTask(id, st, detail, fix = null) {
    const task = this._status.tasks.find((t) => t.id === id);
    if (task) { task.status = st; task.detail = detail; task.fix = fix; }
  }

  async _run(configLoader) {
    const tasks = this._status.tasks;
    let config = configLoader();

    const step = async (id, fn) => {
      this._setTask(id, 'running', 'Running...');
      this._status.progress = Math.floor((tasks.findIndex((t) => t.id === id) / tasks.length) * 100);
      try {
        const result = await fn();
        this._setTask(id, result.status, result.detail, result.fix || null);
        return result;
      } catch (err) {
        this._setTask(id, 'fail', err.message, null);
        return { status: 'fail', detail: err.message };
      }
    };

    // Step 1 — Python
    await step('python', async () => {
      const pv = pythonVersion();
      if (!pv) return { status: 'warn', detail: 'Could not determine Python version; venv will be created during Ray install', fix: null };
      return { status: 'pass', detail: `Python ${pv} is ready` };
    });

    // Step 2 — Ray
    const rayResult = await step('ray', async () => {
      if (hasCompatibleRay()) return { status: 'pass', detail: `Ray ${PINNED_RAY_VERSION} with Python ${PINNED_PYTHON} is ready` };
      const logTail = [];
      const onOutput = (line) => {
        logTail.push(line.slice(0, 240));
        if (logTail.length > 5) logTail.shift();
        this._setTask('ray', 'running', line.slice(0, 240));
      };
      const result = await ensureRayRuntime(onOutput);
      if (result.succeeded) return { status: 'pass', detail: result.message };
      return { status: 'fail', detail: result.message, fix: 'Run the installer again with network access or bundled wheels.' };
    });

    // Step 3 — Config dir
    await step('config_dir', async () => {
      const fs = require('fs');
      fs.mkdirSync(configDir(), { recursive: true });
      return { status: 'pass', detail: `App storage is ready at ${configDir()}` };
    });

    // Step 4 — Network
    await step('network', async () => {
      const ok = await isPrivateHost(config.coordinator.head_host);
      if (ok) return { status: 'pass', detail: `Coordinator host ${config.coordinator.head_host} is private` };
      return { status: 'fail', detail: `${config.coordinator.head_host} is not private`, fix: 'Set the head host to a private lab VLAN IP or DNS name.' };
    });

    // Step 5 — Ports
    await step('ports', async () => {
      const mode = config.app_mode;
      if (mode === 'node') {
        const reachable = await isCoordinatorReachable(config);
        if (reachable) return { status: 'pass', detail: `Coordinator reachable at ${config.coordinator.head_host}:${config.coordinator.ray_port}` };
        return { status: 'warn', detail: 'Coordinator not reachable yet', fix: 'Start the host in External workers mode or save the host machine\'s LAN IP address.' };
      }
      const coord = config.coordinator;
      const changes = [];
      const portDefs = [
        { field: 'ray_port', host: coord.head_host, preferred: 6380 },
        { field: 'dashboard_port', host: coord.dashboard_host, preferred: 8266 },
        { field: 'client_port', host: coord.head_host, preferred: 10002 },
      ];
      for (const def of portDefs) {
        const current = coord[def.field];
        const ok = await isPortAvailable(def.host, current);
        if (!ok) {
          const next = await findAvailablePort(def.host, Math.max(def.preferred, current + 1));
          changes.push(`${def.field}: ${current} → ${next}`);
          config.coordinator[def.field] = next;
        }
      }
      if (changes.length > 0) {
        await save(config);
        return { status: 'pass', detail: `Updated occupied ports: ${changes.join(', ')}` };
      }
      return { status: 'pass', detail: 'Required Ray ports are available' };
    });

    // Step 6 — Worker account
    const workerResult = await step('worker_account', async () => {
      const account = config.privacy.worker_account || 'raylab-worker';
      const mode = config.app_mode;
      const exists = hasWorkerAccount(account);
      const canLaunch = hasWorkerLaunchPermission(account);

      if (process.platform === 'darwin' && mode === 'coordinator') {
        return { status: 'warn', detail: 'macOS Coordinator/UI mode can continue; production GPU worker isolation is Windows/Linux only' };
      }
      if (exists && canLaunch) return { status: 'pass', detail: `Dedicated account ${account} is ready` };
      if (process.platform === 'darwin' && mode === 'node') {
        await _createMacosWorkerAccount(account);
        const nowExists = hasWorkerAccount(account);
        const nowCanLaunch = hasWorkerLaunchPermission(account);
        if (nowExists && nowCanLaunch) return { status: 'pass', detail: `Account ${account} created and configured` };
        return { status: 'fail', detail: `Account creation attempted but ${account} not fully configured`, fix: 'Approve the macOS administrator prompt when it appears.' };
      }
      if (process.platform === 'linux') {
        await _createLinuxWorkerAccount(account);
        if (hasWorkerAccount(account)) return { status: 'pass', detail: `Account ${account} created` };
        return { status: 'fail', detail: `Failed to create ${account} on Linux`, fix: 'Run as root or with sudo access.' };
      }
      return { status: 'fail', detail: `Account ${account} does not exist`, fix: 'Run the OS worker-account setup from docs/rollout.md' };
    });

    // Step 7 — Container
    const { containerRuntimeStatus } = require('./diagnostics');
    const runtime = config.privacy.container_runtime || 'docker';
    const containerResult = await step('container', async () => {
      const s = containerRuntimeStatus(runtime);
      if (s.ok) return { status: 'pass', detail: s.detail };
      return { status: 'fail', detail: s.detail, fix: 'Install Docker/Podman and configure it for the dedicated worker account.' };
    });

    // Step 8 — GPU container
    await step('gpu_container', async () => {
      if (containerResult.status === 'fail') return { status: 'warn', detail: 'Skipped (container runtime not available)' };
      const { gpuRuntimeStatus } = require('./diagnostics');
      const s = gpuRuntimeStatus(runtime);
      if (s.ok) return { status: 'pass', detail: s.detail };
      return { status: 'warn', detail: s.detail, fix: 'Install NVIDIA Container Toolkit or equivalent GPU support.' };
    });

    // Step 9 — Object store
    await step('object_store', async () => {
      const ok = !!(config.object_store.endpoint_url && config.object_store.bucket);
      if (ok) return { status: 'pass', detail: `${config.object_store.endpoint_url} / ${config.object_store.bucket}` };
      return { status: 'warn', detail: 'Object store is not configured yet', fix: 'Set endpoint and bucket before submitting real LLM/data jobs.' };
    });

    // Step 10 — Final readiness
    await step('final', async () => {
      const t = (id) => this._status.tasks.find((t) => t.id === id);
      const rayOk = t('ray').status === 'pass';
      const networkOk = t('network').status === 'pass';
      const workerOk = t('worker_account').status === 'pass';
      const coordinatorDevOk = config.app_mode === 'coordinator' && process.platform === 'darwin';
      const canContinue = rayOk && networkOk && (workerOk || coordinatorDevOk);
      const blocking = this._status.tasks.filter((t) => t.id !== 'final' && t.status === 'fail');
      if (blocking.length > 0 && !canContinue) {
        this._status.can_continue = false;
        return { status: 'fail', detail: `${blocking.length} blocking issue(s) must be resolved` };
      }
      this._status.can_continue = canContinue;
      return { status: canContinue ? 'pass' : 'warn', detail: canContinue ? 'System is ready to run Ray' : 'System can continue with limitations' };
    });

    this._status.progress = 100;
    const anyFail = this._status.tasks.some((t) => t.status === 'fail');
    this._status.succeeded = !anyFail;
    this._status.message = this._status.succeeded ? 'Setup complete' : 'Setup completed with issues';
    this._status.running = false;
    this._status.finished_at = new Date().toISOString();
    this._running = false;

    await appendAudit(makeAuditEvent('full_setup_finished', this._status.message, { succeeded: this._status.succeeded }));
  }
}

// ─── Worker account creation ──────────────────────────────────────────────────

async function _createMacosWorkerAccount(account) {
  const currentUser = os.userInfo().username;

  const shellScript = `
set -eu
ACCOUNT="${account}"
OWNER="${currentUser}"
if ! /usr/bin/id -u "$ACCOUNT" >/dev/null 2>&1; then
  UID_VALUE=$(/usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk '$2 >= 451 && $2 < 500 { used[$2]=1 } END { for (i=451; i<500; i++) if (!used[i]) { print i; exit } }')
  if [ -z "$UID_VALUE" ]; then
    UID_VALUE=$(/usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk 'BEGIN { max=500 } $2 > max { max=$2 } END { print max + 1 }')
  fi
  /usr/bin/dscl . -create "/Users/$ACCOUNT"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" UserShell /usr/bin/false
  /usr/bin/dscl . -create "/Users/$ACCOUNT" RealName "RayLab Worker"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" UniqueID "$UID_VALUE"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" PrimaryGroupID 20
  /usr/bin/dscl . -create "/Users/$ACCOUNT" NFSHomeDirectory "/var/lib/$ACCOUNT"
  /usr/bin/dscl . -create "/Users/$ACCOUNT" IsHidden 1
  /usr/bin/dscl . -passwd "/Users/$ACCOUNT" '*'
fi
/bin/mkdir -p "/var/lib/$ACCOUNT/jobs"
/usr/sbin/chown -R "$ACCOUNT":staff "/var/lib/$ACCOUNT"
/bin/chmod 755 "/var/lib/$ACCOUNT"
/bin/mkdir -p /private/etc/sudoers.d
SUDOERS="/private/etc/sudoers.d/raylab-$OWNER"
/bin/cat > "$SUDOERS" <<EOF
# RayLab: allow this desktop user to launch approved worker processes as the isolated worker account.
$OWNER ALL=($ACCOUNT) NOPASSWD: ALL
EOF
/bin/chmod 440 "$SUDOERS"
/usr/sbin/visudo -cf "$SUDOERS"
`.trim();

  // Escape for AppleScript
  const escaped = shellScript.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const prompt = `RayLab needs administrator permission to create a hidden local account named ${account}. Cluster jobs will run as this account instead of your personal macOS user.`;
  const appleScript = `do shell script "${escaped}" with administrator privileges with prompt "${prompt}"`;

  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-e', appleScript], { timeout: 300000 });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`osascript exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

async function _createLinuxWorkerAccount(account) {
  return new Promise((resolve, reject) => {
    const proc = spawn('useradd', ['--system', '--create-home', '--shell', '/usr/sbin/nologin', account]);
    proc.on('close', (code) => {
      if (code === 0 || code === 9) resolve(); // 9 = already exists
      else reject(new Error(`useradd exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

module.exports = { SetupRunner };
