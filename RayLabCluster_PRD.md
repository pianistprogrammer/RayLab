# PRD: RayLab Two-Mode Desktop Control Plane

Version 0.3

## 1. Product decision

RayLab is one Tauri desktop application with two mutually exclusive machine roles:

1. **Coordinator mode** starts the Ray head node on this machine, exposes a private join address, and lets other RayLab installations join it.
2. **Worker mode** joins an existing RayLab coordinator and offers a configurable amount of this machine's CPU and GPU capacity.

Coordinator/Worker operation is a must-have product capability. It is not optional integration work and must not be removed when job-management or desktop architecture changes.

The user chooses one role at first launch. The role can be changed later only after the Ray node owned by RayLab has stopped. A machine never acts as Coordinator and Worker simultaneously.

## 2. Goals

1. Let a user create a Ray cluster without leaving the desktop application.
2. Let another user install the same application, enter the coordinator address and token, and join as a worker.
3. Provide one-click Start/Stop in Coordinator mode and Join/Leave in Worker mode.
4. Offer explicit CPU, GPU, and RayLab-entrypoint concurrency capacity from each machine.
5. Keep durable job submission, status, logs, deletion, and node observability on typed Ray HTTP APIs.
6. Persist role, lifecycle configuration, saved clusters, selections, and preferences through Tauri app data.
7. Keep secrets outside renderer-persisted JSON and send them only as bearer headers or Ray process environment configuration.
8. Return typed lifecycle and API errors rather than inferring state from terminal text.

## 3. Non-goals for v0.3

- Provisioning cloud VMs, Kubernetes clusters, VPNs, DNS, or firewall rules.
- Automatically discovering coordinators on an untrusted network.
- Supporting different Ray versions within one cluster.
- Running Coordinator and Worker roles simultaneously on one machine.
- Exposing a generic terminal, shell command, or arbitrary process-execution IPC command.
- Treating Ray custom resources as a security sandbox.
- Providing OS-user or container isolation for worker jobs. In v0.3, Ray processes run as the signed-in desktop user; dedicated service accounts/containers remain required future hardening before using untrusted workloads.

## 4. Users and core journeys

### Coordinator

1. Install and open RayLab.
2. Choose **Host this cluster**.
3. Confirm the detected LAN address, resource offer, and ports.
4. Install the managed Ray runtime if it is not present.
5. Start the coordinator.
6. Share the displayed `host:6379` join address and generated cluster token with trusted workers.
7. Inspect joined nodes and manage jobs through Ray's HTTP APIs.
8. Stop the coordinator before switching this machine to Worker mode.

### Worker

1. Install and open the same RayLab application.
2. Choose **Join a cluster**.
3. Enter the coordinator hostname/IP and shared token.
4. Choose the CPUs, GPUs, and RayLab job slots this machine offers.
5. Install the same pinned managed Ray runtime.
6. Click **Join cluster**.
7. RayLab confirms this machine appears as an alive node in the coordinator's State API.
8. Click **Leave cluster** to stop the local Ray worker and withdraw the offered resources.

## 5. Architecture

```text
React + Zustand
      │ typed, allowlisted Tauri commands
      ▼
Tauri / Rust
      ├── Desktop state service
      │     └── role, lifecycle config, connections, preferences
      ├── Secret service
      │     └── private per-cluster token file (0600 on Unix)
      ├── Local lifecycle adapter
      │     ├── managed Python 3.11 + Ray 2.57.0 runtime
      │     ├── typed `ray start --head` (Coordinator)
      │     ├── typed `ray start --address=…` (Worker)
      │     └── owned `ray stop --force`
      └── Ray HTTP client
            ├── Jobs REST API
            └── State REST API
```

### 5.1 Boundary between lifecycle and application operations

Ray officially exposes physical node startup through `ray start`. RayLab therefore uses a narrow lifecycle adapter for only these operations:

- Start a local head node.
- Start a local worker attached to a head node.
- Stop the Ray processes previously started by RayLab on this machine.
- Query the installed Ray version.

This adapter executes a fixed executable with separately validated arguments. It does not use a shell, accept raw commands from React, parse `ray status`, or use CLI output as application state.

All job lifecycle, logs, health, and node confirmation use Ray's structured Jobs and State HTTP APIs. Changing React views cannot terminate or reset Ray processes.

### 5.2 Managed runtime

- RayLab pins Python 3.11 and Ray 2.57.0 for every participant.
- Setup creates an application-owned virtual environment using `uv` when available, with a Python `venv`/`pip` fallback.
- Coordinator and Worker must run the same Ray version.
- Runtime setup is explicit and reports actionable failures; it never silently uses an incompatible version.

### 5.3 Lifecycle ownership and recovery

- RayLab writes a private lifecycle marker only after a typed start command succeeds.
- Stop is permitted only for a Ray node represented by that marker, preventing RayLab from intentionally stopping an unrelated local Ray installation.
- A coordinator is considered running only when its authenticated `/api/version` endpoint responds.
- A worker is considered running only when the coordinator's authenticated State API reports the worker's detected local IP as alive.
- If RayLab restarts, it reads the marker and reconstructs status from the APIs.
- Ray processes are not tied to navigation or the Tauri window lifecycle.

## 6. Functional requirements

### 6.1 Role selection and exclusivity

- First launch must show **Host this cluster** and **Join a cluster** before the normal workspace.
- Persist `app_mode` as `coordinator` or `worker`.
- Default/migrated state with no role must be `unconfigured` and return to role onboarding.
- A role switch must fail while a RayLab lifecycle marker exists for the other role.
- Settings must explain that Ray must be stopped before switching.

### 6.2 Coordinator mode

- Detect a routable LAN IPv4 address, with an optional explicit override.
- Start Ray with head, Dashboard, Ray Client, State API, fixed agent ports, and a bounded worker-port range.
- Bind the Dashboard for private-network access so Worker-mode installations can use Jobs and State APIs.
- Display the join address and Dashboard address.
- Generate and privately store a cryptographically random cluster token.
- Reveal/copy the token only through an explicit user action.
- Offer configured CPU/GPU capacity on the head node.
- Stop only the Ray node owned by RayLab.

### 6.3 Worker mode

- Require a coordinator IPv4/DNS host without a URL scheme or embedded port.
- Require a shared token of at least 16 characters.
- Detect the local IP used to route to the coordinator, with an optional explicit override.
- Join `head_host:ray_port` using the same authenticated, pinned runtime.
- Offer the configured CPUs, GPUs, and `raylab_max_jobs` custom resource.
- Confirm membership through the coordinator's State API before reporting success.
- Leave by stopping the Ray node owned by this RayLab installation.

### 6.4 Jobs and observability

- Continue to submit jobs through `POST /api/jobs/`.
- Add a `raylab_max_jobs: 1` entrypoint resource to jobs submitted to the role-managed cluster so the advertised RayLab job slots are consumed.
- Continue to list, inspect, stop, delete, and read logs through the Jobs API.
- Continue to list nodes through the State API.
- Send `Authorization: Bearer <token>` for authenticated role-managed API requests.
- Treat State API failure as an observability limitation without corrupting desktop state.

### 6.5 Desktop state

React owns and Tauri persists:

- Active role and lifecycle configuration.
- Selected cluster and selected job.
- Saved API-only connections in addition to the role-managed connection.
- Active view, recent Jobs/Nodes data, and refresh preferences.

The role-managed cluster connection cannot be manually deleted or edited as a generic connection. It is derived from lifecycle settings.

## 7. Security requirements

- Enable Ray token authentication by default with `RAY_AUTH_MODE=token` on every managed node.
- Store tokens outside `desktop-state.json`; use a private application secrets directory and `0600` files on Unix.
- Never include tokens in Dashboard URLs, command arguments, logs, or error text.
- Never expose a renderer command that accepts an executable, command line, or shell script.
- Validate mode, host, IP, ports, resource values, and cluster IDs in Rust before launching a process.
- Keep the Dashboard and Ray control ports on a trusted private LAN/VLAN/VPN. Token authentication does not make public exposure safe.
- Document that v0.3 worker processes run as the signed-in OS user and therefore must execute only trusted cluster workloads.

## 8. Default network contract

| Purpose | Port(s) |
|---|---:|
| Ray GCS / worker join | 6379 |
| Ray Dashboard, Jobs, State | 8265 |
| Ray Client | 10001 |
| Object manager / node manager | 8076–8077 |
| Dashboard/runtime agents | 52365–52367 |
| Worker processes | 20000–20100 |

The application diagnoses a local port conflict before startup. Network firewalls and routing remain administrator-controlled prerequisites.

## 9. Acceptance criteria

### Automated

- Rust tests cover Coordinator and Worker argument construction, unsafe host rejection, secret path traversal, token persistence, bearer headers, state migration, Jobs API routes, response normalization, and structured errors.
- Frontend tests cover role migration, managed Coordinator/Worker connections, token validation, job payloads, URL normalization, and polling bounds.
- TypeScript compilation, Vite production build, Rust tests, Clippy with warnings denied, dependency audit, and Tauri release bundling pass.
- No Electron package, generic shell IPC, `ray status` parser, job CLI parser, or Python UI-state sidecar is shipped.

### Real two-machine acceptance

1. Install the same RayLab build on machines A and B on a trusted private network.
2. Configure A as Coordinator and start it.
3. Verify A shows a non-loopback join address and a generated token.
4. Configure B as Worker using A's address/token and join.
5. Verify A's Nodes view reports both machines alive with B's configured CPU/GPU resources.
6. Submit a harmless job and verify status/logs through the API.
7. Leave from B and verify B disappears or becomes dead in A's Nodes view.
8. Stop A and verify the Dashboard becomes unavailable.
9. Verify neither machine can switch roles while its managed Ray node is active.
10. Verify a wrong token, incompatible Ray version, invalid host, or occupied port produces an actionable error and no false running state.

## 10. Risks and follow-up hardening

- Ray documents multi-node clusters on macOS and Windows as development-oriented. Linux remains the preferred production worker platform.
- A trusted Ray cluster can execute arbitrary code on its workers. Add dedicated unprivileged service accounts and container isolation before accepting mutually untrusted workloads.
- Signing/notarization and a bundled `uv` binary are required for a zero-prerequisite production installer on each target OS.
- Future versions should add firewall diagnostics, coordinator discovery, token rotation/revocation, schedules, idle-only participation, tray controls, and per-node audit logs without weakening the role-exclusivity invariant.
