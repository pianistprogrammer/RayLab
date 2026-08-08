import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleStop,
  Database,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Play,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  UserPlus,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { cacheConfig, useStore } from "./store";
import type { AppConfig, AppMode, AuditEvent, ClusterState, ClusterStatus, DiagnosticCheck, DiscoveryCandidate, HardwareInfo, InstallStatus, JobSubmission, NodeInfo, ScheduleWindow, SetupRunStatus, SetupTask, TerminalLogEntry } from "./types";

type View = "home" | "graph" | "submit-job" | "submitters" | "setup" | "diagnostics" | "settings" | "audit";

function cls(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

// Spinning loader icon — reuses the existing `spin` keyframe in styles.css
function Spinner({ size = 17 }: { size?: number }) {
  return <RefreshCw size={size} style={{ animation: "spin 0.7s linear infinite" }} />;
}

export function App() {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const sidecarReady = useStore((s) => s.sidecarReady);
  const activeAction = useStore((s) => s.activeAction);
  const modeSaving = useStore((s) => s.modeSaving);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const setupRun = useStore((s) => s.setupRun);
  const refresh = useStore((s) => s.refresh);
  const setNotice = useStore((s) => s.setNotice);
  const persistMode = useStore((s) => s.persistMode);
  const runAction = useStore((s) => s.runAction);

  const [view, setView] = useState<View>("home");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [roleSwitchTarget, setRoleSwitchTarget] = useState<AppMode | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const nodeSetupStarted = useRef(false);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (config.app_mode !== "coordinator" && (view === "graph" || view === "submit-job" || view === "submitters")) {
      setView("home");
    }
  }, [config.app_mode, view]);

  useEffect(() => {
    if (config.app_mode !== "node") {
      nodeSetupStarted.current = false;
      return;
    }
    if (!sidecarReady || !setupRun || setupRun.running || setupRun.can_continue || nodeSetupStarted.current) return;
    nodeSetupStarted.current = true;
    const timer = window.setTimeout(() => {
      void api.runSetup().then(() => refresh()).catch(() => refresh());
    }, 750);
    return () => window.clearTimeout(timer);
  }, [config.app_mode, refresh, setupRun, sidecarReady]);

  const state = status?.state ?? "stopped";
  const anyBusy = activeAction !== null;
  const actionsReady = sidecarReady && status !== null;

  function changeMode(mode: AppMode) {
    if (mode !== config.app_mode && config.app_mode !== "unconfigured" && state !== "stopped" && state !== "error") {
      setRoleSwitchTarget(mode);
      return;
    }
    setView("home");
    persistMode(mode);
  }

  async function stopAndSwitchMode(mode: AppMode) {
    setRoleSwitchTarget(null);
    setTerminalOpen(true);
    await runAction(async () => {
      await api.stop();
      persistMode(mode);
    }, "Ray stopped; role switch requested", "stop-switch");
  }

  async function handleManualRefresh() {
    setManualRefreshing(true);
    try {
      await refresh();
      setNotice("Refreshed just now");
    } finally {
      setManualRefreshing(false);
    }
  }

  const isRunning = state === "running";
  const isStarting = state === "starting";
  const isStopping = state === "stopping";
  const isStopped = state === "stopped";
  const coordinatorReachable = status?.diagnostics.some((check) => check.id === "ray_port" && check.status === "pass") ?? false;
  const setupRequired = config.app_mode === "node" && !setupRun?.can_continue && !coordinatorReachable;
  const startDisabled = !actionsReady || anyBusy || setupRequired || isRunning || isStarting || isStopping;
  const stopDisabled = !actionsReady || anyBusy || isStopped || isStarting || isStopping;
  const startTitle = !actionsReady ? "Waiting for the app to finish starting" : setupRequired ? "Run setup or enter a reachable coordinator address before starting" : "Start Ray";
  const stopTitle = !actionsReady ? "Waiting for the app to finish starting" : "Stop Ray";

  if (config.app_mode === "unconfigured") {
    return <RolePicker onChoose={changeMode} busy={!sidecarReady || anyBusy || modeSaving} />;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Server size={24} /><span>RayLab</span></div>
        <button className={cls("nav", view === "home" && "active")} onClick={() => setView("home")}><LayoutDashboard size={18} />Home</button>
        {config.app_mode === "coordinator" && <button className={cls("nav", view === "graph" && "active")} onClick={() => setView("graph")}><Boxes size={18} />Graph</button>}
        {config.app_mode === "coordinator" && <button className={cls("nav", view === "submit-job" && "active")} onClick={() => setView("submit-job")}><Terminal size={18} />Submit Job</button>}
        {config.app_mode === "coordinator" && <button className={cls("nav", view === "submitters" && "active")} onClick={() => setView("submitters")}><KeyRound size={18} />Submitters</button>}
        <button className={cls("nav", view === "setup" && "active")} onClick={() => setView("setup")}><ListChecks size={18} />Setup</button>
        <button className={cls("nav", view === "diagnostics" && "active")} onClick={() => setView("diagnostics")}><AlertTriangle size={18} />Diagnostics</button>
        <button className={cls("nav", view === "settings" && "active")} onClick={() => setView("settings")}><Settings size={18} />Settings</button>
        <button className={cls("nav", view === "audit" && "active")} onClick={() => setView("audit")}><Activity size={18} />Audit</button>
        <SidebarStatus />
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{config.app_mode === "coordinator" ? "Coordinator" : "Node"} mode</p>
            <h1>{config.app_mode === "coordinator" ? "Cluster operations" : "Local sharing controls"}</h1>
          </div>
          <div className="actions">
            <label className="mode-control" title="Machine role is saved locally">
              <span>Role</span>
              <select value={config.app_mode} onChange={(e) => changeMode(e.target.value as AppMode)} disabled={!actionsReady || anyBusy || modeSaving}>
                <option value="coordinator">Host</option>
                <option value="node">Join</option>
              </select>
              {modeSaving && <><Spinner size={14} /><small className="mode-saving">Saving…</small></>}
            </label>
            <button className="ghost" onClick={() => setTerminalOpen((o) => !o)}><Terminal size={17} />Terminal</button>
            <button className="icon-button" title="Refresh" onClick={() => void handleManualRefresh()} disabled={manualRefreshing}>
              {manualRefreshing ? <Spinner /> : <RefreshCw size={18} />}
            </button>
            <button title={startTitle} onClick={() => { setTerminalOpen(true); void runAction(api.start, "Ray start requested", "start"); }} disabled={startDisabled}>
              {activeAction === "start" ? <Spinner /> : <Play size={17} />}Start
            </button>
            <button title={stopTitle} onClick={() => { setTerminalOpen(true); void runAction(api.stop, "Ray stop requested", "stop"); }} disabled={stopDisabled}>
              {activeAction === "stop" ? <Spinner /> : <Square size={17} />}Stop
            </button>
            <button className="danger" title={stopTitle} onClick={() => { setTerminalOpen(true); void runAction(api.panic, "Panic stop requested", "panic"); }} disabled={stopDisabled}>
              {activeAction === "panic" ? <Spinner /> : <CircleStop size={17} />}Panic
            </button>
          </div>
        </header>

        {error && <div className="banner error"><AlertTriangle size={18} />{error}</div>}
        {notice && <NoticeBanner message={notice} onDone={() => setNotice(null)} />}

        {view === "home" && (config.app_mode === "coordinator" ? <CoordinatorHome /> : <NodeHome />)}
        {view === "graph" && config.app_mode === "coordinator" && <ClusterGraphView />}
        {view === "submit-job" && config.app_mode === "coordinator" && <SubmitJobView />}
        {view === "submitters" && config.app_mode === "coordinator" && <SubmittersView />}
        {view === "setup" && <SetupView />}
        {view === "diagnostics" && <DiagnosticsView />}
        {view === "settings" && <SettingsView />}
        {view === "audit" && <AuditView />}
        {terminalOpen && <TerminalDock close={() => setTerminalOpen(false)} />}
        {roleSwitchTarget && (
          <RoleSwitchPrompt
            currentMode={config.app_mode}
            targetMode={roleSwitchTarget}
            state={state}
            cancel={() => setRoleSwitchTarget(null)}
            stopAndSwitch={() => void stopAndSwitchMode(roleSwitchTarget)}
          />
        )}
      </section>
    </main>
  );
}

// Slides in, holds for 2.5s, then slides out and notifies parent.
function NoticeBanner({ message, onDone }: { message: string; onDone: () => void }) {
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    const hold = setTimeout(() => setDismissing(true), 2500);
    return () => clearTimeout(hold);
  }, [message]);

  return (
    <div
      className={cls("banner success", dismissing && "dismissing")}
      onAnimationEnd={() => { if (dismissing) onDone(); }}
    >
      <CheckCircle2 size={18} />{message}
    </div>
  );
}

function SidebarStatus() {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const sidecarReady = useStore((s) => s.sidecarReady);
  const state = sidecarReady && status ? status.state : "starting";
  const label = state === "running"
    ? "Ray is running"
    : state === "error"
      ? "Needs attention"
      : state === "starting"
        ? "Starting"
        : state === "stopping"
          ? "Stopping"
          : "Not running";
  const detail = sidecarReady ? (config.app_mode === "coordinator" ? "Host mode" : "Join mode") : "Starting app";
  const joinAddress = config.app_mode === "coordinator" && state === "running"
    ? status?.address ?? `${config.coordinator.head_host}:${config.coordinator.ray_port}`
    : null;
  return (
    <div className="sidebar-status">
      <span className={cls("dot", state)} />
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
        {joinAddress && <small className="join-address">Join address: <code>{joinAddress}</code></small>}
      </div>
    </div>
  );
}

function RolePicker({ onChoose, busy }: { onChoose: (mode: Exclude<AppMode, "unconfigured">) => void; busy: boolean }) {
  const config = useStore((s) => s.config);
  const error = useStore((s) => s.error);
  return (
    <main className="role-screen">
      <section className="role-panel">
        <div className="brand large"><Server size={28} /><span>RayLab</span></div>
        <h1>Choose how this machine participates</h1>
        <div className="role-grid">
          <button disabled={busy} onClick={() => onChoose("coordinator")}>
            {busy ? <Spinner size={26} /> : <Server size={26} />}
            <strong>Host this cluster</strong>
            <span>Run the fixed server-room Ray head and manage submitters, jobs, and nodes.</span>
          </button>
          <button disabled={busy} onClick={() => onChoose("node")}>
            {busy ? <Spinner size={26} /> : <Boxes size={26} />}
            <strong>Join a cluster</strong>
            <span>Offer this machine's GPU under local schedule, privacy, and resource policies.</span>
          </button>
        </div>
        {error && <div className="banner error"><AlertTriangle size={18} />{error}</div>}
        <small>Default head address: {config.coordinator.head_host}:{config.coordinator.ray_port}</small>
      </section>
    </main>
  );
}

function RoleSwitchPrompt({ currentMode, targetMode, state, cancel, stopAndSwitch }: { currentMode: AppMode; targetMode: AppMode; state: ClusterState; cancel: () => void; stopAndSwitch: () => void }) {
  const activeAction = useStore((s) => s.activeAction);
  const currentLabel = currentMode === "coordinator" ? "Host" : currentMode === "node" ? "Join" : "Unconfigured";
  const targetLabel = targetMode === "coordinator" ? "Host" : targetMode === "node" ? "Join" : "Choose mode";
  const canStop = state === "running";

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="role-switch-title">
        <div className="panel-title"><AlertTriangle size={19} /><h2 id="role-switch-title">Stop Ray Before Switching</h2></div>
        <p>Ray is currently {state} while this machine is in {currentLabel} mode. Stop the current Ray process before switching to {targetLabel} mode.</p>
        <div className="modal-actions">
          <button className="ghost" onClick={cancel} disabled={activeAction === "stop-switch"}>Stay {currentLabel}</button>
          <button className="danger" onClick={stopAndSwitch} disabled={!canStop || activeAction === "stop-switch"}>
            {activeAction === "stop-switch" ? <Spinner /> : <Square size={17} />}Stop and Switch
          </button>
        </div>
      </section>
    </div>
  );
}

function CoordinatorHome() {
  const config = useStore((s) => s.config);
  const nodes = useStore((s) => s.nodes);
  const hardware = useStore((s) => s.hardware);
  const saveConfig = useStore((s) => s.saveConfig);
  const activeAction = useStore((s) => s.activeAction);
  const [draft, setDraft] = useState<AppConfig>(config);
  // Track the config version the draft was last synced from.
  // We only overwrite the draft when the server returns a config that differs
  // from what we last saved — i.e. an external change, not just a poll echo.
  const savedConfigRef = useRef(config);

  useEffect(() => {
    // If the incoming config differs from what we last saved, it means the
    // server state changed externally — accept it. Otherwise leave draft alone
    // so in-progress edits (like clicking a preset) are not overwritten.
    if (config !== savedConfigRef.current) {
      savedConfigRef.current = config;
      setDraft(config);
    }
  }, [config]);

  async function handleSave(next: AppConfig) {
    savedConfigRef.current = next; // mark as saved before the round-trip
    await saveConfig(next);
  }

  function updateCoordinator(patch: Partial<AppConfig["coordinator"]>) {
    setDraft((d) => ({ ...d, coordinator: { ...d.coordinator, ...patch } }));
  }
  function updateCaps(patch: Partial<AppConfig["resource_caps"]>) {
    setDraft((d) => ({ ...d, resource_caps: { ...d.resource_caps, ...patch } }));
  }
  function applyLaunchPreset(external: boolean) {
    setDraft((d) => {
      const next: AppConfig = {
        ...d,
        coordinator: {
          ...d.coordinator,
          allow_external_workers: external,
          dashboard_host: external ? "0.0.0.0" : "127.0.0.1",
          node_ip_address: external ? d.coordinator.node_ip_address : "",
        },
      };
      // Save immediately — preset is a deliberate mode choice, not a form field.
      void handleSave(next);
      return next;
    });
  }

  async function openDashboard() {
    try {
      await invoke("open_dashboard", { url: `http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}` });
    } catch {
      window.open(`http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}`, "_blank");
    }
  }

  const commandPreview = useMemo(() => buildCoordinatorCommandPreview(draft), [draft]);

  return (
    <div className="grid two">
      <section className="panel wide">
        <div className="panel-title">
          <SlidersHorizontal size={19} /><h2>Coordinator Start Configuration</h2>
          <button onClick={() => void handleSave(draft)} disabled={activeAction === "save"}>
            {activeAction === "save" ? <Spinner /> : <Save size={17} />}Save launch config
          </button>
        </div>
        <div className="launch-grid">
          <div>
            <p className="field-label">Cluster exposure</p>
            <div className="segmented launch-mode">
              <button className={!draft.coordinator.allow_external_workers ? "active" : ""} onClick={() => applyLaunchPreset(false)}>Local only</button>
              <button className={draft.coordinator.allow_external_workers ? "active" : ""} onClick={() => applyLaunchPreset(true)}>External workers</button>
            </div>
          </div>
          <label>Head address for workers<input value={draft.coordinator.head_host} onChange={(e) => updateCoordinator({ head_host: e.target.value })} /></label>
          <label>Dashboard bind host<input value={draft.coordinator.dashboard_host} onChange={(e) => updateCoordinator({ dashboard_host: e.target.value })} /></label>
          <label>Node IP override<input placeholder="blank = Ray auto-detects" value={draft.coordinator.node_ip_address} onChange={(e) => updateCoordinator({ node_ip_address: e.target.value })} /></label>
          <NumberField label="Ray head port" value={draft.coordinator.ray_port} onChange={(ray_port) => updateCoordinator({ ray_port })} />
          <NumberField label="Dashboard port" value={draft.coordinator.dashboard_port} onChange={(dashboard_port) => updateCoordinator({ dashboard_port })} />
          <NumberField label="Ray Client port" value={draft.coordinator.client_port} onChange={(client_port) => updateCoordinator({ client_port })} />
          <NumberField label={<LabelWithDetected label="CPUs offered" detected={formatCpuDetected(hardware)} />} value={draft.resource_caps.cpus} onChange={(cpus) => updateCaps({ cpus })} />
          <NumberField label={<LabelWithDetected label="GPUs offered" detected={formatGpuDetected(hardware)} />} value={draft.resource_caps.gpus} onChange={(gpus) => updateCaps({ gpus })} />
          <NumberField label={<LabelWithDetected label="System RAM offered" detected={formatMemoryDetected(hardware)} />} value={draft.resource_caps.memory_gb} onChange={(memory_gb) => updateCaps({ memory_gb })} />
          <NumberField label="Max concurrent jobs" value={draft.resource_caps.max_concurrent_jobs} onChange={(max_concurrent_jobs) => updateCaps({ max_concurrent_jobs })} />
          <label className="check"><input type="checkbox" checked={draft.coordinator.bind_private_only} onChange={(e) => updateCoordinator({ bind_private_only: e.target.checked })} />Private network only</label>
        </div>
        <pre className="command-preview">{commandPreview}</pre>
      </section>

      <section className="panel wide">
        <div className="panel-title"><Users size={19} /><h2>Nodes</h2><button className="ghost" onClick={() => void openDashboard()}><ExternalLink size={16} />Dashboard</button></div>
        <table>
          <thead><tr><th>Machine</th><th>Status</th><th>CPU</th><th>GPU</th><th>RAM</th><th>Last seen</th></tr></thead>
          <tbody>
            {nodes.length === 0 && <tr><td colSpan={6}>No Ray nodes reported yet.</td></tr>}
            {nodes.map((node) => <tr key={node.node_id}><td>{node.hostname}</td><td>{node.status}</td><td>{node.cpus_total}</td><td>{node.gpus_total}</td><td>{node.memory_total_gb.toFixed(1)} GB</td><td>{new Date(node.last_seen).toLocaleTimeString()}</td></tr>)}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ClusterGraphView() {
  const config = useStore((s) => s.config);
  const nodes = useStore((s) => s.nodes);

  async function openDashboard() {
    try {
      await invoke("open_dashboard", { url: `http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}` });
    } catch {
      window.open(`http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}`, "_blank");
    }
  }

  return (
    <div className="single-view graph-view">
      <div className="view-title"><Boxes size={20} /><h2>Cluster Graph</h2></div>
      <section className="panel wide">
        <div className="panel-title"><Boxes size={19} /><h2>Node Network</h2><button className="ghost" onClick={() => void openDashboard()}><ExternalLink size={16} />Dashboard</button></div>
        <ClusterGraph config={config} nodes={nodes} />
      </section>
    </div>
  );
}

function ClusterGraph({ config, nodes }: { config: AppConfig; nodes: NodeInfo[] }) {
  const width = 900;
  const height = 380;
  const cx = width / 2;
  const coordinatorY = 42;
  const workerY = 238;
  const branchY = 178;
  const workerWidth = 144;
  const workerGap = 34;

  const positioned = useMemo(() => nodes.map((node, index) => {
    const totalWidth = nodes.length * workerWidth + Math.max(0, nodes.length - 1) * workerGap;
    const startX = cx - totalWidth / 2 + workerWidth / 2;
    return { node, x: startX + index * (workerWidth + workerGap), y: workerY };
  }), [nodes, cx]);
  const branchLeft = positioned[0]?.x ?? cx;
  const branchRight = positioned[positioned.length - 1]?.x ?? cx;

  return (
    <div className="cluster-graph-shell">
      <svg className="cluster-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Ray cluster node graph">
        <defs>
          <radialGradient id="coordinatorGlow" cx="50%" cy="50%" r="65%">
            <stop offset="0%" stopColor="#2f9e67" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#2f9e67" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle className="coordinator-halo" cx={cx} cy={coordinatorY + 44} r="86" fill="url(#coordinatorGlow)" />
        {positioned.length > 0 && <path className="graph-link graph-trunk" d={`M ${cx} ${coordinatorY + 88} V ${branchY} H ${branchLeft} H ${branchRight}`} />}
        {positioned.map(({ node, x, y }) => <path className="graph-link" key={`link-${node.node_id}`} d={`M ${x} ${branchY} V ${y}`} />)}
        <g className="graph-node coordinator-node" transform={`translate(${cx - 82} ${coordinatorY})`}>
          <rect width="164" height="88" rx="8" />
          <text x="82" y="28" textAnchor="middle" className="graph-node-title">Coordinator</text>
          <text x="82" y="50" textAnchor="middle" className="graph-node-subtitle">{config.coordinator.head_host}:{config.coordinator.ray_port}</text>
          <text x="82" y="70" textAnchor="middle" className="graph-node-metric">Head node</text>
        </g>
        {positioned.map(({ node, x, y }) => <WorkerGraphNode node={node} x={x} y={y} key={node.node_id} />)}
      </svg>
      {nodes.length === 0 && <div className="graph-empty">No workers reported yet. Start Ray or wait for nodes to check in.</div>}
    </div>
  );
}

function WorkerGraphNode({ node, x, y }: { node: NodeInfo; x: number; y: number }) {
  const status = node.status.toLowerCase();
  return (
    <g className={cls("graph-node", "worker-node", status.includes("dead") && "down")} transform={`translate(${x - 72} ${y - 40})`}>
      <rect width="144" height="80" rx="8" />
      <circle cx="18" cy="20" r="5" />
      <text x="72" y="25" textAnchor="middle" className="graph-node-title">{truncateMiddle(node.hostname, 18)}</text>
      <text x="72" y="47" textAnchor="middle" className="graph-node-subtitle">{node.status}</text>
      <text x="72" y="66" textAnchor="middle" className="graph-node-metric">{node.cpus_total} CPU / {node.gpus_total} GPU</text>
    </g>
  );
}

function truncateMiddle(value: string, max: number) {
  if (value.length <= max) return value;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}.${value.slice(-keep)}`;
}

function SubmitJobView() {
  const submitters = useStore((s) => s.config.submitters);
  const activeSubmitters = useMemo(() => submitters.filter((s) => !s.revoked), [submitters]);
  const [job, setJob] = useState<JobSubmission>({ submitter_id: activeSubmitters[0]?.id ?? "", entrypoint: "python train.py", working_dir: "s3://raylab/jobs/example", runtime_env: {}, metadata: {} });
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const defaultSet = useRef(false);
  useEffect(() => {
    if (!defaultSet.current && !job.submitter_id && activeSubmitters[0]?.id) {
      defaultSet.current = true;
      setJob((j) => ({ ...j, submitter_id: activeSubmitters[0].id }));
    }
  }, [activeSubmitters, job.submitter_id]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.submitJob(job);
      setResult(`${response.status}: ${response.job_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Job submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="single-view">
      <div className="view-title"><Terminal size={20} /><h2>Submit Job</h2></div>
      <section className="panel wide">
        <div className="panel-title"><Terminal size={19} /><h2>Ray Job Submission</h2></div>
        {activeSubmitters.length === 0 && <div className="banner error static"><AlertTriangle size={18} />Create an active submitter before submitting jobs.</div>}
        {error && <div className="banner error static"><AlertTriangle size={18} />{error}</div>}
        {result && <div className="banner success static"><CheckCircle2 size={18} />{result}</div>}
        <label>Submitter<select value={job.submitter_id} onChange={(e) => setJob({ ...job, submitter_id: e.target.value })}>{activeSubmitters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Entrypoint<input value={job.entrypoint} onChange={(e) => setJob({ ...job, entrypoint: e.target.value })} /></label>
        <label>Working directory<input value={job.working_dir} onChange={(e) => setJob({ ...job, working_dir: e.target.value })} /></label>
        <label>Container image<input placeholder="optional image" value={job.container_image ?? ""} onChange={(e) => setJob({ ...job, container_image: e.target.value || undefined })} /></label>
        <button onClick={() => void submit()} disabled={submitting || activeSubmitters.length === 0}>
          {submitting ? <Spinner /> : <Play size={17} />}{submitting ? "Submitting…" : "Submit"}
        </button>
      </section>
    </div>
  );
}

function SubmittersView() {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const refresh = useStore((s) => s.refresh);
  const [submitterName, setSubmitterName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createSubmitter() {
    if (!submitterName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSubmitter(submitterName.trim());
      setToken(created.token);
      setSubmitterName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submitter creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function revokeSubmitter(id: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.revokeSubmitter(id);
      setConfig(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submitter revocation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="single-view">
      <div className="view-title"><KeyRound size={20} /><h2>Submitters</h2></div>
      <section className="panel wide">
        <div className="panel-title"><KeyRound size={19} /><h2>Submitter Tokens</h2></div>
        {error && <div className="banner error static"><AlertTriangle size={18} />{error}</div>}
        <div className="inline">
          <input placeholder="Name" value={submitterName} onChange={(e) => setSubmitterName(e.target.value)} />
          <button onClick={() => void createSubmitter()} disabled={busy}>
            {busy ? <Spinner /> : <UserPlus size={17} />}Add
          </button>
        </div>
        {token && <pre className="token">New token: {token}</pre>}
        <div className="list">
          {config.submitters.length === 0 && <p>No submitters yet.</p>}
          {config.submitters.map((submitter) => (
            <div className="list-row" key={submitter.id}>
              <span>{submitter.name}</span>
              <small>{submitter.revoked ? "revoked" : "active"}</small>
              <button className="ghost" onClick={() => void revokeSubmitter(submitter.id)} disabled={busy || submitter.revoked}>
                {busy ? <Spinner size={15} /> : null}Revoke
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function NodeHome() {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const setConfig = useStore((s) => s.setConfig);
  const hardware = useStore((s) => s.hardware);
  const saveConfig = useStore((s) => s.saveConfig);
  const activeAction = useStore((s) => s.activeAction);
  const setupRun = useStore((s) => s.setupRun);
  const refresh = useStore((s) => s.refresh);
  const sharingMode: "off" | "scheduled" | "always" =
    !config.node_policy.master_enabled || config.node_policy.manual_override === "force_off"
      ? "off"
      : config.node_policy.manual_override === "force_on"
      ? "always"
      : "scheduled";

  const sharingDescriptions = {
    off: "This machine will not share resources with the cluster.",
    scheduled: "Resources are shared during configured schedule windows and idle periods.",
    always: "Resources are always shared regardless of schedule or idle policy.",
  };

  function setSharingMode(mode: "off" | "scheduled" | "always") {
    const patch: Partial<AppConfig["node_policy"]> =
      mode === "off"
        ? { master_enabled: false, manual_override: "force_off" }
        : mode === "always"
        ? { master_enabled: true, manual_override: "force_on" }
        : { master_enabled: true, manual_override: "auto" };
    const next = { ...config, node_policy: { ...config.node_policy, ...patch } };
    setConfig(next);
    void saveConfig(next);
  }

  return (
    <div className="grid two">
      <SetupPanel setupRun={setupRun} refresh={refresh} status={status} compact />
      <CoordinatorTargetPanel />
      <DiscoveryPanel />

      <section className="panel hero-status">
        <div className="panel-title"><ShieldCheck size={19} /><h2>Sharing</h2></div>
        <p>{config.resource_caps.gpu_memory_gb} GB GPU memory cap · {config.resource_caps.max_concurrent_jobs} job slot</p>
        <div className="sharing-state">
          <div className="segmented sharing-segmented">
            <button className={sharingMode === "off" ? "active" : ""} onClick={() => setSharingMode("off")}>Off</button>
            <button className={sharingMode === "scheduled" ? "active" : ""} onClick={() => setSharingMode("scheduled")}>Scheduled</button>
            <button className={sharingMode === "always" ? "active" : ""} onClick={() => setSharingMode("always")}>Always on</button>
          </div>
          <p className="sharing-desc">{sharingDescriptions[sharingMode]}</p>
          {sharingMode === "scheduled" && (
            <div className="schedule-settings">
              <div className="schedule-row">
                <label className="check">
                  <input type="checkbox" checked={config.node_policy.schedule_enabled} onChange={(e) => setConfig({ ...config, node_policy: { ...config.node_policy, schedule_enabled: e.target.checked } })} />
                  <span className="schedule-label">
                    <strong>Only share during set hours</strong>
                    <small>Sharing is restricted to the time windows below. If none are added, sharing stays off.</small>
                  </span>
                </label>
                {config.node_policy.schedule_enabled && (
                  <ScheduleWindowsEditor
                    windows={config.node_policy.schedule_windows}
                    onChange={(schedule_windows) => setConfig({ ...config, node_policy: { ...config.node_policy, schedule_windows } })}
                  />
                )}
              </div>
              <div className="schedule-row">
                <label className="check">
                  <input type="checkbox" checked={config.node_policy.idle_only_enabled} onChange={(e) => setConfig({ ...config, node_policy: { ...config.node_policy, idle_only_enabled: e.target.checked } })} />
                  <span className="schedule-label">
                    <strong>Only share when my machine is idle</strong>
                    <small>Pauses sharing while you're actively using the machine — resumes once CPU stays below {config.node_policy.max_cpu_percent_for_idle}% and GPU below {config.node_policy.max_gpu_percent_for_idle}% for {config.node_policy.idle_minutes} min.</small>
                  </span>
                </label>
                {config.node_policy.idle_only_enabled && (
                  <NumberField label="Minutes of inactivity required before sharing resumes" value={config.node_policy.idle_minutes} onChange={(idle_minutes) => setConfig({ ...config, node_policy: { ...config.node_policy, idle_minutes } })} />
                )}
              </div>
              <button onClick={() => void saveConfig(undefined, "save-schedule")} disabled={activeAction === "save-schedule"}>{activeAction === "save-schedule" ? <Spinner /> : <Save size={17} />}Save schedule</button>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><SlidersHorizontal size={19} /><h2>Resource Caps</h2></div>
        <NumberField label={<LabelWithDetected label="CPUs" detected={formatCpuDetected(hardware)} />} value={config.resource_caps.cpus} onChange={(cpus) => setConfig({ ...config, resource_caps: { ...config.resource_caps, cpus } })} />
        <NumberField label={<LabelWithDetected label="GPUs" detected={formatGpuDetected(hardware)} />} value={config.resource_caps.gpus} onChange={(gpus) => setConfig({ ...config, resource_caps: { ...config.resource_caps, gpus } })} />
        <NumberField label={<LabelWithDetected label="System RAM cap" detected={formatMemoryDetected(hardware)} />} value={config.resource_caps.memory_gb} onChange={(memory_gb) => setConfig({ ...config, resource_caps: { ...config.resource_caps, memory_gb } })} />
        <NumberField label={<LabelWithDetected label="GPU memory cap" detected={formatGpuMemoryDetected(hardware)} />} value={config.resource_caps.gpu_memory_gb} onChange={(gpu_memory_gb) => setConfig({ ...config, resource_caps: { ...config.resource_caps, gpu_memory_gb } })} />
        <button onClick={() => void saveConfig(undefined, "save-caps")} disabled={activeAction === "save-caps"}>{activeAction === "save-caps" ? <Spinner /> : <Save size={17} />}Save caps</button>
      </section>
    </div>
  );
}

function CoordinatorTargetPanel() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const activeAction = useStore((s) => s.activeAction);
  const [draft, setDraft] = useState(config.coordinator);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(config.coordinator);
  }, [config.coordinator, dirty]);

  function updateDraft(patch: Partial<AppConfig["coordinator"]>) {
    setDirty(true);
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function saveTarget() {
    const next = { ...config, coordinator: { ...config.coordinator, ...draft, head_host: draft.head_host.trim() || "127.0.0.1" } };
    await saveConfig(next, "save-target");
    setDirty(false);
  }

  return (
    <section className="panel coordinator-target-panel">
      <div className="panel-title"><Server size={19} /><h2>Join Target</h2></div>
      <label>Head host<input value={draft.head_host} placeholder="192.168.1.50" onChange={(e) => updateDraft({ head_host: e.target.value })} /></label>
      <NumberField label="Ray port" value={draft.ray_port} onChange={(ray_port) => updateDraft({ ray_port })} />
      <NumberField label="Dashboard port" value={draft.dashboard_port} onChange={(dashboard_port) => updateDraft({ dashboard_port })} />
      <button onClick={() => void saveTarget()} disabled={activeAction === "save-target" || !dirty}>
        {activeAction === "save-target" ? <Spinner /> : <Save size={17} />}Save target
      </button>
    </section>
  );
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFAULT_WINDOW = (): ScheduleWindow => ({ days: [0, 1, 2, 3, 4], start: "22:00", end: "07:00" });

function ScheduleWindowsEditor({ windows, onChange }: { windows: ScheduleWindow[]; onChange: (w: ScheduleWindow[]) => void }) {
  function addWindow() {
    onChange([...windows, DEFAULT_WINDOW()]);
  }

  function removeWindow(i: number) {
    onChange(windows.filter((_, idx) => idx !== i));
  }

  function updateWindow(i: number, patch: Partial<ScheduleWindow>) {
    onChange(windows.map((w, idx) => idx === i ? { ...w, ...patch } : w));
  }

  function toggleDay(i: number, day: number, checked: boolean) {
    const days = checked ? [...windows[i].days, day].sort() : windows[i].days.filter((d: number) => d !== day);
    updateWindow(i, { days });
  }

  return (
    <div className="windows-editor">
      {windows.length === 0 && (
        <p className="windows-empty">No time windows added yet — sharing will stay off until you add one.</p>
      )}
      {windows.map((w, i) => (
        <div className="window-row" key={i}>
          <div className="window-days">
            {DAY_LABELS.map((label, day) => (
              <label key={day} className="day-chip">
                <input type="checkbox" checked={w.days.includes(day)} onChange={(e) => toggleDay(i, day, e.target.checked)} />
                {label}
              </label>
            ))}
          </div>
          <div className="window-times">
            <label>From<input type="time" value={w.start} onChange={(e) => updateWindow(i, { start: e.target.value })} /></label>
            <span className="time-sep">to</span>
            <label>Until<input type="time" value={w.end} onChange={(e) => updateWindow(i, { end: e.target.value })} /></label>
            <button className="ghost remove-window" title="Remove window" onClick={() => removeWindow(i)}><X size={15} /></button>
          </div>
        </div>
      ))}
      <button className="ghost add-window" onClick={addWindow}><Play size={14} />Add time window</button>
    </div>
  );
}

function DiscoveryPanel() {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const saveConfig = useStore((s) => s.saveConfig);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("Scan this machine's LAN for reachable Ray coordinators.");

  async function scan() {
    setScanning(true);
    setScanMessage("Scanning LAN subnets and nearby Ray ports...");
    try {
      const found = await api.discoverCoordinators();
      setCandidates(found);
      setScanMessage(found.length ? `Found ${found.length} candidate${found.length === 1 ? "" : "s"}.` : "No coordinators found. Make sure the host is running External workers mode and both machines are on the same LAN/VLAN.");
    } catch (err) {
      setScanMessage(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setScanning(false);
    }
  }

  function useCandidate(candidate: DiscoveryCandidate) {
    const next = {
      ...config,
      coordinator: {
        ...config.coordinator,
        head_host: candidate.host,
        ray_port: candidate.ray_port,
        dashboard_port: candidate.dashboard_port ?? config.coordinator.dashboard_port,
      },
    };
    setConfig(next);
    void saveConfig(next);
  }

  return (
    <section className="panel wide discovery-panel">
      <div className="panel-title">
        <Server size={19} /><h2>Find Coordinator</h2>
        <button className="ghost" onClick={() => void scan()} disabled={scanning}>
          {scanning ? <Spinner size={16} /> : <Search size={16} />}{scanning ? "Scanning…" : "Scan LAN"}
        </button>
      </div>
      <p className="panel-copy">{scanMessage}</p>
      {candidates.length > 0 && (
        <div className="discovery-list">
          {candidates.map((candidate) => (
            <div className="discovery-row" key={`${candidate.host}:${candidate.ray_port}`}>
              <div>
                <strong>{candidate.host}:{candidate.ray_port}</strong>
                <span>{candidate.detail}</span>
                {candidate.dashboard_url && <small>{candidate.dashboard_url}</small>}
              </div>
            <div className="confidence"><button onClick={() => useCandidate(candidate)}>Use</button></div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsView() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const activeAction = useStore((s) => s.activeAction);
  const [draft, setDraft] = useState(config);
  const [dirty, setDirty] = useState(false);
  const showJoinTargetSettings = config.app_mode === "node";

  useEffect(() => {
    if (!dirty) setDraft(config);
  }, [config, dirty]);

  function updateCoordinator(patch: Partial<AppConfig["coordinator"]>) {
    setDirty(true);
    setDraft((current) => ({ ...current, coordinator: { ...current.coordinator, ...patch } }));
  }

  function updatePrivacy(patch: Partial<AppConfig["privacy"]>) {
    setDirty(true);
    setDraft((current) => ({ ...current, privacy: { ...current.privacy, ...patch } }));
  }

  function updateObjectStore(patch: Partial<AppConfig["object_store"]>) {
    setDirty(true);
    setDraft((current) => ({ ...current, object_store: { ...current.object_store, ...patch } }));
  }

  async function saveSettings() {
    await saveConfig(draft, "save-settings");
    setDirty(false);
  }

  return (
    <div className="grid two">
      {showJoinTargetSettings && (
        <section className="panel">
          <div className="panel-title"><Server size={19} /><h2>Join Target</h2></div>
          <label>Head host<input value={draft.coordinator.head_host} onChange={(e) => updateCoordinator({ head_host: e.target.value })} /></label>
          <NumberField label="Ray port" value={draft.coordinator.ray_port} onChange={(ray_port) => updateCoordinator({ ray_port })} />
          <NumberField label="Dashboard port" value={draft.coordinator.dashboard_port} onChange={(dashboard_port) => updateCoordinator({ dashboard_port })} />
          <label className="check"><input type="checkbox" checked={draft.coordinator.bind_private_only} onChange={(e) => updateCoordinator({ bind_private_only: e.target.checked })} />Private VLAN only</label>
        </section>
      )}

      <section className="panel">
        <div className="panel-title"><ShieldCheck size={19} /><h2>Privacy</h2></div>
        <div className="readonly-field">
          <span>Worker account</span>
          <strong>{draft.privacy.worker_account}</strong>
          <small>Managed by RayLab setup</small>
        </div>
        <label>Container runtime<select value={draft.privacy.container_runtime} onChange={(e) => updatePrivacy({ container_runtime: e.target.value as "docker" | "podman" })}><option value="docker">Docker</option><option value="podman">Podman</option></select></label>
        <label className="check"><input type="checkbox" checked={draft.privacy.require_runtime_working_dir} onChange={(e) => updatePrivacy({ require_runtime_working_dir: e.target.checked })} />Require runtime working_dir</label>
      </section>

      <section className="panel">
        <div className="panel-title"><Database size={19} /><h2>Object Store</h2></div>
        <label>Endpoint<input value={draft.object_store.endpoint_url} onChange={(e) => updateObjectStore({ endpoint_url: e.target.value })} /></label>
        <label>Bucket<input value={draft.object_store.bucket} onChange={(e) => updateObjectStore({ bucket: e.target.value })} /></label>
        <label>Region<input value={draft.object_store.region} onChange={(e) => updateObjectStore({ region: e.target.value })} /></label>
      </section>
      <button className="save-bar" onClick={() => void saveSettings()} disabled={activeAction === "save-settings" || !dirty}>
        {activeAction === "save-settings" ? <Spinner /> : <Save size={17} />}Save settings
      </button>
    </div>
  );
}

function SetupView() {
  const setupRun = useStore((s) => s.setupRun);
  const refresh = useStore((s) => s.refresh);
  return (
    <div className="single-view">
      <div className="view-title"><ListChecks size={20} /><h2>Full Machine Setup</h2></div>
      <SetupPanel setupRun={setupRun} refresh={refresh} />
    </div>
  );
}

function DiagnosticsView() {
  const diagnostics = useStore((s) => s.status?.diagnostics ?? []);
  const rayInstall = useStore((s) => s.rayInstall);
  const refresh = useStore((s) => s.refresh);
  const summary = useMemo(() => summarizeDiagnostics(diagnostics), [diagnostics]);
  return (
    <div className="single-view">
      <section className="panel wide">
        <div className="panel-title"><AlertTriangle size={19} /><h2>Diagnostics</h2><button className="ghost" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button></div>
        <p className="panel-copy">{summary}</p>
        <DiagnosticsList diagnostics={diagnostics} rayInstall={rayInstall} refresh={refresh} />
      </section>
    </div>
  );
}

function TerminalDock({ close }: { close: () => void }) {
  const logs = useStore((s) => s.terminalLogs);
  const refresh = useStore((s) => s.refresh);
  const outputRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [logs.length]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <section className="terminal-dock" role="region" aria-label="Terminal logs">
      <div className="terminal-dock-title">
        <div><Terminal size={17} /><strong>Terminal</strong><span>Start/stop logs</span></div>
        <div className="terminal-dock-actions">
          <button className="ghost" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button>
          <button className="ghost close-terminal" title="Close terminal" onClick={close}><X size={17} />Close</button>
        </div>
      </div>
      <div className="terminal-output" ref={outputRef}>
        {logs.length === 0 && <div className="terminal-empty">No cluster command logs yet.</div>}
        {logs.map((entry) => (
          <div className={cls("terminal-line", entry.stream === "stderr" && "error-line")} key={entry.timestamp}>
            <span>{new Date(entry.timestamp).toLocaleTimeString()}</span><code>{entry.message}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

const AUDIT_PAGE_SIZE = 25;

function AuditView() {
  const audit = useStore((s) => s.audit);
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(audit.length / AUDIT_PAGE_SIZE));
  const slice = audit.slice(page * AUDIT_PAGE_SIZE, (page + 1) * AUDIT_PAGE_SIZE);

  // Reset to first page if audit shrinks (e.g. cleared on server)
  useEffect(() => {
    if (page >= totalPages) setPage(0);
  }, [page, totalPages]);

  return (
    <section className="panel wide">
      <div className="panel-title"><Activity size={19} /><h2>Audit Log</h2></div>
      <div className="audit-list">
        {audit.length === 0 && <p>No audit events yet.</p>}
        {slice.map((event) => (
          <div className="audit-row" key={event.id}>
            <span>{new Date(event.timestamp).toLocaleString()}</span>
            <strong>{event.event_type}</strong>
            <span>{event.actor}</span>
            <p>{event.message}</p>
          </div>
        ))}
      </div>
      {audit.length > AUDIT_PAGE_SIZE && (
        <div className="audit-pagination">
          <button onClick={() => setPage((p) => p - 1)} disabled={page === 0}>← Prev</button>
          <span>Page {page + 1} of {totalPages} · {audit.length} events</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1}>Next →</button>
        </div>
      )}
    </section>
  );
}

function SetupPanel({ setupRun, refresh, status = null, compact = false }: { setupRun: SetupRunStatus | null; refresh: () => Promise<void>; status?: ClusterStatus | null; compact?: boolean }) {
  const [running, setRunning] = useState(false);

  async function runSetup() {
    setRunning(true);
    try {
      await api.runSetup();
      await refresh();
    } finally {
      setRunning(false);
    }
  }

  const isRunning = running || !!setupRun?.running;
  const tasks = setupRun?.tasks ?? [];
  const connectedNode = compact && status?.mode === "node" && status.state === "running" && status.diagnostics.some((check) => check.id === "ray_port" && check.status === "pass");
  const visibleTasks = compact
    ? tasks.filter((task) => {
        if (task.status === "running") return true;
        if (connectedNode || setupRun?.can_continue) return false;
        return ["fail", "warn"].includes(task.status);
      })
    : tasks;
  return (
    <section className={cls("setup-panel", compact && "compact")}>
      <div className="setup-head">
        <div>
          <strong>Full machine setup</strong>
          <span>{setupRun?.message ?? "Run setup to install Ray and check local prerequisites."}</span>
        </div>
        <button className="ghost" onClick={() => void runSetup()} disabled={isRunning}>
          {isRunning ? <Spinner size={16} /> : <Play size={16} />}{isRunning ? "Running…" : "Run setup"}
        </button>
      </div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${setupRun?.progress ?? 0}%` }} /></div>
      <div className="progress-meta"><span>{setupRun?.progress ?? 0}% complete</span><span>{setupRun?.can_continue ? "Ready to continue" : "Not ready yet"}</span></div>
      {visibleTasks.length > 0 && <div className="setup-tasks">{visibleTasks.map((task) => <SetupTaskRow task={task} key={task.id} />)}</div>}
    </section>
  );
}

function SetupTaskRow({ task }: { task: SetupTask }) {
  const icon = task.status === "pass" ? <CheckCircle2 size={16} /> : task.status === "fail" ? <XCircle size={16} /> : task.status === "running" ? <Spinner size={16} /> : <AlertTriangle size={16} />;
  return <div className={cls("setup-task", task.status)}>{icon}<div><strong>{task.label}</strong><span>{task.detail}</span>{task.fix && <small>{task.fix}</small>}</div></div>;
}

function DiagnosticsList({ diagnostics, rayInstall, refresh }: { diagnostics: DiagnosticCheck[]; rayInstall: InstallStatus | null; refresh: () => Promise<void> }) {
  const [installing, setInstalling] = useState(false);

  async function installRay() {
    setInstalling(true);
    try {
      await api.installRay();
      await refresh();
    } finally {
      setInstalling(false);
    }
  }

  const isInstalling = installing || !!rayInstall?.running;

  return (
    <div className="diagnostics">
      {diagnostics.map((item) => (
        <div className={cls("diag", item.status)} key={item.id}>
          {item.status === "pass" ? <CheckCircle2 size={17} /> : item.status === "warn" ? <AlertTriangle size={17} /> : <XCircle size={17} />}
          <div>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
            {item.fix && <small>{item.fix}</small>}
            {item.id === "ray" && item.status === "fail" && (
              <button className="ghost install-button" onClick={() => void installRay()} disabled={isInstalling}>
                {isInstalling ? <Spinner size={16} /> : <Terminal size={16} />}{isInstalling ? "Installing Ray…" : "Install Ray"}
              </button>
            )}
            {item.id === "ray" && rayInstall && rayInstall.message !== "Not started" && <small className="install-log">{rayInstall.message}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: React.ReactNode; value: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}

function LabelWithDetected({ label, detected }: { label: string; detected: string }) {
  return <span className="label-with-detected"><span>{label}</span><small>{detected}</small></span>;
}

function formatCpuDetected(hardware: HardwareInfo | null) {
  if (!hardware) return "detecting...";
  const physical = hardware.cpu_physical ? `, ${hardware.cpu_physical} physical` : "";
  return `detected ${hardware.cpu_logical} logical${physical}`;
}

function formatGpuDetected(hardware: HardwareInfo | null) {
  if (!hardware) return "detecting...";
  if (hardware.gpu_count === 0) return "detected 0 GPUs";
  const type = hardware.gpu_type === "none" ? "" : ` ${hardware.gpu_type.toUpperCase()}`;
  return `detected ${hardware.gpu_count}${type}: ${hardware.gpu_names.join(", ")}`;
}

function formatMemoryDetected(hardware: HardwareInfo | null) {
  if (!hardware) return "detecting...";
  if (!hardware.memory_total_gb) return "not detected";
  return `detected ${hardware.memory_total_gb.toFixed(1)} GB`;
}

function formatGpuMemoryDetected(hardware: HardwareInfo | null) {
  if (!hardware) return "detecting...";
  if (!hardware.gpu_memory_total_gb) return hardware.gpu_count > 0 ? "not reported" : "no GPU memory";
  const shared = hardware.gpu_memory_shared ? " unified" : "";
  return `detected ${hardware.gpu_memory_total_gb.toFixed(1)} GB${shared}`;
}

function buildCoordinatorCommandPreview(config: AppConfig) {
  const parts = [
    "ray start --head",
    config.coordinator.node_ip_address.trim() ? `  --node-ip-address ${config.coordinator.node_ip_address.trim()}` : "  # node IP: auto-detect",
    `  --port ${config.coordinator.ray_port}`,
    `  --dashboard-host ${config.coordinator.dashboard_host}`,
    `  --dashboard-port ${config.coordinator.dashboard_port}`,
    `  --ray-client-server-port ${config.coordinator.client_port}`,
    `  --num-cpus ${Math.trunc(config.resource_caps.cpus)}`,
    `  --num-gpus ${Math.trunc(config.resource_caps.gpus)}`,
    `  --memory ${Math.trunc(config.resource_caps.memory_gb * 1024 * 1024 * 1024)}`,
    `  --resources '${JSON.stringify({ raylab_max_jobs: config.resource_caps.max_concurrent_jobs })}'`,
  ];
  return parts.join(" \\\n+");
}

function summarizeDiagnostics(diagnostics: DiagnosticCheck[]) {
  const fails = diagnostics.filter((d) => d.status === "fail").length;
  const warns = diagnostics.filter((d) => d.status === "warn").length;
  if (fails) return `${fails} blocking checks need attention before safe cluster operation.`;
  if (warns) return `${warns} checks are warnings; core privacy gates are passing.`;
  return "All readiness checks are passing.";
}
