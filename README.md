# RayLab

Desktop app for opt-in/opt-out sharing of university lab GPU machines through Ray.

## Development

```bash
python3 -m pip install -e "sidecar[test]"
pnpm install
pnpm sidecar:dev
pnpm dev
```

For the Electron desktop shell:

```bash
pnpm electron:dev
```

## Safety Model

- Ray is controlled only by RayLab's local desktop backend.
- Node sharing requires a dedicated `raylab-worker` account.
- Coordinator networking is private-VLAN only by default.
- Job data should come from a lab object store, not owner home directories.
- Dashboard opens externally in the system browser.

See [docs/rollout.md](docs/rollout.md) for OS setup and acceptance checks.
