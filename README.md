# RayLab

RayLab is a Tauri desktop control plane that can run in exactly one of two roles:

- **Coordinator:** starts a Ray head node and provides the address/token other RayLab installations use to join.
- **Worker:** joins a coordinator and offers a configurable amount of the local machine's CPU and GPU capacity.

The same app also submits durable jobs, reads logs, stops/deletes jobs, and shows cluster nodes through Ray's Jobs and State HTTP APIs.

## Architecture

```text
React + Zustand
      │ typed Tauri commands
      ▼
Rust desktop service
      ├── persisted role and UI state
      ├── private cluster-token storage
      ├── managed Python 3.11 + Ray 2.57.0 runtime
      ├── fixed local Ray start/stop lifecycle adapter
      └── Ray Jobs + State HTTP client
```

RayLab does not expose a shell or generic process command to React. The local lifecycle adapter executes only validated Ray start/stop operations and does not parse CLI status or job output. Jobs, logs, health, and node confirmation remain API-first.

## First launch

### Host a cluster

1. Choose **Host this cluster**.
2. Confirm the detected node address and CPU/GPU offer.
3. Install the managed Ray runtime when prompted.
4. Click **Start coordinator**.
5. Share the displayed join address and cluster token with trusted workers.

### Join as a worker

1. Choose **Join a cluster**.
2. Enter the coordinator hostname/IP and shared token.
3. Choose the CPUs and GPUs this machine should offer.
4. Install the managed Ray runtime when prompted.
5. Click **Join cluster**.

Use **Stop coordinator** or **Leave cluster** before switching roles in Settings. RayLab will reject a role switch while its local Ray node is active.

## Managed cluster operations

| Operation | Backend |
|---|---|
| Start Coordinator | Typed `ray start --head` lifecycle adapter |
| Join as Worker | Typed `ray start --address=…` lifecycle adapter |
| Stop/Leave | Owned `ray stop --force` lifecycle adapter |
| Health | `GET /api/version` |
| Submit/List/Inspect Jobs | Ray Jobs REST API |
| Job logs/stop/delete | Ray Jobs REST API |
| Confirm/list nodes | Ray State REST API |

## Network requirements

All machines need the same RayLab/Ray version and a trusted private LAN, VLAN, or VPN. The default ports are:

- `6379`: worker join/GCS
- `8265`: Dashboard, Jobs, and State APIs
- `10001`: Ray Client
- `8076-8077`: object/node managers
- `52365-52367`: Ray agents
- `20000-20100`: worker processes

Ray token authentication is enabled for role-managed clusters. Tokens are stored outside desktop state and protected as `0600` files on Unix. Do not expose Ray control ports to the public internet.

Ray workers currently run as the signed-in OS user, so v0.3 is for trusted cluster participants and trusted workloads. Dedicated service accounts/container isolation remain future hardening.

## Development

Requirements:

- Node.js 20+ with Corepack
- Rust 1.88 (pinned by `rust-toolchain.toml`)
- `uv` or Python 3.10+ for in-app Ray runtime installation

```bash
corepack pnpm install
corepack pnpm dev
```

## Verification

```bash
corepack pnpm test
corepack pnpm check
corepack pnpm audit --audit-level high
corepack pnpm build
```

See [RayLabCluster_PRD.md](RayLabCluster_PRD.md) for product requirements and [docs/rollout.md](docs/rollout.md) for two-machine acceptance testing.
