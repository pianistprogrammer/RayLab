'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { appendAudit, makeAuditEvent } = require('./storage');
const { hasWorkerAccount, hasWorkerLaunchPermission } = require('./diagnostics');

async function createWorkerAccount(account) {
  const name = account || 'raylab-worker';
  if (hasWorkerAccount(name) && hasWorkerLaunchPermission(name)) {
    return { created: false, message: `Dedicated account ${name} is already ready` };
  }

  if (process.platform === 'win32') return _createWindowsWorkerAccount(name);
  if (process.platform === 'darwin') return _createMacosWorkerAccount(name);
  if (process.platform === 'linux') return _createLinuxWorkerAccount(name);
  throw new Error(`Worker account setup is not supported on ${process.platform}`);
}

async function _createWindowsWorkerAccount(account) {
  const scriptPath = path.join(os.tmpdir(), `raylab-create-${account}.ps1`);
  const ps = `
$ErrorActionPreference = 'Stop'
$name = '${_psString(account)}'
$description = 'RayLab dedicated worker account'
$password = ([guid]::NewGuid().ToString('N') + 'aA1!')
$secure = ConvertTo-SecureString $password -AsPlainText -Force

if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
  $existing = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    New-LocalUser -Name $name -Password $secure -FullName 'RayLab Worker' -Description $description -PasswordNeverExpires | Out-Null
  } else {
    Enable-LocalUser -Name $name
    Set-LocalUser -Name $name -Description $description -PasswordNeverExpires $true
  }
  Remove-LocalGroupMember -Group 'Administrators' -Member $name -ErrorAction SilentlyContinue
} else {
  net user $name $password /add /y
  if ($LASTEXITCODE -ne 0) { throw "net user /add failed with exit code $LASTEXITCODE" }
  net user $name /active:yes
  if ($LASTEXITCODE -ne 0) { throw "net user /active failed with exit code $LASTEXITCODE" }
  wmic useraccount where "name='$name'" set PasswordExpires=false | Out-Null
}
`.trim();

  fs.writeFileSync(scriptPath, ps, 'utf8');
  try {
    await _runElevatedPowerShell(scriptPath);
  } finally {
    try { fs.rmSync(scriptPath, { force: true }); } catch (_) {}
  }

  if (!hasWorkerAccount(account)) {
    throw new Error(`Windows account ${account} was not created. Approve the administrator prompt and try again.`);
  }
  await appendAudit(makeAuditEvent('worker_account_created', `Dedicated Windows account ${account} is ready`));
  return { created: true, message: `Dedicated account ${account} is ready` };
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

  const escaped = shellScript.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const prompt = `RayLab needs administrator permission to create a hidden local account named ${account}. Cluster jobs will run as this account instead of your personal macOS user.`;
  const appleScript = `do shell script "${escaped}" with administrator privileges with prompt "${prompt}"`;

  await new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-e', appleScript], { timeout: 300000 });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`osascript exited with code ${code}`));
    });
    proc.on('error', reject);
  });

  if (!hasWorkerAccount(account) || !hasWorkerLaunchPermission(account)) {
    throw new Error(`Account ${account} was not fully configured. Approve the administrator prompt and try again.`);
  }
  await appendAudit(makeAuditEvent('worker_account_created', `Dedicated macOS account ${account} is ready`));
  return { created: true, message: `Dedicated account ${account} is ready` };
}

async function _createLinuxWorkerAccount(account) {
  await new Promise((resolve, reject) => {
    const proc = spawn('useradd', ['--system', '--create-home', '--shell', '/usr/sbin/nologin', account]);
    proc.on('close', (code) => {
      if (code === 0 || code === 9) resolve();
      else reject(new Error(`useradd exited with code ${code}`));
    });
    proc.on('error', reject);
  });
  if (!hasWorkerAccount(account)) throw new Error(`Failed to create ${account}`);
  await appendAudit(makeAuditEvent('worker_account_created', `Dedicated Linux account ${account} is ready`));
  return { created: true, message: `Dedicated account ${account} is ready` };
}

function _psString(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = { createWorkerAccount };
