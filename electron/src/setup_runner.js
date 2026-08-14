'use strict';

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const { hasCompatibleRay, ensureRayRuntime, pythonVersion, rayVersion, PINNED_RAY_VERSION, PINNED_PYTHON, findUv, which } = require('./bootstrap');
const { configDir, save, appendAudit, makeAuditEvent } = require('./storage');
const { isPrivateHost, isPortAvailable, findAvailablePort, isCoordinatorReachable, hasWorkerAccount, hasWorkerLaunchPermission } = require('./diagnostics');
const { createWorkerAccount } = require('./worker_account');
const { installDocker } = require('./docker_installer');

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
    this._logs = [];
  }

  status() {
    return { ...this._status, tasks: this._status.tasks.map((t) => ({ ...t })) };
  }

  _log(message, stream = 'setup') {
    this._logs.push({ timestamp: new Date().toISOString(), stream, message });
    if (this._logs.length > 500) this._logs.shift();
  }

  terminalLogs() {
    return this._logs.slice(-500);
  }

  logMessage(message, stream = 'setup') {
    this._log(message, stream);
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
    this._log('Running full machine setup...');
    this._run(configLoader).catch(() => {});
    return this.status();
  }

  _setTask(id, st, detail, fix = null) {
    const task = this._status.tasks.find((t) => t.id === id);
    if (task) { task.status = st; task.detail = detail; task.fix = fix; }
  }

  markWorkerAccountReady(message) {
    this._setTask('worker_account', 'pass', message || 'Dedicated worker account is ready');
    this._log(message || 'Dedicated worker account is ready');
  }

  async _run(configLoader) {
    const tasks = this._status.tasks;
    let config = configLoader();

    const step = async (id, fn) => {
      this._setTask(id, 'running', 'Running...');
      const label = SETUP_TASKS.find((t) => t.id === id)?.label || id;
      this._log(`${label}: running...`);
      this._status.progress = Math.floor((tasks.findIndex((t) => t.id === id) / tasks.length) * 100);
      try {
        const result = await fn();
        this._setTask(id, result.status, result.detail, result.fix || null);
        this._log(`${label}: ${result.status} - ${result.detail}`, result.status === 'fail' ? 'stderr' : 'setup');
        return result;
      } catch (err) {
        this._setTask(id, 'fail', err.message, null);
        this._log(`${label}: failed - ${err.message}`, 'stderr');
        return { status: 'fail', detail: err.message };
      }
    };

    // Step 1 — Python
    await step('python', async () => {
      const pv = pythonVersion();
      if (!pv && findUv()) {
        return { status: 'pass', detail: `Managed Python ${PINNED_PYTHON} will be installed by RayLab setup` };
      }
      if (!pv) {
        return { status: 'fail', detail: 'No bundled Python installer was found', fix: 'Reinstall RayLab with the bundled uv runtime, then run setup again.' };
      }
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
        this._log(line.slice(0, 500));
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
        if (process.platform === 'win32') {
          await _ensureWindowsWorkerFirewall(config, (line) => this._log(line));
        }
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
        { field: 'node_manager_port', host: coord.head_host, preferred: 18076 },
        { field: 'object_manager_port', host: coord.head_host, preferred: 18077 },
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
        if (process.platform === 'win32') {
          await _ensureWindowsCoordinatorFirewall(config, (line) => this._log(line));
        }
        return { status: 'pass', detail: `Updated occupied ports: ${changes.join(', ')}` };
      }
      if (process.platform === 'win32') {
        await _ensureWindowsCoordinatorFirewall(config, (line) => this._log(line));
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
        await createWorkerAccount(account);
        const nowExists = hasWorkerAccount(account);
        const nowCanLaunch = hasWorkerLaunchPermission(account);
        if (nowExists && nowCanLaunch) return { status: 'pass', detail: `Account ${account} created and configured` };
        return { status: 'fail', detail: `Account creation attempted but ${account} not fully configured`, fix: 'Approve the macOS administrator prompt when it appears.' };
      }
      if (process.platform === 'win32') {
        await createWorkerAccount(account);
        if (hasWorkerAccount(account)) return { status: 'pass', detail: `Dedicated account ${account} is ready` };
        return { status: 'fail', detail: `Account creation attempted but ${account} was not found`, fix: 'Approve the Windows administrator prompt and try again.' };
      }
      if (process.platform === 'linux') {
        await createWorkerAccount(account);
        if (hasWorkerAccount(account)) return { status: 'pass', detail: `Account ${account} created` };
        return { status: 'fail', detail: `Failed to create ${account} on Linux`, fix: 'Run as root or with sudo access.' };
      }
      return { status: 'fail', detail: `Account ${account} does not exist`, fix: 'Use Create account from the Dedicated worker account check.' };
    });

    // Step 7 — Container
    const { containerRuntimeStatus } = require('./diagnostics');
    const runtime = 'docker';
    const containerResult = await step('container', async () => {
      const s = containerRuntimeStatus(runtime);
      if (s.ok) return { status: 'pass', detail: s.detail };
      const result = await installDocker((line) => this._log(line.slice(0, 500)));
      const next = containerRuntimeStatus(runtime);
      if (next.ok) return { status: 'pass', detail: next.detail };
      return { status: 'fail', detail: result.message, fix: 'Use Install Docker, then start Docker Desktop or restart Windows if prompted.' };
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

async function _ensureWindowsWorkerFirewall(config, onOutput) {
  const coord = config.coordinator;
  const ports = [coord.node_manager_port, coord.object_manager_port]
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port > 0);
  if (ports.length === 0) return;

  const scriptPath = require('path').join(os.tmpdir(), 'raylab-worker-firewall.ps1');
  const ps = `
$ErrorActionPreference = 'Stop'
$configuredRemote = '${_psString(coord.head_host)}'
$resolvedRemotes = @()
try {
  $parsed = [System.Net.IPAddress]::Parse($configuredRemote)
  if ($parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { $resolvedRemotes += $parsed.ToString() }
} catch {
  try {
    $resolvedRemotes += Resolve-DnsName -Name $configuredRemote -Type A -ErrorAction Stop |
      Where-Object { $_.IPAddress } |
      ForEach-Object { $_.IPAddress }
  } catch {
    try {
      $resolvedRemotes += [System.Net.Dns]::GetHostAddresses($configuredRemote) |
        Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
        ForEach-Object { $_.ToString() }
    } catch {}
  }
}
$resolvedRemotes = @($resolvedRemotes | Where-Object { $_ } | Select-Object -Unique)
$routeTarget = if ($resolvedRemotes.Count -gt 0) { $resolvedRemotes[0] } else { $null }
$workerPorts = '20000-29999'
$remoteAddresses = @($resolvedRemotes + 'LocalSubnet') | Select-Object -Unique

try {
  $route = if ($routeTarget) {
    Get-NetRoute -RemoteIPAddress $routeTarget -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric, InterfaceMetric |
    Select-Object -First 1
  } else { $null }
  if ($route) {
    $profile = Get-NetConnectionProfile -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
    if ($profile -and $profile.NetworkCategory -eq 'Public') {
      Set-NetConnectionProfile -InterfaceIndex $route.InterfaceIndex -NetworkCategory Private
      Write-Output "RayLab set $($profile.InterfaceAlias) network profile to Private for worker callbacks"
    }
  }
  Set-NetFirewallProfile -Profile Private,Public -AllowInboundRules True -AllowLocalFirewallRules True
} catch {
  Write-Output "RayLab firewall profile tuning warning: $($_.Exception.Message)"
}

$rules = @(
  @{ Name = 'RayLab Worker Node Manager'; Ports = '${ports[0]}' },
  @{ Name = 'RayLab Worker Object Manager'; Ports = '${ports[1] || ports[0]}' },
  @{ Name = 'RayLab Worker Task Ports'; Ports = $workerPorts }
)
foreach ($rule in $rules) {
  Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Ports -RemoteAddress $remoteAddresses -Profile Any | Out-Null
}

$runtimeBin = Join-Path $env:APPDATA 'raylab-cluster-manager\runtime\venv\Scripts'
$programRules = @(
  @{ Name = 'RayLab Python Program'; Path = (Join-Path $runtimeBin 'python.exe') },
  @{ Name = 'RayLab Ray Program'; Path = (Join-Path $runtimeBin 'ray.exe') }
)
foreach ($programRule in $programRules) {
  if (Test-Path $programRule.Path) {
    Get-NetFirewallRule -DisplayName $programRule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $programRule.Name -Direction Inbound -Action Allow -Program $programRule.Path -RemoteAddress $remoteAddresses -Profile Any | Out-Null
  }
}

Write-Output "RayLab firewall rules allow the coordinator/local subnet to reach TCP ${ports.join(', ')} and $workerPorts"
`.trim();

  require('fs').writeFileSync(scriptPath, ps, 'utf8');
  try {
    onOutput?.('Configuring Windows firewall for Ray worker callback ports...');
    await _runElevatedPowerShell(scriptPath);
  } finally {
    try { require('fs').rmSync(scriptPath, { force: true }); } catch (_) {}
  }
}

async function _ensureWindowsCoordinatorFirewall(config, onOutput) {
  const coord = config.coordinator;
  const ports = [
    coord.ray_port,
    coord.dashboard_port,
    coord.client_port,
    coord.node_manager_port,
    coord.object_manager_port,
  ].map((port) => Number(port)).filter((port) => Number.isInteger(port) && port > 0);
  if (ports.length === 0) return;

  const scriptPath = require('path').join(os.tmpdir(), 'raylab-coordinator-firewall.ps1');
  const ps = `
$ErrorActionPreference = 'Stop'
$rayPorts = @(${ports.map((port) => `'${port}'`).join(', ')})
$workerPorts = '20000-29999'

try {
  $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4Connectivity -ne 'Disconnected' }
  foreach ($profile in $profiles) {
    if ($profile.NetworkCategory -eq 'Public') {
      Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private
      Write-Output "RayLab set $($profile.InterfaceAlias) network profile to Private for coordinator access"
    }
  }
  Set-NetFirewallProfile -Profile Private,Public -AllowInboundRules True -AllowLocalFirewallRules True
} catch {
  Write-Output "RayLab coordinator firewall profile tuning warning: $($_.Exception.Message)"
}

$rules = @(
  @{ Name = 'RayLab Coordinator Core Ports'; Ports = $rayPorts },
  @{ Name = 'RayLab Coordinator Worker Ports'; Ports = $workerPorts }
)
foreach ($rule in $rules) {
  Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Ports -RemoteAddress LocalSubnet -Profile Any | Out-Null
}

$runtimeBin = Join-Path $env:APPDATA 'raylab-cluster-manager\runtime\venv\Scripts'
$programRules = @(
  @{ Name = 'RayLab Coordinator Python Program'; Path = (Join-Path $runtimeBin 'python.exe') },
  @{ Name = 'RayLab Coordinator Ray Program'; Path = (Join-Path $runtimeBin 'ray.exe') }
)
foreach ($programRule in $programRules) {
  if (Test-Path $programRule.Path) {
    Get-NetFirewallRule -DisplayName $programRule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $programRule.Name -Direction Inbound -Action Allow -Program $programRule.Path -RemoteAddress LocalSubnet -Profile Any | Out-Null
  }
}

Write-Output "RayLab firewall rules allow local subnet access to coordinator TCP ${ports.join(', ')} and worker ports"
`.trim();

  require('fs').writeFileSync(scriptPath, ps, 'utf8');
  try {
    onOutput?.('Configuring Windows firewall for Ray coordinator ports...');
    await _runElevatedPowerShell(scriptPath);
  } finally {
    try { require('fs').rmSync(scriptPath, { force: true }); } catch (_) {}
  }
}

function _runElevatedPowerShell(scriptPath) {
  return new Promise((resolve, reject) => {
    const escaped = scriptPath.replace(/'/g, "''");
    const command = `$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${escaped}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error((output.trim() || `PowerShell exited with code ${code}`).slice(-500)));
    });
    proc.on('error', reject);
  });
}

function _psString(value) {
  return String(value || '').replace(/'/g, "''");
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
