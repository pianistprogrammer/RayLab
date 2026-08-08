# RayLab

Desktop app for opt-in/opt-out sharing of university lab GPU machines through Ray.

## Development

```bash
python3 -m pip install -e "sidecar[test]"
pnpm install
pnpm sidecar:dev
pnpm dev
```

For the native shell:

```bash
pnpm tauri:dev
```

## Safety Model

- Ray is controlled only by the Python FastAPI sidecar.
- Node sharing requires a dedicated `raylab-worker` account.
- Coordinator networking is private-VLAN only by default.
- Job data should come from a lab object store, not owner home directories.
- Dashboard opens externally in the system browser.

See [docs/rollout.md](docs/rollout.md) for OS setup and acceptance checks.
