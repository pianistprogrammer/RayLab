# RayLab Rollout

This app is intentionally conservative: it refuses safe-looking shortcuts that would weaken node-owner privacy. Configure the OS and network first, then start Ray through the app.

## Required Baseline

- Ray 2.52+ installed in RayLab's managed runtime. If Ray is missing, use the app's Diagnostics panel to run the built-in Ray installer.
- A fixed server-room Coordinator address on a private lab VLAN.
- No public exposure of Ray ports `6379`, `8265`, `10001`, `8076`, or `8077`.
- A dedicated local `raylab-worker` account on every participating machine.
- Docker or Podman with GPU runtime support.
- S3-compatible lab object storage for datasets and model weights.

## Linux Worker Account

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin raylab-worker
sudo mkdir -p /var/lib/raylab-worker/jobs
sudo chown -R raylab-worker:raylab-worker /var/lib/raylab-worker
```

The app launches Node-mode Ray commands as this account with `sudo -u raylab-worker -- ...`. Configure sudoers or a service wrapper according to lab policy so the desktop user can start/stop only the approved Ray commands.

## macOS Worker Account

In Node mode, RayLab setup asks for administrator permission with the standard macOS authorization dialog. If approved, it creates a hidden local `raylab-worker` account, creates `/var/lib/raylab-worker/jobs`, and installs a sudoers entry allowing the current desktop user to launch worker processes as `raylab-worker` without a terminal password prompt.

This keeps cluster jobs out of the owner user's home directory while keeping setup inside the app flow.

## Windows Worker Account

```powershell
net user raylab-worker * /add
mkdir C:\RayLab\jobs
```

Windows Node mode requires a service or scheduled-task wrapper that runs Ray as `raylab-worker`. The app refuses direct owner-user Node launch on Windows until that wrapper exists because otherwise jobs could read owner files.

## Network

Coordinator mode must use a private IP or DNS name. The local backend rejects non-private head addresses when `Private VLAN only` is enabled.

Recommended firewall stance:

- Allow Ray ports only from the lab VLAN.
- Block inbound Ray ports from campus-wide networks and the internet.
- Keep dashboard access behind the same VLAN boundary.

## Object Store

Jobs should read datasets and model weights from the lab object store rather than node home directories. Store the endpoint, bucket, and region in Settings. Store credentials through the OS secret store when available.

## Container Runtime

Install Docker/Podman and NVIDIA GPU runtime support. The diagnostics panel checks for the runtime binary and a GPU-capable runtime signal.

## Acceptance Checklist

- Coordinator starts Ray with token auth on the private head address.
- Node sharing is refused until `raylab-worker` exists.
- Node joins and leaves cleanly.
- Panic stop runs `ray stop --force` and locks the session in panic mode.
- Job submission requires a working directory and records submitter identity.
- Audit log shows configuration, cluster, submitter, job, and panic events.
- Dashboard opens in the system browser rather than inside the webview.
