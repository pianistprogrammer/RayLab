# PRD: RayLab API-First Desktop Control Plane

Version 0.2

## Product decision

RayLab is a Tauri + React desktop client for operating existing Ray clusters through programmatic APIs. It is no longer a local cluster installer, host/join agent, worker-sharing daemon, or wrapper around the Ray CLI.

This boundary is deliberate: durable Ray workloads already have a structured Jobs API, while local process ownership created platform-specific lifecycle, quoting, parsing, permissions, and sidecar-state problems that distracted from the useful product.

## Goals

1. Connect to one or more saved Ray Dashboard endpoints.
2. Submit durable jobs with a structured runtime environment and resource reservations.
3. List jobs, inspect current status, read logs, stop active jobs, and delete terminal jobs.
4. Show a read-only node inventory from Ray's State API.
5. Keep navigation, selected cluster/job, and refresh preferences in React and persist them through Tauri app data.
6. Return typed data and actionable API errors instead of parsed terminal text.

## Non-goals

- Installing or upgrading Ray.
- Starting, stopping, or provisioning Ray clusters.
- Joining local machines as workers.
- SSH orchestration or cloud infrastructure provisioning.
- Ray Client sessions for long-running work.
- A Python sidecar for operations available through HTTP.
- Embedding the Ray Dashboard web application.

## Users

- Researchers submitting repeatable training, inference, and batch jobs.
- Lab operators reviewing job health and cluster membership.
- Developers switching between local, lab, staging, and production Ray clusters.

## Architecture

```text
┌───────────────────────────────────────────────────────┐
│ RayLab                                                │
│                                                       │
│ React/Zustand              Tauri/Rust                  │
│ ┌──────────────────┐ IPC  ┌─────────────────────────┐ │
│ │ views/selections │─────▶│ URL + payload validation│ │
│ │ jobs and logs    │◀─────│ HTTP status/error checks│ │
│ │ preferences      │      │ response normalization  │ │
│ └──────────────────┘      │ app-data persistence    │ │
│                           └────────────┬────────────┘ │
└────────────────────────────────────────┼──────────────┘
                                         │ HTTP(S)
                              ┌──────────▼──────────┐
                              │ Ray Dashboard       │
                              │ Jobs + State APIs   │
                              └─────────────────────┘
```

The Rust backend is stateless with respect to the current screen. A view change cannot terminate or reset any Ray operation. Job submission is asynchronous and the cluster retains job information independently of the desktop process.

## Functional requirements

### Cluster connections

- Add, edit, select, and remove Dashboard endpoints.
- Accept HTTP or HTTPS URLs and normalize them to an origin.
- Report the Ray and Jobs API versions when reachable.
- Persist saved connections in the Tauri application data directory.

### Jobs

- Support entrypoint, optional submission ID, runtime environment JSON, metadata, and entrypoint CPU/GPU reservations.
- Show all submission jobs with status, entrypoint, ID, and timestamps.
- Poll while auto-refresh is enabled without tying polling to a child process.
- Load details and complete logs for the selected job.
- Permit stop only for pending/running jobs.
- Permit delete only for terminal jobs and require confirmation in the UI.
- Surface non-2xx Ray responses with the server's structured error message.

### Nodes

- Read the State API over HTTP.
- Normalize current node fields into stable ID, name, address, role, status, CPU, GPU, and memory values.
- Treat State API failure as an observability limitation; it must not corrupt job state.

### Desktop state

- React owns active view, selected cluster, selected job, connection status, recent jobs, and preferences.
- Tauri persists durable UI state as JSON in the application data directory.
- Missing fields from older state files receive safe defaults.

## Security requirements

- Do not expose filesystem, shell, or generic process-execution commands to the renderer.
- Accept only HTTP(S) Dashboard URLs.
- Percent-encode all job IDs used in URL paths.
- Keep a 12-second network timeout and return bounded error details.
- Keep the Ray Dashboard on a trusted private network or behind an authenticated proxy.
- Do not place credentials inside saved endpoint URLs.

## Acceptance criteria

- No Electron package or Ray CLI process-control code is shipped.
- Frontend tests, TypeScript compilation, Vite production build, Rust tests, Clippy, and Tauri bundle build pass.
- Backend tests exercise real local HTTP requests for list, submit, and failure responses.
- The macOS build emits a runnable `.app` and `.dmg`.
- Switching views does not affect submitted workloads or backend lifecycle.

## Future work

- OS-keychain-backed authentication headers for protected Dashboard proxies.
- WebSocket log tailing in addition to polling complete logs.
- Optional SSH/Kubernetes port-forward adapters that establish connectivity without managing Ray itself.
- Actors, tasks, workers, and resource-demand panels where State API stability is sufficient.
