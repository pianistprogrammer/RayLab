'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { configDir } = require('./storage');

// ─── Version pins ─────────────────────────────────────────────────────────────

const PINNED_PYTHON = process.env.RAYLAB_PYTHON_VERSION || '3.11.14';
const PINNED_RAY_VERSION = process.env.RAYLAB_RAY_VERSION || '2.56.1';
const RAY_REQUIREMENT = `ray[default]==${PINNED_RAY_VERSION}`;

// ─── Path helpers ─────────────────────────────────────────────────────────────

function runtimeDir() {
  if (process.env.RAYLAB_RUNTIME_DIR) return process.env.RAYLAB_RUNTIME_DIR;
  if (process.platform === 'darwin') return '/Users/Shared/RayLab/runtime';
  return path.join(configDir(), 'runtime');
}

function venvDir() {
  return path.join(runtimeDir(), 'venv');
}

function rayExecutablePath(base) {
  const b = base || venvDir();
  return process.platform === 'win32'
    ? path.join(b, 'Scripts', 'ray.exe')
    : path.join(b, 'bin', 'ray');
}

function venvPythonPath(base) {
  const b = base || venvDir();
  return process.platform === 'win32'
    ? path.join(b, 'Scripts', 'python.exe')
    : path.join(b, 'bin', 'python');
}

function markerPath() {
  return path.join(runtimeDir(), 'ray-runtime.json');
}

// ─── uv / wheels discovery ───────────────────────────────────────────────────

function findUv() {
  if (process.env.RAYLAB_UV_BIN && fs.existsSync(process.env.RAYLAB_UV_BIN)) {
    return process.env.RAYLAB_UV_BIN;
  }

  const bin = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const roots = [
    path.join(__dirname, '..', '..', 'vendor', 'bin'),
    path.join(__dirname, '..', 'vendor', 'bin'),
  ];
  for (const root of roots) {
    const candidate = path.join(root, bin);
    if (fs.existsSync(candidate)) return candidate;
  }

  const fromPath = which('uv');
  if (fromPath) return fromPath;

  const hardcoded = [
    path.join(os.homedir(), '.local', 'bin', 'uv'),
    path.join(os.homedir(), '.cargo', 'bin', 'uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
  ];
  for (const p of hardcoded) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function vendorWheelsDir() {
  if (process.env.RAYLAB_VENDOR_WHEELS && fs.existsSync(process.env.RAYLAB_VENDOR_WHEELS)) {
    return process.env.RAYLAB_VENDOR_WHEELS;
  }
  const roots = [
    path.join(__dirname, '..', '..', 'vendor', 'wheels'),
    path.join(__dirname, '..', 'vendor', 'wheels'),
  ];
  for (const root of roots) {
    if (fs.existsSync(root)) return root;
  }
  return null;
}

// ─── Version queries ──────────────────────────────────────────────────────────

function execVersion(bin, timeoutMs = 20000) {
  try {
    const result = spawnSync(bin, ['--version'], {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env },
    });
    const out = ((result.stdout || '') + (result.stderr || '')).trim();
    if (!out) return null;
    const parts = out.split(/\s+/);
    return parts[parts.length - 1] || null;
  } catch (_) {
    return null;
  }
}

function rayVersion(rayBin) {
  return execVersion(rayBin || rayExecutablePath());
}

function pythonVersion(pythonBin) {
  const bin = pythonBin || venvPythonPath();
  if (!fs.existsSync(bin)) return null;
  return execVersion(bin);
}

function resolvedRayExecutable() {
  if (process.env.RAYLAB_RAY_BIN && fs.existsSync(process.env.RAYLAB_RAY_BIN)) {
    return process.env.RAYLAB_RAY_BIN;
  }
  const local = rayExecutablePath();
  if (fs.existsSync(local)) return local;
  if (process.env.RAYLAB_ALLOW_SYSTEM_RAY === '1') return which('ray');
  return null;
}

function rayCommand() {
  return resolvedRayExecutable() || 'ray';
}

function hasCompatibleRay() {
  const exe = resolvedRayExecutable();
  if (!exe) return false;
  return rayVersion(exe) === PINNED_RAY_VERSION && pythonVersion() === PINNED_PYTHON;
}

// ─── Subprocess env ───────────────────────────────────────────────────────────

function subprocessEnv() {
  const env = { ...process.env };
  if (process.platform === 'darwin' && !process.env.RAYLAB_RUNTIME_DIR) {
    env.UV_PYTHON_INSTALL_DIR = env.UV_PYTHON_INSTALL_DIR || '/Users/Shared/RayLab/python';
    env.UV_CACHE_DIR = env.UV_CACHE_DIR || '/Users/Shared/RayLab/uv-cache';
  }
  return env;
}

// ─── Runtime accessibility (macOS) ───────────────────────────────────────────

function makeRuntimeAccessible() {
  if (process.platform !== 'darwin') return;
  const dirs = [runtimeDir()];
  const pythonInstallDir = '/Users/Shared/RayLab/python';
  const uvCacheDir = '/Users/Shared/RayLab/uv-cache';
  if (fs.existsSync(pythonInstallDir)) dirs.push(pythonInstallDir);
  if (fs.existsSync(uvCacheDir)) dirs.push(uvCacheDir);

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    _chmodRecursive(dir);
  }

  const rayBin = rayExecutablePath();
  const pyBin = venvPythonPath();
  for (const bin of [rayBin, pyBin]) {
    if (fs.existsSync(bin)) {
      try { fs.chmodSync(bin, 0o755); } catch (_) {}
    }
  }
  _repairRayNativeExecutables();
}

function _chmodRecursive(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          fs.chmodSync(p, 0o755);
          _chmodRecursive(p);
        } else {
          const mode = fs.statSync(p).mode;
          fs.chmodSync(p, (mode & 0o111) ? 0o755 : 0o644);
        }
      } catch (_) {}
    }
    fs.chmodSync(dir, 0o755);
  } catch (_) {}
}

function _repairRayNativeExecutables() {
  const root = path.join(venvDir(), 'lib', 'python3.11', 'site-packages', 'ray', 'core', 'src', 'ray');
  const names = new Set(['raylet', 'gcs_server', 'plasma_store_server', 'default_worker', 'io_worker']);
  try {
    _walk(root, (p) => {
      if (names.has(path.basename(p))) fs.chmodSync(p, 0o755);
    });
  } catch (_) {}
}

function _walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) _walk(p, visit);
    else visit(p);
  }
}

// ─── Subprocess runner ────────────────────────────────────────────────────────

function runCommand(cmd, { timeoutMs = 300000, onOutput } = {}) {
  return new Promise((resolve) => {
    const logTail = [];
    let proc;
    try {
      proc = spawn(cmd[0], cmd.slice(1), {
        env: subprocessEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ success: false, output: err.message });
      return;
    }

    const handleLine = (line) => {
      const trimmed = line.replace(/\r$/, '');
      logTail.push(trimmed);
      if (logTail.length > 30) logTail.shift();
      if (onOutput) onOutput(trimmed);
    };

    proc.stdout.on('data', (d) => d.toString().split('\n').forEach(handleLine));
    proc.stderr.on('data', (d) => d.toString().split('\n').forEach(handleLine));

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve({ success: false, output: logTail.join('\n') });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0, output: logTail.join('\n') });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: err.message });
    });
  });
}

// ─── Main install logic ───────────────────────────────────────────────────────

// Module-level promise lock — prevents concurrent installs.
let _installLock = null;

async function ensureRayRuntime(onOutput) {
  if (_installLock) return _installLock;
  _installLock = _doEnsureRayRuntime(onOutput).finally(() => { _installLock = null; });
  return _installLock;
}

async function _doEnsureRayRuntime(onOutput) {
  const out = (msg) => { if (onOutput) onOutput(msg); };

  // Fast path — already installed with correct versions.
  const localRay = rayExecutablePath();
  if (
    fs.existsSync(localRay) &&
    rayVersion(localRay) === PINNED_RAY_VERSION &&
    pythonVersion() === PINNED_PYTHON
  ) {
    out(`Ray ${PINNED_RAY_VERSION} with Python ${PINNED_PYTHON} already installed.`);
    makeRuntimeAccessible();
    _writeMarker();
    return { succeeded: true, message: `Ray ${PINNED_RAY_VERSION} is ready.` };
  }

  // Python version mismatch — wipe and reinstall.
  const pyVer = pythonVersion();
  if (pyVer && pyVer !== PINNED_PYTHON && fs.existsSync(venvDir())) {
    out(`Python version mismatch (${pyVer} vs ${PINNED_PYTHON}), recreating venv...`);
    fs.rmSync(venvDir(), { recursive: true, force: true });
  }

  fs.mkdirSync(runtimeDir(), { recursive: true });

  const uv = findUv();
  if (uv) {
    return _installWithUv(uv, out);
  }
  if (process.platform === 'win32') {
    return { succeeded: false, message: 'Bundled uv.exe was not found. Reinstall RayLab, then run setup again.' };
  }
  return _installWithPip(out);
}

async function _installWithUv(uv, out) {
  out(`Using uv at ${uv}`);

  // Step 1 — create venv
  let result = await runCommand(
    [uv, 'venv', venvDir(), '--python', PINNED_PYTHON, '--managed-python'],
    { timeoutMs: 600000, onOutput: out }
  );

  if (!result.success) {
    out(`uv venv failed, trying to install Python ${PINNED_PYTHON}...`);
    const pyInstall = await runCommand(
      [uv, 'python', 'install', PINNED_PYTHON],
      { timeoutMs: 600000, onOutput: out }
    );
    if (!pyInstall.success) {
      return { succeeded: false, message: `Failed to install Python ${PINNED_PYTHON}: ${result.output.slice(-500)}` };
    }
    result = await runCommand(
      [uv, 'venv', venvDir(), '--python', PINNED_PYTHON, '--managed-python'],
      { timeoutMs: 600000, onOutput: out }
    );
    if (!result.success) {
      return { succeeded: false, message: `Failed to create venv: ${result.output.slice(-500)}` };
    }
  }

  // Step 2 — install Ray
  let installResult = await runCommand(
    [uv, 'pip', 'install', '--python', venvPythonPath(), RAY_REQUIREMENT],
    { timeoutMs: 300000, onOutput: out }
  );

  if (!installResult.success) {
    const wheels = vendorWheelsDir();
    if (wheels) {
      out('Online install failed, trying offline wheels...');
      installResult = await runCommand(
        [uv, 'pip', 'install', '--python', venvPythonPath(), '--no-index', '--find-links', wheels, RAY_REQUIREMENT],
        { timeoutMs: 300000, onOutput: out }
      );
    }
    if (!installResult.success) {
      return { succeeded: false, message: `Ray install failed: ${installResult.output.slice(-500)}` };
    }
  }

  return _validateAndFinish(out);
}

async function _installWithPip(out) {
  out('uv not found; falling back to Python venv + pip.');

  const python3 = which('python3') || 'python3';

  // Step 1 — create venv
  const venvResult = await runCommand(
    [python3, '-m', 'venv', venvDir()],
    { timeoutMs: 300000, onOutput: out }
  );
  if (!venvResult.success) {
    return { succeeded: false, message: `Failed to create venv: ${venvResult.output.slice(-500)}` };
  }

  // Step 2 — install Ray
  let installResult = await runCommand(
    [venvPythonPath(), '-m', 'pip', 'install', RAY_REQUIREMENT],
    { timeoutMs: 600000, onOutput: out }
  );

  if (!installResult.success) {
    const wheels = vendorWheelsDir();
    if (wheels) {
      out('Online install failed, trying offline wheels...');
      installResult = await runCommand(
        [venvPythonPath(), '-m', 'pip', 'install', '--no-index', '--find-links', wheels, RAY_REQUIREMENT],
        { timeoutMs: 600000, onOutput: out }
      );
    }
    if (!installResult.success) {
      return { succeeded: false, message: `Ray install failed: ${installResult.output.slice(-500)}` };
    }
  }

  return _validateAndFinish(out);
}

function _validateAndFinish(out) {
  const rv = rayVersion();
  const pv = pythonVersion();
  if (rv !== PINNED_RAY_VERSION) {
    return { succeeded: false, message: `Ray version mismatch after install: got ${rv}, expected ${PINNED_RAY_VERSION}` };
  }
  if (pv !== PINNED_PYTHON) {
    return { succeeded: false, message: `Python version mismatch after install: got ${pv}, expected ${PINNED_PYTHON}` };
  }
  makeRuntimeAccessible();
  _writeMarker();
  out(`Ray ${rv} with Python ${pv} installed successfully.`);
  return { succeeded: true, message: `Ray ${rv} with Python ${pv} is ready.` };
}

function _writeMarker() {
  try {
    fs.mkdirSync(runtimeDir(), { recursive: true });
    fs.writeFileSync(markerPath(), JSON.stringify({
      python: PINNED_PYTHON,
      ray: PINNED_RAY_VERSION,
      ray_executable: rayExecutablePath(),
      created_at: new Date().toISOString(),
    }, null, 2));
  } catch (_) {}
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function which(cmd) {
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      [cmd],
      { encoding: 'utf8', timeout: 3000 }
    );
    if (result.status === 0) return result.stdout.trim().split('\n')[0].trim() || null;
  } catch (_) {}
  return null;
}

module.exports = {
  PINNED_PYTHON,
  PINNED_RAY_VERSION,
  RAY_REQUIREMENT,
  runtimeDir,
  venvDir,
  rayExecutablePath,
  venvPythonPath,
  findUv,
  rayVersion,
  pythonVersion,
  resolvedRayExecutable,
  rayCommand,
  hasCompatibleRay,
  ensureRayRuntime,
  subprocessEnv,
  which,
  runCommand,
};
