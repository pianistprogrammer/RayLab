# RayLab rollout and acceptance

## 1. Prepare the Ray cluster

RayLab expects a running Ray Dashboard with the Jobs API enabled. Cluster creation and worker lifecycle are managed outside RayLab.

- Keep the Dashboard on a private VLAN, VPN, loopback tunnel, or authenticated internal proxy.
- Confirm the intended desktop can reach `GET http://<head>:8265/api/version`.
- Confirm `GET /api/jobs/` is available.
- Enable the State API if operators need the Nodes view.
- Do not expose an unauthenticated Dashboard directly to the public internet.

## 2. Build RayLab

```bash
corepack pnpm install
corepack pnpm test
corepack pnpm check
corepack pnpm build
```

On macOS, bundles are written under:

```text
src-tauri/target/release/bundle/macos/RayLab.app
src-tauri/target/release/bundle/dmg/RayLab_<version>_<arch>.dmg
```

Production distribution still requires the appropriate platform signing and notarization credentials.

## 3. First launch

1. Open RayLab.
2. Enter a recognizable cluster name.
3. Enter the Ray Dashboard origin, normally `http://<head>:8265`.
4. Confirm the Overview reports Connected and shows the Ray version.
5. Open Dashboard and confirm it launches in the system browser.

## 4. Job acceptance checks

Use a harmless job such as `python -c "print('raylab-ok')"` with a runtime environment appropriate for the cluster.

- Submission returns a Ray submission ID.
- The job appears in the list without changing views or restarting the app.
- Status reaches a terminal state.
- Logs contain the expected output.
- A long-running test job accepts a stop request and reaches `STOPPED`.
- A terminal test job can be deleted only after confirmation.
- Invalid runtime-environment JSON is rejected before a request is sent.
- A Ray 4xx/5xx response is shown as an actionable UI error.

## 5. State and recovery checks

- Add two clusters and switch between them.
- Restart RayLab and confirm the selected cluster, active view, selected job, and refresh preference are restored.
- Stop the Dashboard and confirm RayLab reports Unavailable without crashing.
- Restore the Dashboard and confirm Refresh reconnects.
- Navigate between Overview, Jobs, Nodes, and Settings while a job runs; the job must continue independently.

## 6. Network policy

Ray Jobs execute arbitrary code by design. Treat access to the Dashboard endpoint as privileged cluster access. RayLab does not weaken or replace the cluster's network and authentication controls; it is a typed client for them.
