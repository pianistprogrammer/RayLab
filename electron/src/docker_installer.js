'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { appendAudit, makeAuditEvent } = require('./storage');
const { containerRuntimeStatus } = require('./diagnostics');
const { which } = require('./bootstrap');

const DOCKER_DESKTOP_WIN_URL = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';
const DOCKER_DESKTOP_MAC_ARM64_URL = 'https://desktop.docker.com/mac/main/arm64/Docker.dmg';
const DOCKER_DESKTOP_MAC_AMD64_URL = 'https://desktop.docker.com/mac/main/amd64/Docker.dmg';

async function installDocker(onOutput) {
  const out = (line) => { if (onOutput) onOutput(line); };
  const existing = containerRuntimeStatus('docker');
  if (existing.ok) {
    out(`Docker already installed: ${existing.detail}`);
    return { installed: false, message: existing.detail };
  }

  out('Docker is not installed. Starting Docker setup...');
  if (process.platform === 'win32') return _installDockerWindows(out);
  if (process.platform === 'darwin') return _installDockerMac(out);
  if (process.platform === 'linux') return _installDockerLinux(out);
  throw new Error(`Docker installation is not supported on ${process.platform}`);
}

async function _installDockerWindows(out) {
  out('Using Docker Desktop installer directly. This avoids winget stalls after hash verification.');
  const installerPath = path.join(os.tmpdir(), 'RayLab-Docker-Desktop-Installer.exe');
  await _download(DOCKER_DESKTOP_WIN_URL, installerPath, out);
  out('Launching Docker Desktop installer. Approve the Windows administrator prompt if it appears.');
  out('Docker Desktop can take several minutes and may ask Windows to restart after installation.');
  const psCommand = `$p = Start-Process -FilePath '${_psString(installerPath)}' -ArgumentList 'install --quiet --accept-license --backend=wsl-2' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const result = await _runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand], out, 45 * 60 * 1000);
  try { fs.rmSync(installerPath, { force: true }); } catch (_) {}
  if (!result.success) throw new Error('Docker Desktop installer failed or was cancelled. Approve the administrator prompt and try again.');
  return _finishInstall(out);
}

async function _installDockerMac(out) {
  if (fs.existsSync('/Applications/Docker.app')) {
    out('Docker Desktop is already installed in /Applications. Start Docker Desktop, then refresh setup.');
    return _finishInstall(out);
  }

  const brew = which('brew');
  if (brew) {
    out('Installing Docker Desktop with Homebrew...');
    const result = await _runCommand(brew, ['install', '--cask', 'docker'], out, 30 * 60 * 1000);
    if (!result.success) out('Homebrew Docker installation failed; trying Docker Desktop DMG directly...');
    else return _finishInstall(out);
  }

  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  const url = arch === 'arm64' ? DOCKER_DESKTOP_MAC_ARM64_URL : DOCKER_DESKTOP_MAC_AMD64_URL;
  const dmgPath = path.join(os.tmpdir(), `RayLab-Docker-Desktop-${arch}.dmg`);
  const mountPoint = path.join(os.tmpdir(), `RayLab-Docker-Desktop-${Date.now()}`);
  out(`Downloading Docker Desktop for macOS (${arch})...`);
  await _download(url, dmgPath, out);
  fs.mkdirSync(mountPoint, { recursive: true });
  try {
    out('Mounting Docker Desktop installer...');
    const attach = await _runCommand('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-quiet'], out, 10 * 60 * 1000);
    if (!attach.success) throw new Error('Docker Desktop DMG mount failed.');
    out('Copying Docker Desktop to /Applications...');
    const copy = await _runCommand('/bin/cp', ['-R', path.join(mountPoint, 'Docker.app'), '/Applications/'], out, 10 * 60 * 1000);
    if (!copy.success) throw new Error('Docker Desktop copy failed. Check write permission for /Applications.');
  } finally {
    await _runCommand('hdiutil', ['detach', mountPoint, '-quiet'], out, 2 * 60 * 1000);
    try { fs.rmSync(dmgPath, { force: true }); } catch (_) {}
    try { fs.rmdirSync(mountPoint); } catch (_) {}
  }
  out('Docker Desktop installed. Start Docker Desktop once to finish engine setup.');
  return _finishInstall(out);
}

async function _installDockerLinux(out) {
  const sh = which('sh') || '/bin/sh';
  const curl = which('curl');
  if (!curl) throw new Error('curl is required for in-app Docker installation on Linux.');
  out('Installing Docker Engine using get.docker.com...');
  const result = await _runCommand(sh, ['-c', 'curl -fsSL https://get.docker.com | sh'], out, 30 * 60 * 1000);
  if (!result.success) throw new Error('Docker Engine installation failed. Run the app with sufficient privileges or install Docker manually.');
  return _finishInstall(out);
}

async function _finishInstall(out) {
  const status = containerRuntimeStatus('docker');
  if (status.ok) {
    out(`Docker installed: ${status.detail}`);
    await appendAudit(makeAuditEvent('docker_install_finished', status.detail, { succeeded: true }));
    return { installed: true, message: status.detail };
  }
  const message = process.platform === 'win32'
    ? 'Docker installation finished, but Docker CLI is not available yet. Start Docker Desktop or restart Windows, then refresh setup.'
    : 'Docker installation finished, but Docker CLI is not available yet. Start Docker Desktop once, then refresh setup.';
  out(message);
  await appendAudit(makeAuditEvent('docker_install_finished', message, { succeeded: true, pending_restart: true }));
  return { installed: true, message };
}

function _runCommand(command, args, onOutput, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    } catch (err) {
      resolve({ success: false, output: err.message });
      return;
    }
    const output = [];
    const handle = (data) => {
      data.toString().split('\n').forEach((line) => {
        const trimmed = line.replace(/\r$/, '').trim();
        if (!trimmed) return;
        output.push(trimmed);
        if (output.length > 40) output.shift();
        onOutput(trimmed.slice(0, 500));
      });
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve({ success: false, output: output.join('\n') });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0, output: output.join('\n') });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: err.message });
    });
  });
}

function _download(url, dest, out) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        file.close(() => fs.rmSync(dest, { force: true }));
        _download(response.headers.location, dest, out).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close(() => fs.rmSync(dest, { force: true }));
        reject(new Error(`Docker download failed with HTTP ${response.statusCode}`));
        return;
      }
      const total = Number.parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0;
      let lastPct = -1;
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            out(`Downloading Docker Desktop... ${pct}%`);
          }
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    request.on('error', (err) => {
      file.close(() => fs.rmSync(dest, { force: true }));
      reject(err);
    });
  });
}

function _psString(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = { installDocker };
