# PRD: RayLab
**A desktop app for opt-in/opt-out sharing of university lab GPU machines via Ray**

Version 0.1 — Draft for review
Author: Jerry (Jeremiah Abimbola)

---

## 1. Executive Summary

Your lab has many RTX-equipped Windows/Linux machines, some in the server room, most idle outside working hours. The goal is a desktop app that lets any machine owner opt their GPU in or out of a shared Ray cluster, so idle capacity can be borrowed for ML/LLM/compute jobs by other lab members, without owners losing control over their machine or exposing their personal files.

**Recommendation up front, before the details:** build **one application**, not two. It ships in two roles — **Coordinator** (one instance, run by whoever hosts the head node) and **Node** (every participating machine) — selected at first launch and switchable later. The current implementation uses **Electron with a local backend exposed through a narrow IPC bridge**, and treats Ray's own security model as insufficient on its own — real node-level privacy requires OS-level sandboxing, not just Ray's scheduling hints. That correction is important enough that it gets its own section below before anything else, because it changes the architecture.

---

## 2. Critical Correction: the "isolated custom resource" trick does not give you privacy

The earlier sketch proposed tagging each node with a custom Ray resource like `{"192.168.1.50_isolated": 1}` and pinning file-reading tasks to that resource, presented as something that "completely solves" the privacy problem. **This does not hold up**, and it's worth being explicit about why, since it would otherwise become a false sense of security baked into the architecture.

- Ray's own security documentation states plainly that Ray does not enforce isolation between jobs on a shared cluster, and does not implement an access-control/authorization model at all — anyone who can reach the cluster's job-submission or dashboard endpoints can run arbitrary code on any node in it. <cite index="20-1">Ray can schedule multiple distinct jobs in a single cluster, but doesn't attempt to enforce isolation between them, and Ray doesn't implement access controls for developers interacting with a given cluster.</cite>
- Custom resource tags like `{"ip_isolated": 1}` are **scheduling hints**, not permissions. They tell the scheduler "prefer this node," but nothing stops any other authorized client from submitting a task that requests that same resource tag and running arbitrary code on that node — including reading whatever files the OS user running `ray start` can read.
- <cite index="20-1">Ray extensively uses cloudpickle for serialization of arbitrary Python objects, and exposing the Dashboard, Ray Jobs, or Ray Client services means anybody who can access the associated ports can execute arbitrary code on the cluster</cite> — explicitly, indirectly via the REST API, or implicitly via pickled objects.
- This isn't hypothetical: <cite index="22-1">a documented advisory found that in the default configuration Ray does not enforce authentication, so an attacker can submit arbitrary OS commands for execution via the job submission API with just network access to the dashboard port</cite>, and even Ray's optional TLS mode has no concept of per-user permission levels — it's all-or-nothing.
- The good news: Ray 2.52+ ships a real fix for the *access* half of this problem. <cite index="20-1">Ray now supports built-in token authentication as an additional measure to prevent unauthorized access to the cluster, including untrusted code execution — but token authentication is explicitly not a substitute for deploying Ray inside a controlled network environment.</cite> It keeps outsiders out; it does not give you per-node file privacy between people who are all legitimately in the cluster.

**What this means for the product:** node-level file privacy has to be enforced *outside* Ray, at the OS/process level, not through Ray resource tags. Section 8 below lays out how the app should actually do this. This is the single most important design decision in this PRD — get it right and the "opt in/opt out with confidence" pitch is real; skip it and the app is a UI on top of a false promise.

---

## 3. Goals

1. Any lab machine owner can join/leave the compute pool with one toggle, with **their own file system genuinely protected**, not just nominally protected.
2. A coordinator (you, or whoever's running the head node) can see cluster state, submit jobs, and monitor GPU/CPU/RAM usage across nodes, including LLM inference/fine-tuning workloads.
3. Owners can configure *when* and *how much* of their machine is shared — not just on/off.
4. The Ray dashboard remains available for deep debugging, without making it the primary interface.
5. Look and feel like a real product — this is going on lab machines other people didn't build, so it needs to look trustworthy, not like a hackathon script with a toggle switch.

## 4. Non-goals (v1)

- Multi-cluster federation across universities/labs.
- Billing/chargeback for compute usage.
- Full MLOps job scheduling UI (queueing, DAGs) — v1 hands off to Ray's own job API and existing notebook/CLI workflows; the app's job is cluster membership and trust, not being a new Airflow.

---

## 5. Users

| Persona | Role | Cares about |
|---|---|---|
| **Node owner** | Grad student / lab member with a GPU workstation | "My files are safe. I can pull out instantly. It doesn't hog my machine when I'm working." |
| **Coordinator / cluster admin** | You, or lab IT | "I can see what's online, submit jobs, know who's misbehaving, keep the network sane." |
| **Job submitter** | Anyone running ML/LLM jobs on the pool | "I can get GPUs when they're free, without babysitting SSH sessions." |

These can be the same person on different days, which is exactly why one app with a role toggle is right — see Section 6.

---

## 6. One app or two?

**One app, two modes.** Reasons:

- Most lab members will be *both* a node owner (sharing idle time) and a job submitter (using the pool when they need it) on different days. Two separate installers means people install the wrong one, or need both anyway.
- Coordinator role is just "Node mode, plus head-node responsibilities, plus a cluster-wide view" — it's a superset of the node feature set (owns the same privacy/toggle controls for its own machine, since the head node's owner has the same rights as anyone else), not a different product.
- One codebase, one update channel, one thing to audit for security review — meaningfully less surface area given this is going to run with elevated trust on machines you don't fully control.

**How the mode is chosen:** at first launch, a simple picker — "Host this cluster" (Coordinator) vs "Join a cluster" (Node), with the server address/token entered directly. The mode is stored locally and changeable from settings later. Internally this just changes which panels render and whether `ray start --head` vs `ray start --address=...` is used — see Section 9.

---

## 7. Architecture

### 7.1 Shell: Electron Desktop App

RayLab now runs as an Electron desktop app. The frontend is isolated from privileged operations, and Ray control is exposed through a small allowlisted IPC surface rather than direct renderer access to Node or shell commands.

- Electron gives the app a predictable cross-platform desktop runtime and packaging path while keeping the Ray control plane in one local backend layer.
- The preload bridge should remain narrow and explicit: renderer code asks for app operations such as diagnostics, hardware detection, setup status, discovery, and Ray start/stop; it should not receive broad filesystem or process access.
- Ray process management, setup checks, port diagnostics, local storage, hardware detection, and cluster discovery belong in the Electron backend modules. The UI should render state and send user intent, not assemble shell commands itself.
- Any Python utilities used by the app are implementation details of the backend/runtime setup. The user-facing product should never depend on a system Python or a manually installed `ray` executable.

### 7.2 Components

```
┌────────────────────────────────────────────────────────────┐
│  RayLab (Electron app, same binary everywhere)               │
│                                                                │
│  ┌──────────────┐       IPC       ┌─────────────────────┐   │
│  │  Renderer UI  │◄───────────────►│  Electron backend    │   │
│  │  (React)      │                 │  - ray start/stop    │   │
│  │  (settings,   │                 │  - setup checks      │   │
│  │   node table) │                 │  - discovery/status  │   │
│  └──────┬───────┘                 └─────────┬──────────────┘   │
│         │ OS APIs (tray, notifications,      │ Ray CLI / Job    │
│         │ autostart, secure storage)          │ Submission API   │
└─────────┼──────────────────────────────────────┼───────────────┘
          │                                       │
          ▼                                       ▼
   local machine (this node)              Ray head node (coordinator)
                                           token-authenticated, on the
                                           lab's private network/VLAN
```

- **Electron shell**: window, system tray icon (green/amber/red = connected/idle/off), OS notifications, autostart-on-boot toggle, secure local credential storage for the cluster token.
- **Electron backend**: the only layer that touches Ray. Owns starting/stopping `ray start`, setup/readiness checks, enforcing the local policy (schedule windows, resource caps, folder allowlists — Section 8), and talking to the Ray Job Submission API for the Coordinator's job-launch panel.
- **No direct renderer-to-Ray communication** — keeping Ray control entirely behind backend handlers means one code path to audit for "what can this app actually do to the cluster," instead of scattering shell access through the UI.

### 7.3 Ray dashboard access

Don't embed it as a first-class tab inside the app's webview. Ray's dashboard is its own full web app with its own auth flow, and the RayLab UI should not proxy someone else's SPA reliably across versions. Instead:

- A **"Open Dashboard"** button opens the Ray dashboard in the user's default system browser at `http://<head-ip>:8265`, the same way you already open the token dashboard today.
- The Coordinator backend can pre-fetch the auth token and either copy it to the clipboard with a toast ("Token copied — paste when prompted") or, if you want to go further later, run local port-forwarding for remote nodes so people don't need direct network access to 8265. <cite index="18-1">Connecting to the Ray dashboard this way configures secure SSH port forwarding between the local machine and the Ray cluster, and the token gets stored as a cookie for up to 30 days</cite>, so this is a one-time-per-month annoyance at worst, not a recurring one.
- v2 idea, not v1: an *optional* embedded read-only summary panel (node list, GPU utilization sparkline) built by polling the dashboard's REST API directly from the local backend and rendering it in your own styled widgets — gives you the "beautiful modern UI" without trying to reskin Ray's own dashboard.

---

## 8. Node-level opt-in/opt-out settings — the actual feature set

This is the part node owners will actually look at before they trust the app with their GPU. Each setting should be per-node, stored locally (not dictated by the coordinator, except where noted), and changeable without restarting the app.

### 8.1 Participation controls
- **Master toggle** — Join / Leave cluster, immediate effect (`ray start` / `ray stop`, see Section 9 for what "stop" actually guarantees).
- **Schedule windows** — e.g. "only available 10pm–7am weekdays, all day weekends," with a manual override that always wins over the schedule.
- **Idle-only mode** — auto-join only when the node has been below an owner-set CPU/GPU-utilization threshold for N minutes (useful default: join after 10 min idle, leave immediately on local activity).
- **Panic/kill switch** — one click, force-stops all Ray processes on this node and refuses new jobs for the rest of the session, regardless of schedule.

### 8.2 Resource caps (what the node *offers*, not what a job can grab from elsewhere)
- GPU memory ceiling (e.g. "offer up to 12GB of this 24GB card").
- CPU core count / percentage cap.
- System RAM cap.
- Max concurrent jobs on this node.
- These map directly onto Ray's `--num-cpus`, `--num-gpus`, `--memory`, `--resources` flags at `ray start` time — real resource limits enforced by Ray's scheduler, as distinct from the custom "isolation" tags discussed in Section 2, which are not enforcement.

### 8.3 Privacy controls (the part that needs real enforcement, not resource tags)
Given Section 2's finding that Ray provides no code isolation between cluster participants, the app needs to enforce privacy itself:

- **Run Ray worker processes as a dedicated, unprivileged local account** (`raylab-worker` on Windows/Linux) created by the installer, with no access to the owner's home directory, documents, browser profiles, or credentials — not the owner's own login. This is the actual fix for "can another node's job read my files," because it's an OS permission boundary, not a Ray-level one.
- **Restrict each job's writable/readable working directory** using Ray's `runtime_env` `working_dir`, so a submitted job only sees the files explicitly shipped with the job, not the node's filesystem at large.
- **No shared filesystem mounts** between nodes by default — if a job needs data, it ships with the job or pulls from a lab-internal object store/S3-compatible bucket, never from `C:\Users\<owner>\...` on someone else's box.
- **Container/sandbox execution for job code** where GPU support allows it (Docker with `--gpus`, or Apptainer/Singularity, common in university HPC contexts) — job code runs inside a container with only the resources the coordinator's policy allows, further limiting blast radius beyond the unprivileged-user boundary.
- **Owner-visible audit log**: every job that ran on this node, submitter identity (via the auth token — Section 9), start/end time, resource usage — visible in the node's local UI, so "who used my machine and for what" is never a mystery.

### 8.4 What owners should *not* be told they get, so expectations stay honest
- The resource-tag trick from the original draft does not belong in the product at all, per Section 2 — don't ship it as a privacy feature even as a stopgap, because it will be read by owners as a guarantee it can't back up.
- Full workload confidentiality (e.g., "no one at SAP/Anthropic/anywhere can ever infer what a job computed from side channels") is out of scope — this is a university lab pool among people who already trust each other with lab access, not a cloud multi-tenant platform. Say that plainly in onboarding copy so nobody over-relies on it for something sensitive.

---

## 9. Security architecture (coordinator side)

- **Token authentication, always on.** <cite index="20-1">Starting in Ray 2.52.0, Ray supports built-in token authentication that provides an additional measure to prevent unauthorized access to the cluster, including untrusted code execution</cite> — the app should generate this token at cluster creation and require it for every node to join, never expose an open cluster as a supported configuration.
- **Network scope, not just app-level auth.** <cite index="11-1">Ray expects to run in a safe network environment and to act upon trusted code — network traffic between core Ray components should always be in a controlled, isolated network, and access to additional services should be gated with strict network controls</cite>. Practically: put the cluster on the lab's private VLAN or a WireGuard/Tailscale overlay, never expose port 6379/8265 to the open internet or the university's general campus network.
- **Submitter allowlist**, separate from node membership — being a node owner doesn't automatically grant job-submission rights; the coordinator maintains who can submit jobs, distinct from who can host a worker.
- **Per-job resource requests are advisory unless capped by policy** — the coordinator UI should let the admin see and, if needed, kill any running job across the whole pool, since Ray itself won't stop a runaway job from monopolizing a node.
- **Dashboard token handling** as described in 7.3 — token stored for the session, never logged, never included in crash reports.

---

## 10. UI/UX direction

Professional, calm, information-dense but not cluttered — think a lightweight ops dashboard, not a consumer toggle app. Concretely:

- **System tray icon** as the ambient status indicator (idle/off = gray, sharing = green, coordinator = blue accent), with a quick-toggle in the tray menu so owners don't need to open the full window to opt out.
- **Home screen (Node mode)**: one big status card ("Sharing — 8GB GPU offered, 2 jobs running"), the master toggle, and a compact schedule/resource-cap panel below it.
- **Home screen (Coordinator mode)**: a node grid/table — one row per machine, live GPU/CPU/RAM sparkline, status, owner, last-seen — plus a "Submit job" panel and the "Open Dashboard" button from 7.3.
- **Settings**: privacy controls from Section 8.3 front and center, not buried — this is the trust-building surface, so it should look considered, not like an afterthought settings page.
- Use `frontend-design` conventions for actual implementation (type scale, spacing, restrained color palette) when building the Electron renderer UI.

---

## 11. Phased roadmap

**Phase 1 — Trusted core (MVP)**
Single Electron app, mode picker, master toggle, resource caps, token-authenticated cluster join, dedicated unprivileged worker account, "Open Dashboard" button, basic node table for coordinator.

**Phase 2 — Real privacy hardening**
Container/sandbox execution per job, per-node audit log UI, submitter allowlist management, schedule windows + idle-only auto-join.

**Phase 3 — Polish & scale**
Embedded read-only cluster summary widgets (pulled from dashboard REST API), notifications ("Your machine just started a job"), autostart-on-boot, installer signing/distribution for the lab.

---

## 12. Open questions for you

1. Head node placement: always the server-room machine, or should Coordinator mode be portable (you host from your own laptop sometimes)? Affects whether the token/config needs to survive a head-node move.
2. OS mix — pure Windows, or Linux boxes in the server room too? Affects the "dedicated unprivileged account" implementation (Windows local user vs. Linux systemd user) and container tooling choice (Docker Desktop vs. Apptainer).
3. LLM workloads specifically — do you want model-weight caching shared across nodes (so a 70B model isn't re-downloaded per job), or is each job fully self-contained? This affects whether you need any shared, access-controlled storage at all, given Section 8.3's "no shared filesystem" default.
4. How strict should submitter trust be — is "everyone with lab door access" an acceptable trust boundary, or do you want individual per-person tokens with revocation from day one?

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Owner disables antivirus exception / firewall blocks Ray ports | Ship a first-run network check with plain-English diagnostics |
| A node's "leave cluster" doesn't actually stop an in-flight job cleanly | `ray stop` should wait for/forcibly terminate local worker processes with a visible countdown, not silently no-op |
| GPU driver conflicts across mixed RTX generations | Out of scope for the app itself; document as a lab-ops prerequisite, not something the toggle can fix |
| Someone submits a job that ignores resource caps | Caps are enforced Ray-side at `ray start` (real limits), not relying on job cooperation — reinforce in testing |

---

This PRD should stay aligned with the Electron implementation as the product hardens.
