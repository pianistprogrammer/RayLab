# RayLab rollout and acceptance

## 1. Network preparation

Use two machines on the same trusted private LAN/VLAN/VPN. Permit TCP traffic required by the configured Ray ports:

```text
6379
8265
10001
8076-8077
52365-52367
20000-20100
```

Do not expose these services to the public internet. Ray token authentication is an additional control, not a replacement for network isolation.

## 2. Build and install

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm check
corepack pnpm audit --audit-level high
corepack pnpm build
```

macOS output:

```text
src-tauri/target/release/bundle/macos/RayLab.app
src-tauri/target/release/bundle/dmg/RayLab_<version>_<arch>.dmg
```

Install the same RayLab build on both machines. The macOS Apple Silicon and Windows x64 release configurations include the matching `uv` installer, so Python and Ray do not need to be installed separately. First-time managed-runtime setup needs internet access. Verify the bundled executable on each target architecture before distribution. Production distribution still requires platform signing/notarization.

## 3. Coordinator acceptance

On machine A:

1. Open RayLab and choose **Host this cluster**.
2. Confirm the detected LAN address is reachable from machine B. Override it if necessary.
3. Set a small test offer, for example 2 CPUs and 0 GPUs.
4. Click **Install managed runtime** and verify Ray 2.57.0 becomes ready.
5. Click **Start coordinator**.
6. Verify status becomes `running` only after the authenticated Dashboard health check succeeds.
7. Record the displayed join address and explicitly reveal/copy the shared token.
8. Verify the Dashboard and Nodes view report machine A.

## 4. Worker acceptance

On machine B:

1. Open the same RayLab build and choose **Join a cluster**.
2. Enter only machine A's hostname/IP—not a URL and not `:6379`.
3. Paste the shared token from machine A.
4. Configure a small resource offer.
5. Install the managed Ray 2.57.0 runtime.
6. Click **Join cluster**.
7. Verify RayLab does not report `running` until machine B appears alive in A's State API.
8. On machine A, verify Nodes shows both machines and B's offered resources.

## 5. Job acceptance

Submit a harmless job from either installation:

```text
python -c "print('raylab-ok')"
```

Verify:

- Submission returns a Ray submission ID.
- Status reaches `SUCCEEDED`.
- Logs contain `raylab-ok`.
- The managed job requests one `raylab_max_jobs` slot.
- A long-running job can be stopped.
- A terminal job can be deleted after confirmation.
- Invalid runtime-environment JSON is rejected before a request is sent.
- Wrong tokens and Ray 4xx/5xx responses produce actionable errors.

## 6. Leave, stop, and role exclusivity

1. Attempt to switch machine B to Coordinator while it is sharing. The UI and Rust persistence boundary must reject the switch.
2. Click **Leave cluster** on B, then verify B disappears or becomes dead in A's Nodes view.
3. Switch B to Coordinator mode only after its lifecycle status is stopped.
4. Attempt to switch A to Worker while its coordinator is active; it must be rejected.
5. Stop A, then confirm the Dashboard is unavailable and the role can be changed.

## 7. Recovery and negative cases

- Restart RayLab while its coordinator/worker is active; status must recover from the private lifecycle marker plus Ray APIs.
- Use a wrong token; the worker must not report a successful join.
- Occupy a configured local port; startup must fail before Ray launches and identify the port.
- Enter an invalid host, URL, embedded port, negative resource value, or malformed IP; validation must reject it.
- Remove or corrupt the managed runtime; RayLab must report setup required instead of launching an arbitrary incompatible Ray.
- Navigate between Overview, Jobs, Nodes, and Settings while jobs run; navigation must not affect Ray processes or workloads.

## 8. Trust boundary

Ray executes cluster workloads as the OS user running its local processes. v0.3 must only be deployed among trusted users running trusted code. Before supporting untrusted workloads, add a dedicated unprivileged service account and container/sandbox enforcement on every worker.
