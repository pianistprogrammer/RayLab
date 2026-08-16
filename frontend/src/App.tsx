import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleStop,
  Database,
  Download,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Maximize2,
  Move,
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
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { api } from "./api";
import { cacheConfig, constrainConfigToHardware, useStore } from "./store";
import type { AppConfig, AppMode, AuditEvent, ClusterState, ClusterStatus, DiagnosticCheck, DiscoveryCandidate, HardwareInfo, InstallStatus, JobSubmission, NodeInfo, PortConflict, ScheduleWindow, SetupRunStatus, SetupTask, TerminalLogEntry } from "./types";

type View = "home" | "graph" | "submit-job" | "submitters" | "setup" | "settings" | "audit";

const TERMINAL_MIN_HEIGHT = 220;
const TERMINAL_DEFAULT_HEIGHT = 320;
const TERMINAL_MAX_HEIGHT = 640;

function cls(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function clampTerminalHeight(height: number) {
  const viewportCap = typeof window === "undefined" ? TERMINAL_MAX_HEIGHT : Math.floor(window.innerHeight * 0.68);
  const max = Math.max(TERMINAL_MIN_HEIGHT, Math.min(TERMINAL_MAX_HEIGHT, viewportCap));
  return Math.min(max, Math.max(TERMINAL_MIN_HEIGHT, height));
}

// Spinning loader icon — reuses the existing `spin` keyframe in styles.css
function Spinner({ size = 17 }: { size?: number }) {
  return <RefreshCw size={size} style={{ animation: "spin 0.7s linear infinite" }} />;
}

export function App() {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const backendReady = useStore((s) => s.backendReady);
  const activeAction = useStore((s) => s.activeAction);
  const modeSaving = useStore((s) => s.modeSaving);
  const error = useStore((s) => s.error);
  const notice = useStore((s) => s.notice);
  const setupRun = useStore((s) => s.setupRun);
  const refresh = useStore((s) => s.refresh);
  const setActiveAction = useStore((s) => s.setActiveAction);
  const setError = useStore((s) => s.setError);
  const setNotice = useStore((s) => s.setNotice);
  const persistMode = useStore((s) => s.persistMode);
  const runAction = useStore((s) => s.runAction);

  const [view, setView] = useState<View>("home");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);
  const [roleSwitchTarget, setRoleSwitchTarget] = useState<AppMode | null>(null);
  const [portConflictPrompt, setPortConflictPrompt] = useState<PortConflict[] | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const nodeSetupStarted = useRef(false);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    function onResize() {
      setTerminalHeight((height) => clampTerminalHeight(height));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
    if (!backendReady || !setupRun || setupRun.running || setupRun.can_continue || nodeSetupStarted.current) return;
    nodeSetupStarted.current = true;
    const timer = window.setTimeout(() => {
      void api.runSetup().then(() => refresh()).catch(() => refresh());
    }, 750);
    return () => window.clearTimeout(timer);
  }, [config.app_mode, refresh, setupRun, backendReady]);

  const state = status?.state ?? "stopped";
  const anyBusy = activeAction !== null;
  const actionsReady = backendReady && status !== null;

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

  async function handleStartRay() {
    setTerminalOpen(true);
    setPortConflictPrompt(null);
    setActiveAction("start");
    setError(null);
    try {
      const conflicts = await api.portConflicts();
      if (conflicts.length > 0) {
        setPortConflictPrompt(conflicts);
        return;
      }
      await api.start();
      setNotice("Ray start requested");
      await refresh();
    } catch (err) {
      const message = errorMessage(err, "Ray start failed");
      if (isPortConflictMessage(message)) {
        const conflicts = await api.portConflicts().catch(() => [] as PortConflict[]);
        if (conflicts.length > 0) {
          setPortConflictPrompt(conflicts);
        } else {
          setError(message);
        }
      } else {
        setError(message);
      }
    } finally {
      setActiveAction(null);
    }
  }

  async function stopPortConflictsAndStart() {
    setPortConflictPrompt(null);
    setTerminalOpen(true);
    setActiveAction("start");
    setError(null);
    try {
      await api.clearPortConflicts();
      await api.start();
      setNotice("Stopped the port conflict and started Ray");
      await refresh();
    } catch (err) {
      const message = errorMessage(err, "Ray start failed");
      setError(isPortConflictMessage(message) ? `${message} RayLab could not clear the occupied port automatically; check the terminal for the owning process and stop it manually if needed.` : message);
    } finally {
      setActiveAction(null);
    }
  }

  const isRunning = state === "running";
  const isStarting = state === "starting";
  const isStopping = state === "stopping";
  const isStopped = state === "stopped";
  const coordinatorReachable = status?.diagnostics.some((check) => check.id === "ray_port" && check.status === "pass") ?? false;
  const workerAccountReady = status?.diagnostics.some((check) => check.id === "worker_account" && check.status === "pass") ?? false;
  const setupRequired = config.app_mode === "node" && !setupRun?.can_continue && (!coordinatorReachable || !workerAccountReady);
  const startDisabled = !actionsReady || anyBusy || setupRequired || isRunning || isStarting || isStopping;
  const stopDisabled = !actionsReady || anyBusy || isStopped || isStarting || isStopping;
  const startTitle = !actionsReady ? "Waiting for the app to finish starting" : setupRequired ? "Run setup and choose a reachable coordinator before starting" : "Start Ray";
  const stopTitle = !actionsReady ? "Waiting for the app to finish starting" : "Stop Ray";

  if (config.app_mode === "unconfigured") {
    return <RolePicker onChoose={changeMode} busy={!backendReady || anyBusy || modeSaving} />;
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
        <button className={cls("nav", view === "settings" && "active")} onClick={() => setView("settings")}><Settings size={18} />Settings</button>
        <button className={cls("nav", view === "audit" && "active")} onClick={() => setView("audit")}><Activity size={18} />Audit</button>
        <SidebarStatus />
      </aside>

      <section className={cls("workspace", terminalOpen && "terminal-open")}>
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
            <button className="ghost" onClick={() => setTerminalOpen((o) => !o)}><Terminal size={17} />{terminalOpen ? "Hide terminal" : "Terminal"}</button>
            <button className="icon-button" title="Refresh" onClick={() => void handleManualRefresh()} disabled={manualRefreshing}>
              {manualRefreshing ? <Spinner /> : <RefreshCw size={18} />}
            </button>
            <button title={startTitle} onClick={() => void handleStartRay()} disabled={startDisabled}>
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

        <div className="workspace-main">
          {error && <div className="banner error"><AlertTriangle size={18} />{error}</div>}
          {notice && <NoticeBanner message={notice} onDone={() => setNotice(null)} />}

          {view === "home" && (config.app_mode === "coordinator" ? <CoordinatorHome /> : <NodeHome openTerminal={() => setTerminalOpen(true)} />)}
          {view === "graph" && config.app_mode === "coordinator" && <ClusterGraphView />}
          {view === "submit-job" && config.app_mode === "coordinator" && <SubmitJobView />}
          {view === "submitters" && config.app_mode === "coordinator" && <SubmittersView />}
          {view === "setup" && <SetupView openTerminal={() => setTerminalOpen(true)} />}
          {view === "settings" && <SettingsView />}
          {view === "audit" && <AuditView />}
        </div>
        {terminalOpen && <TerminalDock close={() => setTerminalOpen(false)} height={terminalHeight} onHeightChange={setTerminalHeight} />}
        {portConflictPrompt && (
          <PortConflictPrompt
            conflicts={portConflictPrompt}
            cancel={() => setPortConflictPrompt(null)}
            stopAndStart={() => void stopPortConflictsAndStart()}
          />
        )}
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
  const backendReady = useStore((s) => s.backendReady);
  const state = backendReady && status ? status.state : "starting";
  const label = state === "running"
    ? "Ray is running"
    : state === "error"
      ? "Needs attention"
      : state === "starting"
        ? "Starting"
        : state === "stopping"
          ? "Stopping"
          : "Not running";
  const detail = backendReady ? (config.app_mode === "coordinator" ? "Host mode" : "Join mode") : "Starting app";
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

function PortConflictPrompt({ conflicts, cancel, stopAndStart }: { conflicts: PortConflict[]; cancel: () => void; stopAndStart: () => void }) {
  const activeAction = useStore((s) => s.activeAction);
  const conflictLabel = conflicts.length === 1
    ? `${conflicts[0].name} port ${conflicts[0].port}`
    : `${conflicts.length} configured Ray ports`;
  const prompt = conflicts.length === 1
    ? `${conflictLabel} is occupied, so Ray cannot host the cluster yet. Do you want to stop the process on that port and start Ray?`
    : `${conflictLabel} are occupied, so Ray cannot host the cluster yet. Do you want to stop the processes on those ports and start Ray?`;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel port-conflict-modal" role="dialog" aria-modal="true" aria-labelledby="port-conflict-title">
        <div className="panel-title"><AlertTriangle size={19} /><h2 id="port-conflict-title">Port Already In Use</h2></div>
        <p>{prompt}</p>
        <ul className="conflict-list">
          {conflicts.map((conflict) => (
            <li key={`${conflict.name}-${conflict.port}`}>
              <strong>{conflict.name} port {conflict.port}</strong>
              <span>{conflict.host}</span>
              <small>{formatPortOwners(conflict.owners)}</small>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="ghost" onClick={cancel} disabled={activeAction === "start"}>Keep current process</button>
          <button className="danger" onClick={stopAndStart} disabled={activeAction === "start"}>
            {activeAction === "start" ? <Spinner /> : <Square size={17} />}Stop and Start Ray
          </button>
        </div>
      </section>
    </div>
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
    const constrained = constrainConfigToHardware(next, hardware);
    savedConfigRef.current = constrained; // mark as saved before the round-trip
    setDraft(constrained);
    await saveConfig(constrained);
  }

  function updateCoordinator(patch: Partial<AppConfig["coordinator"]>) {
    setDraft((d) => ({ ...d, coordinator: { ...d.coordinator, ...patch } }));
  }
  function updateCaps(patch: Partial<AppConfig["resource_caps"]>) {
    setDraft((d) => constrainConfigToHardware({ ...d, resource_caps: { ...d.resource_caps, ...patch } }, hardware));
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
      await window.electronAPI.invoke("open_dashboard", { url: `http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}` });
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
          <NumberField label={<LabelWithDetected label="CPUs offered" detected={formatCpuDetected(hardware)} />} value={draft.resource_caps.cpus} min={1} max={hardware?.cpu_logical} onChange={(cpus) => updateCaps({ cpus })} />
          <NumberField label={<LabelWithDetected label="GPUs offered" detected={formatGpuDetected(hardware)} />} value={draft.resource_caps.gpus} min={0} max={hardware?.gpu_count} onChange={(gpus) => updateCaps({ gpus })} />
          <NumberField label={<LabelWithDetected label="System RAM offered" detected={formatMemoryDetected(hardware)} />} value={draft.resource_caps.memory_gb} min={1} max={hardware?.memory_total_gb ?? undefined} onChange={(memory_gb) => updateCaps({ memory_gb })} />
          <NumberField label="Max concurrent jobs" value={draft.resource_caps.max_concurrent_jobs} min={1} onChange={(max_concurrent_jobs) => updateCaps({ max_concurrent_jobs })} />
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
      await window.electronAPI.invoke("open_dashboard", { url: `http://${config.coordinator.head_host}:${config.coordinator.dashboard_port}` });
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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragState = useRef<GraphDragState | null>(null);
  const [positions, setPositions] = useState<Record<string, GraphPosition>>({});
  const [viewport, setViewport] = useState<GraphViewport>({ x: 0, y: 0, k: 1 });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  const layoutNodes = useMemo(() => buildGraphNodes(config, nodes), [config, nodes]);

  useEffect(() => {
    setPositions((current) => {
      const next = { ...current };
      const activeIds = new Set(layoutNodes.map((node) => node.id));
      let changed = false;

      for (const node of layoutNodes) {
        if (!next[node.id]) {
          next[node.id] = { x: node.x, y: node.y };
          changed = true;
        }
      }
      for (const id of Object.keys(next)) {
        if (!activeIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [layoutNodes]);

  const graphNodes = layoutNodes.map((node) => ({ ...node, ...(positions[node.id] ?? { x: node.x, y: node.y }) }));
  const coordinator = graphNodes.find((node) => node.kind === "coordinator") ?? graphNodes[0];
  const workers = graphNodes.filter((node) => node.kind === "worker");

  function zoomAt(point: GraphPosition, factor: number) {
    setViewport((current) => {
      const nextScale = clamp(current.k * factor, GRAPH_MIN_ZOOM, GRAPH_MAX_ZOOM);
      const graphPoint = screenToGraph(point, current);
      return {
        k: nextScale,
        x: point.x - graphPoint.x * nextScale,
        y: point.y - graphPoint.y * nextScale,
      };
    });
  }

  function resetGraph() {
    const nextPositions = Object.fromEntries(layoutNodes.map((node) => [node.id, { x: node.x, y: node.y }]));
    setPositions(nextPositions);
    setViewport({ x: 0, y: 0, k: 1 });
  }

  function onWheel(event: ReactWheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    zoomAt(svgPoint(svg, event), event.deltaY > 0 ? 0.88 : 1.12);
  }

  function startPan(event: ReactPointerEvent<SVGRectElement>) {
    if (event.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    const point = svgPoint(svg, event);
    dragState.current = { type: "pan", pointerId: event.pointerId, startX: point.x, startY: point.y, panX: viewport.x, panY: viewport.y };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startNodeDrag(event: ReactPointerEvent<SVGGElement>, node: GraphNodeModel) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const point = screenToGraph(svgPoint(svg, event), viewport);
    dragState.current = { type: "node", pointerId: event.pointerId, id: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y };
    setDraggingId(node.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const state = dragState.current;
    const svg = svgRef.current;
    if (!state || !svg || state.pointerId !== event.pointerId) return;

    const point = svgPoint(svg, event);
    if (state.type === "pan") {
      setViewport((current) => ({ ...current, x: state.panX + point.x - state.startX, y: state.panY + point.y - state.startY }));
      return;
    }

    const graphPoint = screenToGraph(point, viewport);
    setPositions((current) => ({
      ...current,
      [state.id]: { x: graphPoint.x - state.offsetX, y: graphPoint.y - state.offsetY },
    }));
  }

  function stopDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDraggingId(null);
    setIsPanning(false);
  }

  return (
    <div className="cluster-graph-shell">
      <div className="graph-toolbar" aria-label="Graph controls">
        <button className="icon-button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(GRAPH_CENTER, 1.18)}><ZoomIn size={17} /></button>
        <button className="icon-button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(GRAPH_CENTER, 0.84)}><ZoomOut size={17} /></button>
        <button className="icon-button" title="Reset graph" aria-label="Reset graph" onClick={resetGraph}><Maximize2 size={17} /></button>
      </div>
      <svg
        ref={svgRef}
        className={cls("cluster-graph", isPanning && "panning")}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        role="img"
        aria-label="Ray cluster node graph"
        onWheel={onWheel}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <defs>
          <radialGradient id="graphCoordinatorFill" cx="38%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="68%" stopColor="#d7f2df" />
            <stop offset="100%" stopColor="#9fd4b2" />
          </radialGradient>
          <radialGradient id="graphWorkerFill" cx="38%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="65%" stopColor="#ddeef4" />
            <stop offset="100%" stopColor="#9fc4d1" />
          </radialGradient>
          <radialGradient id="graphDownFill" cx="38%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#fff7f5" />
            <stop offset="66%" stopColor="#f2d7d2" />
            <stop offset="100%" stopColor="#cf9189" />
          </radialGradient>
        </defs>
        <rect className="graph-hit-zone" width={GRAPH_WIDTH} height={GRAPH_HEIGHT} onPointerDown={startPan} />
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
          <g className="graph-links">
            {workers.map((node) => (
              <line
                className={cls("graph-link", node.statusClass)}
                key={`link-${node.id}`}
                x1={coordinator.x}
                y1={coordinator.y}
                x2={node.x}
                y2={node.y}
              />
            ))}
          </g>
          <g className="graph-node-layer">
            {graphNodes.map((node) => (
              <g
                className={cls("graph-node", `graph-node-${node.kind}`, node.statusClass, draggingId === node.id && "dragging")}
                key={node.id}
                transform={`translate(${node.x} ${node.y})`}
                onPointerDown={(event) => startNodeDrag(event, node)}
              >
                <title>{node.tooltip}</title>
                <circle className="graph-node-halo" r={node.radius + 11} />
                <circle className="graph-node-body" r={node.radius} />
                <circle className="graph-status-dot" cx={node.radius * 0.58} cy={-node.radius * 0.55} r="6" />
                <text y="-9" textAnchor="middle" className="graph-node-title">{truncateMiddle(node.label, node.kind === "coordinator" ? 20 : 16)}</text>
                <text y="9" textAnchor="middle" className="graph-node-subtitle">{truncateMiddle(node.detail, 18)}</text>
                <text y="27" textAnchor="middle" className="graph-node-metric">{node.metric}</text>
              </g>
            ))}
          </g>
        </g>
      </svg>
      <div className="graph-scale"><Move size={14} />{Math.round(viewport.k * 100)}%</div>
      {nodes.length === 0 && <div className="graph-empty">No workers reported yet. Start Ray or wait for nodes to check in.</div>}
    </div>
  );
}

const GRAPH_WIDTH = 980;
const GRAPH_HEIGHT = 520;
const GRAPH_CENTER = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
const GRAPH_MIN_ZOOM = 0.45;
const GRAPH_MAX_ZOOM = 2.4;

type GraphPosition = { x: number; y: number };
type GraphViewport = GraphPosition & { k: number };
type GraphNodeKind = "coordinator" | "worker";
type GraphStatusClass = "alive" | "warning" | "down";
type GraphNodeModel = GraphPosition & {
  id: string;
  kind: GraphNodeKind;
  label: string;
  detail: string;
  metric: string;
  tooltip: string;
  statusClass: GraphStatusClass;
  radius: number;
};
type GraphDragState =
  | { type: "pan"; pointerId: number; startX: number; startY: number; panX: number; panY: number }
  | { type: "node"; pointerId: number; id: string; offsetX: number; offsetY: number };

function buildGraphNodes(config: AppConfig, nodes: NodeInfo[]): GraphNodeModel[] {
  const center = GRAPH_CENTER;
  const result: GraphNodeModel[] = [{
    id: "coordinator",
    kind: "coordinator",
    label: "Coordinator",
    detail: `${config.coordinator.head_host}:${config.coordinator.ray_port}`,
    metric: "Head node",
    tooltip: `Coordinator\n${config.coordinator.head_host}:${config.coordinator.ray_port}`,
    statusClass: "alive",
    radius: 58,
    x: center.x,
    y: center.y,
  }];
  const seenIds = new Map<string, number>();

  nodes.forEach((node, index) => {
    const id = uniqueWorkerGraphId(node, seenIds);
    const ringSize = 8;
    const ring = Math.floor(index / ringSize);
    const positionInRing = index % ringSize;
    const workersInRing = Math.min(ringSize, nodes.length - ring * ringSize);
    const angle = -Math.PI / 2 + (positionInRing / Math.max(1, workersInRing)) * Math.PI * 2 + ring * 0.34;
    const radiusX = 230 + ring * 118;
    const radiusY = 146 + ring * 82;
    const statusClass = graphStatusClass(node.status);
    const x = clamp(center.x + Math.cos(angle) * radiusX, 78, GRAPH_WIDTH - 78);
    const y = clamp(center.y + Math.sin(angle) * radiusY, 76, GRAPH_HEIGHT - 76);

    result.push({
      id,
      kind: "worker",
      label: node.hostname || node.node_id || "Worker",
      detail: node.status || "unknown",
      metric: `${node.cpus_total} CPU / ${node.gpus_total} GPU`,
      tooltip: `${node.hostname || node.node_id}\n${node.status}\n${node.cpus_total} CPU / ${node.gpus_total} GPU / ${node.memory_total_gb.toFixed(1)} GB RAM`,
      statusClass,
      radius: 50,
      x,
      y,
    });
  });

  return result;
}

function uniqueWorkerGraphId(node: NodeInfo, seenIds: Map<string, number>) {
  const base = `worker:${node.hostname || node.node_id || "unknown"}`.toLowerCase();
  const count = seenIds.get(base) ?? 0;
  seenIds.set(base, count + 1);
  return count === 0 ? base : `${base}:${count + 1}`;
}

function graphStatusClass(status: string): GraphStatusClass {
  const normalized = status.toLowerCase();
  if (normalized.includes("dead") || normalized.includes("fail") || normalized.includes("lost")) return "down";
  if (normalized.includes("alive") || normalized.includes("running")) return "alive";
  return "warning";
}

function svgPoint(svg: SVGSVGElement, event: { clientX: number; clientY: number }): GraphPosition {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (matrix) {
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }
  const rect = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * GRAPH_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * GRAPH_HEIGHT,
  };
}

function screenToGraph(point: GraphPosition, viewport: GraphViewport): GraphPosition {
  return { x: (point.x - viewport.x) / viewport.k, y: (point.y - viewport.y) / viewport.k };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

function NodeHome({ openTerminal }: { openTerminal: () => void }) {
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

  function updateResourceCaps(patch: Partial<AppConfig["resource_caps"]>) {
    setConfig(constrainConfigToHardware({ ...config, resource_caps: { ...config.resource_caps, ...patch } }, hardware));
  }

  return (
    <div className="grid two">
      <SetupPanel setupRun={setupRun} refresh={refresh} status={status} compact openTerminal={openTerminal} />
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
        <NumberField label={<LabelWithDetected label="CPUs" detected={formatCpuDetected(hardware)} />} value={config.resource_caps.cpus} min={1} max={hardware?.cpu_logical} onChange={(cpus) => updateResourceCaps({ cpus })} />
        <NumberField label={<LabelWithDetected label="GPUs" detected={formatGpuDetected(hardware)} />} value={config.resource_caps.gpus} min={0} max={hardware?.gpu_count} onChange={(gpus) => updateResourceCaps({ gpus })} />
        <NumberField label={<LabelWithDetected label="System RAM cap" detected={formatMemoryDetected(hardware)} />} value={config.resource_caps.memory_gb} min={1} max={hardware?.memory_total_gb ?? undefined} onChange={(memory_gb) => updateResourceCaps({ memory_gb })} />
        <NumberField label={<LabelWithDetected label="GPU memory cap" detected={formatGpuMemoryDetected(hardware)} />} value={config.resource_caps.gpu_memory_gb} min={0} max={hardware?.gpu_memory_total_gb ?? undefined} onChange={(gpu_memory_gb) => updateResourceCaps({ gpu_memory_gb })} />
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
  const status = useStore((s) => s.status);
  const setConfig = useStore((s) => s.setConfig);
  const saveConfig = useStore((s) => s.saveConfig);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("Scan this machine's LAN for reachable Ray coordinators.");
  const rayRunning = status?.state === "running" || status?.state === "starting";

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
    if (rayRunning) {
      setScanMessage("Stop Ray before changing coordinator. Scan does not interrupt the current connection.");
      return;
    }
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
      {rayRunning && <p className="panel-copy">Ray is running. Scan is safe, but switching coordinator is disabled until you stop Ray.</p>}
      {candidates.length > 0 && (
        <div className="discovery-list">
          {candidates.map((candidate) => (
            <div className="discovery-row" key={`${candidate.host}:${candidate.ray_port}`}>
              <div>
                <strong>{candidate.host}:{candidate.ray_port}</strong>
                <span>{candidate.detail}</span>
                {candidate.dashboard_url && <small>{candidate.dashboard_url}</small>}
              </div>
            <div className="confidence"><button onClick={() => useCandidate(candidate)} disabled={rayRunning}>{rayRunning ? "Stop Ray first" : "Use"}</button></div>
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
        <div className="readonly-field">
          <span>Container runtime</span>
          <strong>Docker</strong>
          <small>Managed by RayLab setup</small>
        </div>
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

function SetupView({ openTerminal }: { openTerminal: () => void }) {
  const setupRun = useStore((s) => s.setupRun);
  const diagnostics = useStore((s) => s.status?.diagnostics ?? []);
  const rayInstall = useStore((s) => s.rayInstall);
  const refresh = useStore((s) => s.refresh);
  const summary = useMemo(() => summarizeDiagnostics(diagnostics), [diagnostics]);
  return (
    <div className="single-view">
      <div className="view-title"><ListChecks size={20} /><h2>Setup</h2></div>
      <section className="panel wide">
        <div className="panel-title"><ShieldCheck size={19} /><h2>Readiness Checks</h2><button className="ghost" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button></div>
        <p className="panel-copy">{summary}</p>
        <DiagnosticsList diagnostics={diagnostics} rayInstall={rayInstall} refresh={refresh} openTerminal={openTerminal} />
      </section>
      <SetupPanel setupRun={setupRun} refresh={refresh} showTaskList={false} openTerminal={openTerminal} />
    </div>
  );
}

function TerminalDock({ close, height, onHeightChange }: { close: () => void; height: number; onHeightChange: (height: number) => void }) {
  const logs = useStore((s) => s.terminalLogs);
  const refresh = useStore((s) => s.refresh);
  const outputRef = useRef<HTMLDivElement | null>(null);

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    function onPointerMove(moveEvent: PointerEvent) {
      onHeightChange(clampTerminalHeight(startHeight + startY - moveEvent.clientY));
    }

    function stopResize() {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onHeightChange(clampTerminalHeight(height + 24));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onHeightChange(clampTerminalHeight(height - 24));
    } else if (event.key === "Home") {
      event.preventDefault();
      onHeightChange(TERMINAL_MIN_HEIGHT);
    } else if (event.key === "End") {
      event.preventDefault();
      onHeightChange(clampTerminalHeight(TERMINAL_MAX_HEIGHT));
    }
  }

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
    <section className="terminal-dock" style={{ height }} role="region" aria-label="Terminal logs">
      <div className="terminal-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Resize terminal" tabIndex={0} onKeyDown={resizeWithKeyboard} onPointerDown={startResize} />
      <div className="terminal-dock-title">
        <div><Terminal size={17} /><strong>Terminal</strong><span>Setup and Ray logs</span></div>
        <div className="terminal-dock-actions">
          <button className="ghost" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button>
          <button className="ghost close-terminal" title="Hide terminal" onClick={close}><X size={17} />Hide</button>
        </div>
      </div>
      <div className="terminal-output" ref={outputRef}>
        {logs.length === 0 && <div className="terminal-empty">No logs yet.</div>}
        {logs.map((entry, index) => (
          <div className={cls("terminal-line", entry.stream === "stderr" && "error-line")} key={`${entry.timestamp}-${index}`}>
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

function SetupPanel({ setupRun, refresh, status = null, compact = false, showTaskList = true, openTerminal }: { setupRun: SetupRunStatus | null; refresh: () => Promise<void>; status?: ClusterStatus | null; compact?: boolean; showTaskList?: boolean; openTerminal?: () => void }) {
  const config = useStore((s) => s.config);
  const [running, setRunning] = useState(false);

  async function runSetup() {
    setRunning(true);
    openTerminal?.();
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
  const currentTask = tasks.find((task) => task.status === "running") ?? null;
  const showNetworkTest = config.app_mode === "node";
  return (
    <section className={cls("setup-panel", compact && "compact")}>
      <div className="setup-head">
        <div>
          <strong>Machine setup</strong>
          <span>{setupRun?.message ?? "Run setup to prepare this machine for RayLab."}</span>
        </div>
        <div className="setup-actions">
          {showNetworkTest && <NetworkPreflightButton refresh={refresh} openTerminal={openTerminal} />}
          <button className="ghost" onClick={() => void runSetup()} disabled={isRunning}>
            {isRunning ? <Spinner size={16} /> : <Play size={16} />}{isRunning ? "Running…" : "Run setup"}
          </button>
        </div>
      </div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${setupRun?.progress ?? 0}%` }} /></div>
      <div className="progress-meta"><span>{setupRun?.progress ?? 0}% complete</span><span>{setupRun?.can_continue ? "Ready to continue" : "Not ready yet"}</span></div>
      {!showTaskList && currentTask && <div className="setup-current"><Spinner size={16} /><span>{currentTask.label}: {currentTask.detail}</span></div>}
      {showTaskList && visibleTasks.length > 0 && <div className="setup-tasks">{visibleTasks.map((task) => <SetupTaskRow task={task} refresh={refresh} openTerminal={openTerminal} key={task.id} />)}</div>}
    </section>
  );
}

function SetupTaskRow({ task, refresh, openTerminal }: { task: SetupTask; refresh: () => Promise<void>; openTerminal?: () => void }) {
  const icon = task.status === "pass" ? <CheckCircle2 size={16} /> : task.status === "fail" ? <XCircle size={16} /> : task.status === "running" ? <Spinner size={16} /> : <AlertTriangle size={16} />;
  return <div className={cls("setup-task", task.status)}>{icon}<div><strong>{task.label}</strong><span>{task.detail}</span>{task.fix && <small>{task.fix}</small>}{task.id === "worker_account" && task.status !== "pass" && <WorkerAccountButton refresh={refresh} />}{task.id === "container" && task.status !== "pass" && <DockerInstallButton refresh={refresh} openTerminal={openTerminal} />}{task.id === "ports" && task.status !== "pass" && <NetworkPreflightButton refresh={refresh} openTerminal={openTerminal} />}</div></div>;
}

function WorkerAccountButton({ refresh }: { refresh: () => Promise<void> }) {
  const activeAction = useStore((s) => s.activeAction);
  const setActiveAction = useStore((s) => s.setActiveAction);
  const setError = useStore((s) => s.setError);
  const setNotice = useStore((s) => s.setNotice);
  const busy = activeAction === "worker-account";

  async function createAccount() {
    setActiveAction("worker-account");
    setError(null);
    try {
      const result = await api.createWorkerAccount();
      setNotice(result.message);
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Worker account setup failed"));
      await refresh();
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <button className="ghost inline-fix-button" onClick={() => void createAccount()} disabled={busy}>
      {busy ? <Spinner size={16} /> : <UserPlus size={16} />}Create account
    </button>
  );
}

function DockerInstallButton({ refresh, openTerminal }: { refresh: () => Promise<void>; openTerminal?: () => void }) {
  const activeAction = useStore((s) => s.activeAction);
  const setActiveAction = useStore((s) => s.setActiveAction);
  const setError = useStore((s) => s.setError);
  const setNotice = useStore((s) => s.setNotice);
  const busy = activeAction === "docker-install";

  async function installDocker() {
    openTerminal?.();
    setActiveAction("docker-install");
    setError(null);
    try {
      const result = await api.installDocker();
      setNotice(result.message);
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Docker installation failed"));
      await refresh();
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <button className="ghost inline-fix-button" onClick={() => void installDocker()} disabled={busy}>
      {busy ? <Spinner size={16} /> : <Download size={16} />}Install Docker
    </button>
  );
}

function NetworkPreflightButton({ refresh, openTerminal }: { refresh: () => Promise<void>; openTerminal?: () => void }) {
  const activeAction = useStore((s) => s.activeAction);
  const setActiveAction = useStore((s) => s.setActiveAction);
  const setError = useStore((s) => s.setError);
  const setNotice = useStore((s) => s.setNotice);
  const busy = activeAction === "network-preflight";

  async function runNetworkTest() {
    openTerminal?.();
    setActiveAction("network-preflight");
    setError(null);
    try {
      const result = await api.runNetworkPreflight();
      if (result.ok) {
        setNotice(result.summary);
      } else {
        const failed = result.checks.filter((check) => check.status !== "pass");
        const detail = failed.length > 0 ? ` ${failed.map((check) => `TCP ${check.port}: ${check.detail}`).join(" ")}` : "";
        setError(`${result.summary}.${detail}`);
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Network test failed"));
      await refresh();
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <button className="ghost inline-fix-button" onClick={() => void runNetworkTest()} disabled={busy}>
      {busy ? <Spinner size={16} /> : <Activity size={16} />}Run network test
    </button>
  );
}

function DiagnosticsList({ diagnostics, rayInstall, refresh, openTerminal }: { diagnostics: DiagnosticCheck[]; rayInstall: InstallStatus | null; refresh: () => Promise<void>; openTerminal?: () => void }) {
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
            {item.id === "worker_account" && item.status !== "pass" && <WorkerAccountButton refresh={refresh} />}
            {item.id === "container_runtime" && item.status !== "pass" && <DockerInstallButton refresh={refresh} openTerminal={openTerminal} />}
            {item.id === "network_preflight" && <NetworkPreflightButton refresh={refresh} openTerminal={openTerminal} />}
            {item.id === "ray" && rayInstall && rayInstall.message !== "Not started" && <small className="install-log">{rayInstall.message}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function NumberField({ label, value, onChange, min, max, step = 1 }: { label: React.ReactNode; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <label>{label}<input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}

function LabelWithDetected({ label, detected }: { label: string; detected: string }) {
  return <span className="label-with-detected"><span>{label}</span><small>{detected}</small></span>;
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

function isPortConflictMessage(message: string) {
  return message.toLowerCase().includes("port conflict");
}

function formatPortOwners(owners: PortConflict["owners"]) {
  if (!owners || owners.length === 0) return "Owner process not reported by the OS";
  return `Owner: ${owners.map((owner) => `${owner.command} (${owner.pid})`).join(", ")}`;
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
