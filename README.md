# RayLab

RayLab is an API-first Tauri desktop control plane for already-running Ray clusters. It submits durable workloads, lists and inspects jobs, reads logs, stops or deletes jobs, and shows cluster nodes without spawning or parsing Ray CLI processes.

## Architecture

```text
React + Zustand
      │ typed Tauri commands
      ▼
Rust application service
      ├── Ray Jobs REST API
      ├── Ray State REST API
      └── Tauri app-data persistence
             │
             ▼
    existing Ray Dashboard (:8265)
```

React owns view, selection, job, connection, and preference state. Tauri persists the desktop state and performs all network operations. The Rust backend validates URLs and payloads, checks HTTP status codes, normalizes Ray response shapes, and returns structured data to the UI.

RayLab intentionally does **not** install Ray, start or stop a cluster, join worker machines, run a Python sidecar, invoke the Ray CLI, or parse terminal output. Cluster provisioning belongs to the platform that owns the cluster (for example KubeRay, cloud infrastructure, system services, or a lab administrator).

## Requirements

- Node.js 20 or newer with Corepack
- Rust 1.88 (pinned in `rust-toolchain.toml`)
- A reachable Ray Dashboard and Jobs server, normally `http://<head>:8265`

Keep Ray endpoints on a controlled private network. Anyone with access to an unprotected Ray Jobs endpoint may be able to execute code on the cluster.

## Development

```bash
corepack pnpm install
corepack pnpm dev
```

The frontend is under `frontend/`; the Rust/Tauri application is under `src-tauri/`.

## Verification

```bash
corepack pnpm test
corepack pnpm check
corepack pnpm build
```

The test suite covers job payload construction, UI-state migration, URL normalization, Ray job response compatibility, State API node normalization, HTTP routes, structured API errors, and persisted desktop-state defaults.

## Supported Ray operations

| Operation | Backend |
|---|---|
| API/version health | `GET /api/version` |
| Submit job | `POST /api/jobs/` |
| List jobs | `GET /api/jobs/` |
| Job details | `GET /api/jobs/{submission_id}` |
| Job logs | `GET /api/jobs/{submission_id}/logs` |
| Stop job | `POST /api/jobs/{submission_id}/stop` |
| Delete terminal job | `DELETE /api/jobs/{submission_id}` |
| List nodes | `GET /api/v0/nodes` |

See [docs/rollout.md](docs/rollout.md) for deployment and acceptance checks.
