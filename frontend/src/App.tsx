import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleStop,
  Copy,
  Cpu,
  ExternalLink,
  FileText,
  Gauge,
  HardDriveDownload,
  LayoutDashboard,
  ListRestart,
  Network,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Square,
  SquareTerminal,
  Trash2,
  Wifi,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "./api";
import { ClusterGraph } from "./ClusterGraph";
import { buildJobSubmission, canStopJob, defaultJobDraft, formatRayTime, isTerminalJob, type JobDraft } from "./jobs";
import { defaultLifecycleConfig, MANAGED_CLUSTER_ID, prefillCoordinatorNodeIp } from "./roles";
import { normalizeDashboardUrl, useStore } from "./store";
import type { AppMode, AppView, LifecycleConfig, RayJob, SavedCluster } from "./types";

function cls(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function Spinner({ size = 17 }: { size?: number }) {
  return <RefreshCw className="spin" size={size} />;
}

export function App() {
  const hydrated = useStore((state) => state.hydrated);
  const activeView = useStore((state) => state.active_view);
  const appMode = useStore((state) => state.app_mode);
  const lifecycleStatus = useStore((state) => state.lifecycleStatus);
  const selectedClusterId = useStore((state) => state.selected_cluster_id);
  const clusters = useStore((state) => state.saved_clusters);
  const preferences = useStore((state) => state.preferences);
  const error = useStore((state) => state.error);
  const notice = useStore((state) => state.notice);
  const hydrate = useStore((state) => state.hydrate);
  const refreshCluster = useStore((state) => state.refreshCluster);
  const refreshLifecycle = useStore((state) => state.refreshLifecycle);
  const setNotice = useStore((state) => state.setNotice);

  const cluster = useMemo(
    () => clusters.find((item) => item.id === selectedClusterId) ?? null,
    [clusters, selectedClusterId],
  );

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated || !cluster || (cluster.managed && lifecycleStatus?.state !== "running")) return;
    void refreshCluster();
  }, [cluster?.id, hydrated, lifecycleStatus?.state, refreshCluster]);

  useEffect(() => {
    if (!hydrated || appMode === "unconfigured") return;
    void refreshLifecycle();
  }, [appMode, hydrated, refreshLifecycle]);

  useEffect(() => {
    if (!hydrated || appMode === "unconfigured" || !preferences.auto_refresh) return;
    const timer = window.setInterval(() => {
      void refreshLifecycle();
      if (cluster && (!cluster.managed || lifecycleStatus?.state === "running")) void refreshCluster();
    }, preferences.poll_interval_ms);
    return () => window.clearInterval(timer);
  }, [appMode, cluster?.id, hydrated, lifecycleStatus?.state, preferences.auto_refresh, preferences.poll_interval_ms, refreshCluster, refreshLifecycle]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);

  if (!hydrated) {
    return <div className="loading-screen"><div className="brand-mark"><Server size={24} /></div><Spinner size={24} /><p>Loading RayLab…</p></div>;
  }

  if (appMode === "unconfigured" || clusters.length === 0 || !cluster) {
    return <RoleOnboarding />;
  }

  return (
    <main className="app-shell">
      <Sidebar activeView={activeView} />
      <section className="workspace">
        <Topbar cluster={cluster} />
        <div className="content">
          {error && <Banner kind="error" message={error} />}
          {notice && <Banner kind="success" message={notice} />}
          {activeView === "overview" && <Overview cluster={cluster} />}
          {activeView === "jobs" && <JobsView cluster={cluster} />}
          {activeView === "nodes" && <NodesView />}
          {activeView === "settings" && <SettingsView />}
        </div>
      </section>
    </main>
  );
}

function Sidebar({ activeView }: { activeView: AppView }) {
  const setView = useStore((state) => state.setActiveView);
  const connection = useStore((state) => state.connection);
  const version = useStore((state) => state.version);
  const mode = useStore((state) => state.app_mode);
  const lifecycle = useStore((state) => state.lifecycleStatus);
  const items: Array<{ id: AppView; label: string; icon: typeof LayoutDashboard }> = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "jobs", label: "Jobs", icon: SquareTerminal },
    { id: "nodes", label: "Nodes", icon: Boxes },
    { id: "settings", label: "Settings", icon: Settings },
  ];
  return (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Server size={19} /></div><div><strong>RayLab</strong><small>Ray control plane</small></div></div>
      <nav>
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={cls("nav-item", activeView === id && "active")} onClick={() => setView(id)}>
            <Icon size={18} />{label}
          </button>
        ))}
      </nav>
      <div className="sidebar-status">
        <span className={cls("connection-dot", lifecycle?.state === "running" ? "connected" : lifecycle?.state === "error" ? "error" : connection)} />
        <div><strong>{lifecycle?.state === "running" ? (mode === "coordinator" ? "Coordinator online" : "Worker sharing") : lifecycle?.state === "error" ? "Lifecycle needs attention" : "Ray stopped"}</strong><small>{version?.ray_version ? `Ray ${version.ray_version}` : mode === "coordinator" ? "Host mode" : "Worker mode"}</small></div>
      </div>
    </aside>
  );
}

function Topbar({ cluster }: { cluster: SavedCluster }) {
  const clusters = useStore((state) => state.saved_clusters);
  const selectCluster = useStore((state) => state.selectCluster);
  const refresh = useStore((state) => state.refreshCluster);
  const loading = useStore((state) => state.loading);
  const connection = useStore((state) => state.connection);
  const setError = useStore((state) => state.setError);
  const mode = useStore((state) => state.app_mode);
  return (
    <header className="topbar">
      <div className="cluster-heading">
        <p className="eyebrow">{mode === "coordinator" ? "Coordinator mode" : "Worker mode"}</p>
        <div className="cluster-title"><h1>{cluster.name}</h1><span className={cls("status-pill", connection)}>{connectionLabel(connection)}</span></div>
      </div>
      <div className="topbar-actions">
        <select aria-label="Selected cluster" value={cluster.id} onChange={(event) => selectCluster(event.target.value)}>
          {clusters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button className="secondary" onClick={() => void api.openDashboard(cluster).catch((error) => setError(errorMessage(error, "Could not open dashboard")))}>
          <ExternalLink size={16} />Dashboard
        </button>
        <button className="icon-button" title="Refresh cluster" aria-label="Refresh cluster" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCw size={17} />}
        </button>
      </div>
    </header>
  );
}

function Overview({ cluster }: { cluster: SavedCluster }) {
  const jobs = useStore((state) => state.jobs);
  const nodes = useStore((state) => state.nodes);
  const version = useStore((state) => state.version);
  const connection = useStore((state) => state.connection);
  const setView = useStore((state) => state.setActiveView);
  const mode = useStore((state) => state.app_mode);
  const activeJobs = jobs.filter((job) => !isTerminalJob(job)).length;
  const failedJobs = jobs.filter((job) => job.status === "FAILED").length;
  const aliveNodes = nodes.filter((node) => ["ALIVE", "RUNNING"].includes(node.status)).length;

  return (
    <div className="page-stack">
      <LifecyclePanel />
      <section className="hero-card">
        <div>
          <span className="hero-kicker"><Activity size={15} /> {mode === "coordinator" ? "Cluster coordination" : "Shared compute node"}</span>
          <h2>{connection === "connected" ? "Your Ray cluster is ready." : mode === "coordinator" ? "Start the coordinator to accept workers." : "Join the coordinator to share this machine."}</h2>
          <p>RayLab uses a narrow native adapter for local node start/stop, then manages jobs, logs, health, and observability through Ray’s structured APIs.</p>
          <div className="hero-actions">
            <button onClick={() => setView("jobs")}><Rocket size={17} />Submit a job</button>
            <button className="secondary" onClick={() => setView("nodes")}><Boxes size={17} />Inspect nodes</button>
          </div>
        </div>
        <div className="endpoint-card"><small>Dashboard endpoint</small><code>{cluster.dashboard_url}</code><span>{version?.version ? `Jobs API ${version.version}` : "Waiting for API version"}</span></div>
      </section>

      <section className="metric-grid">
        <Metric icon={ListRestart} label="Jobs" value={jobs.length} detail={`${activeJobs} active`} tone="blue" />
        <Metric icon={Boxes} label="Nodes" value={nodes.length} detail={`${aliveNodes} alive`} tone="green" />
        <Metric icon={XCircle} label="Failed" value={failedJobs} detail="Recorded jobs" tone={failedJobs ? "red" : "neutral"} />
        <Metric icon={Gauge} label="Ray version" value={version?.ray_version || "—"} detail="Reported by API" tone="violet" />
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Recent activity</p><h2>Latest jobs</h2></div><button className="text-button" onClick={() => setView("jobs")}>View all <ArrowRight size={15} /></button></div>
        <JobTable jobs={jobs.slice(0, 6)} onSelect={(id) => { useStore.getState().setSelectedJob(id); setView("jobs"); }} />
      </section>
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: typeof Gauge; label: string; value: string | number; detail: string; tone: string }) {
  return <div className="metric-card"><div className={cls("metric-icon", tone)}><Icon size={19} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>;
}

function LifecyclePanel() {
  const mode = useStore((state) => state.app_mode);
  const status = useStore((state) => state.lifecycleStatus);
  const busy = useStore((state) => state.lifecycleLoading);
  const installing = useStore((state) => state.runtimeInstalling);
  const start = useStore((state) => state.startLifecycle);
  const stop = useStore((state) => state.stopLifecycle);
  const install = useStore((state) => state.installRuntime);
  const setNotice = useStore((state) => state.setNotice);
  const setError = useStore((state) => state.setError);
  const [token, setToken] = useState<string | null>(null);
  const isRunning = status?.state === "running";
  const runtimeReady = status?.runtime.ready === true;

  async function revealToken() {
    try {
      const result = await api.revealClusterToken(MANAGED_CLUSTER_ID);
      setToken(result.token);
    } catch (error) {
      setError(errorMessage(error, "Could not reveal the cluster token"));
    }
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setNotice("Cluster token copied");
    } catch {
      setError("Clipboard access was unavailable. Select and copy the displayed token manually.");
    }
  }

  return (
    <section className={cls("lifecycle-panel", status?.state || "stopped")}>
      <div className="lifecycle-main">
        <div className="lifecycle-icon">{mode === "coordinator" ? <Server size={23} /> : <Cpu size={23} />}</div>
        <div>
          <p className="eyebrow">Local Ray lifecycle</p>
          <h2>{mode === "coordinator" ? "Coordinator" : "Worker"} · {status?.state || "checking"}</h2>
          <p>{status?.message || "Checking this machine…"}</p>
        </div>
      </div>

      <div className="lifecycle-details">
        <div><small>{mode === "coordinator" ? "Workers join" : "Coordinator"}</small><code>{status?.join_address || "Detecting…"}</code></div>
        <div><small>Local node</small><code>{status?.local_node_ip || "Detecting…"}</code></div>
        <div><small>Runtime</small><strong>{status?.runtime.ray_version ? `Ray ${status.runtime.ray_version}` : "Not installed"}</strong></div>
      </div>

      {mode === "coordinator" && (
        <div className="join-secret">
          <div><ShieldCheck size={16} /><span><strong>Shared cluster token</strong><small>Give this and the join address only to trusted workers.</small></span></div>
          <div className="secret-actions">
            {token && <input aria-label="Shared cluster token" readOnly value={token} onFocus={(event) => event.currentTarget.select()} />}
            {!token && <button className="secondary" onClick={() => void revealToken()}>Reveal token</button>}
            {token && <button className="secondary" onClick={() => void copyToken()}><Copy size={15} />Copy</button>}
          </div>
        </div>
      )}

      <div className="lifecycle-actions">
        {!runtimeReady && (
          <button onClick={() => void install()} disabled={installing || busy || status?.state === "error"}>
            {installing ? <Spinner /> : <HardDriveDownload size={17} />}{installing ? "Installing Ray…" : "Install managed runtime"}
          </button>
        )}
        {runtimeReady && !isRunning && status?.state !== "error" && (
          <button onClick={() => void start()} disabled={busy}>
            {busy ? <Spinner /> : <Play size={17} />}{mode === "coordinator" ? "Start coordinator" : "Join cluster"}
          </button>
        )}
        {(isRunning || status?.state === "error") && (
          <button className="danger" onClick={() => void stop()} disabled={busy}>
            {busy ? <Spinner /> : <Square size={16} />}{mode === "coordinator" ? "Stop coordinator" : "Leave cluster"}
          </button>
        )}
        <span><ShieldCheck size={14} />Lifecycle commands are fixed and validated by Tauri.</span>
      </div>
    </section>
  );
}

function JobsView({ cluster }: { cluster: SavedCluster }) {
  const jobs = useStore((state) => state.jobs);
  const selectedJobId = useStore((state) => state.selected_job_id);
  const jobsLoading = useStore((state) => state.jobsLoading);
  const preferences = useStore((state) => state.preferences);
  const setSelectedJob = useStore((state) => state.setSelectedJob);
  const refreshJobs = useStore((state) => state.refreshJobs);
  const setError = useStore((state) => state.setError);
  const setNotice = useStore((state) => state.setNotice);
  const [draft, setDraft] = useState<JobDraft>(defaultJobDraft);
  const [submitting, setSubmitting] = useState(false);
  const [selectedJob, setSelectedJobDetail] = useState<RayJob | null>(null);
  const [logs, setLogs] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const selectedFromList = jobs.find((job) => job.id === selectedJobId) ?? null;
  const currentJob = selectedJob?.id === selectedJobId ? selectedJob : selectedFromList;
  const filteredJobs = jobs.filter((job) => `${job.id} ${job.entrypoint} ${job.status}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (!selectedJobId && jobs[0]) setSelectedJob(jobs[0].id);
  }, [jobs, selectedJobId, setSelectedJob]);

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJobDetail(null);
      setLogs("");
      return;
    }
    let cancelled = false;
    async function load() {
      setDetailLoading(true);
      const [jobResult, logsResult] = await Promise.allSettled([
        api.getJob(cluster, selectedJobId as string),
        api.getJobLogs(cluster, selectedJobId as string),
      ]);
      if (cancelled) return;
      if (jobResult.status === "fulfilled") setSelectedJobDetail(jobResult.value);
      if (logsResult.status === "fulfilled") setLogs(logsResult.value);
      if (jobResult.status === "rejected") setError(errorMessage(jobResult.reason, "Could not load job details"));
      setDetailLoading(false);
    }
    void load();
    const timer = preferences.auto_refresh ? window.setInterval(() => void load(), preferences.poll_interval_ms) : null;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [cluster.id, preferences.auto_refresh, preferences.poll_interval_ms, selectedJobId, setError]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.submitJob(cluster, buildJobSubmission(draft));
      setNotice(`Job ${result.submission_id} submitted`);
      setSelectedJob(result.submission_id);
      await refreshJobs();
    } catch (error) {
      setError(errorMessage(error, "Job submission failed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function reloadDetail() {
    if (!selectedJobId) return;
    setDetailLoading(true);
    try {
      const [job, output] = await Promise.all([api.getJob(cluster, selectedJobId), api.getJobLogs(cluster, selectedJobId)]);
      setSelectedJobDetail(job);
      setLogs(output);
    } catch (error) {
      setError(errorMessage(error, "Could not refresh job"));
    } finally {
      setDetailLoading(false);
    }
  }

  async function stop() {
    if (!currentJob) return;
    setAction("stop");
    try {
      await api.stopJob(cluster, currentJob.id);
      setNotice(`Stop requested for ${currentJob.id}`);
      await Promise.all([refreshJobs(), reloadDetail()]);
    } catch (error) {
      setError(errorMessage(error, "Could not stop job"));
    } finally {
      setAction(null);
    }
  }

  async function remove() {
    if (!currentJob || !window.confirm(`Delete ${currentJob.id} and its stored job data?`)) return;
    setAction("delete");
    try {
      await api.deleteJob(cluster, currentJob.id);
      setNotice(`Deleted ${currentJob.id}`);
      setSelectedJob(null);
      setSelectedJobDetail(null);
      setLogs("");
      await refreshJobs();
    } catch (error) {
      setError(errorMessage(error, "Could not delete job"));
    } finally {
      setAction(null);
    }
  }

  return (
    <div className="page-stack">
      <div className="page-heading"><div><p className="eyebrow">Durable workloads</p><h2>Jobs</h2><p>Submit and manage jobs through Ray’s structured Jobs API.</p></div></div>
      <div className="jobs-grid">
        <section className="panel composer">
          <div className="panel-heading compact"><div><p className="eyebrow">New workload</p><h2>Submit job</h2></div><Rocket size={19} /></div>
          <label>Entrypoint<input value={draft.entrypoint} onChange={(event) => setDraft({ ...draft, entrypoint: event.target.value })} placeholder="python train.py" /></label>
          <label>Working directory <span className="optional">optional remote archive</span><input value={draft.workingDir} onChange={(event) => setDraft({ ...draft, workingDir: event.target.value })} placeholder="s3://bucket/project.zip" /></label>
          <div className="field-row">
            <label>Entrypoint CPUs<input type="number" min="0" step="0.5" value={draft.cpus} onChange={(event) => setDraft({ ...draft, cpus: event.target.value })} placeholder="auto" /></label>
            <label>Entrypoint GPUs<input type="number" min="0" step="0.25" value={draft.gpus} onChange={(event) => setDraft({ ...draft, gpus: event.target.value })} placeholder="auto" /></label>
          </div>
          <label>Submission ID <span className="optional">optional</span><input value={draft.submissionId} onChange={(event) => setDraft({ ...draft, submissionId: event.target.value })} placeholder="generated by Ray" /></label>
          <details>
            <summary>Advanced JSON</summary>
            <label>Runtime environment<textarea rows={5} value={draft.runtimeEnvJson} onChange={(event) => setDraft({ ...draft, runtimeEnvJson: event.target.value })} spellCheck={false} /></label>
            <label>Metadata<textarea rows={4} value={draft.metadataJson} onChange={(event) => setDraft({ ...draft, metadataJson: event.target.value })} spellCheck={false} /></label>
          </details>
          <button className="wide-button" onClick={() => void submit()} disabled={submitting}>{submitting ? <Spinner /> : <Rocket size={17} />}{submitting ? "Submitting…" : "Submit to Ray"}</button>
        </section>

        <section className="panel jobs-list-panel">
          <div className="panel-heading compact"><div><p className="eyebrow">Cluster history</p><h2>{jobs.length} jobs</h2></div><button className="icon-button subtle" title="Refresh jobs" onClick={() => void refreshJobs()} disabled={jobsLoading}>{jobsLoading ? <Spinner /> : <RefreshCw size={16} />}</button></div>
          <div className="search-box"><Search size={16} /><input aria-label="Search jobs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, command, or status" />{query && <button aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}</div>
          <div className="job-list">
            {filteredJobs.map((job) => <JobListItem key={job.id} job={job} selected={job.id === selectedJobId} onClick={() => setSelectedJob(job.id)} />)}
            {filteredJobs.length === 0 && <EmptyState icon={SquareTerminal} title={query ? "No matching jobs" : "No jobs yet"} detail={query ? "Try a different search." : "Submit your first durable workload."} />}
          </div>
        </section>
      </div>

      <section className="panel job-detail-panel">
        {!currentJob ? <EmptyState icon={FileText} title="Select a job" detail="Job details and logs will appear here." /> : <>
          <div className="job-detail-heading">
            <div><div className="job-id-line"><StatusBadge status={currentJob.status} /><code>{currentJob.id}</code></div><h2>{currentJob.entrypoint || "Ray job"}</h2></div>
            <div className="job-actions">
              <button className="secondary" onClick={() => void reloadDetail()} disabled={detailLoading}>{detailLoading ? <Spinner /> : <RefreshCw size={16} />}Refresh</button>
              <button className="danger" onClick={() => void stop()} disabled={!canStopJob(currentJob) || action !== null}>{action === "stop" ? <Spinner /> : <CircleStop size={16} />}Stop</button>
              <button className="danger ghost-danger" onClick={() => void remove()} disabled={!isTerminalJob(currentJob) || action !== null}>{action === "delete" ? <Spinner /> : <Trash2 size={16} />}Delete</button>
            </div>
          </div>
          {currentJob.message && <div className={cls("job-message", currentJob.status === "FAILED" && "failed")}>{currentJob.message}</div>}
          <div className="job-meta-grid">
            <Meta label="Started" value={formatRayTime(currentJob.start_time)} />
            <Meta label="Finished" value={formatRayTime(currentJob.end_time)} />
            <Meta label="Ray job ID" value={currentJob.job_id || "—"} mono />
            <Meta label="Error type" value={currentJob.error_type || "—"} />
          </div>
          <div className="logs-heading"><div><FileText size={16} /><strong>Job logs</strong></div><span>{logs ? `${logs.split("\n").length} lines` : "No output"}</span></div>
          <pre className="job-logs">{logs || "No log output is available for this job."}</pre>
        </>}
      </section>
    </div>
  );
}

function JobListItem({ job, selected, onClick }: { job: RayJob; selected: boolean; onClick: () => void }) {
  return <button className={cls("job-list-item", selected && "selected")} onClick={onClick}><div><StatusBadge status={job.status} /><span>{formatRayTime(job.start_time)}</span></div><strong>{job.entrypoint || "No entrypoint"}</strong><code>{job.id}</code></button>;
}

function JobTable({ jobs, onSelect }: { jobs: RayJob[]; onSelect: (id: string) => void }) {
  if (!jobs.length) return <EmptyState icon={SquareTerminal} title="No jobs yet" detail="Submitted Ray jobs will appear here." />;
  return <div className="table-wrap"><table><thead><tr><th>Status</th><th>Entrypoint</th><th>Submission ID</th><th>Started</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id} onClick={() => onSelect(job.id)}><td><StatusBadge status={job.status} /></td><td>{job.entrypoint || "—"}</td><td><code>{job.id}</code></td><td>{formatRayTime(job.start_time)}</td></tr>)}</tbody></table></div>;
}

function NodesView() {
  const nodes = useStore((state) => state.nodes);
  const lifecycleStatus = useStore((state) => state.lifecycleStatus);
  const alive = nodes.filter((node) => ["ALIVE", "RUNNING"].includes(node.status)).length;
  return (
    <div className="page-stack nodes-page">
      <div className="page-heading"><div><p className="eyebrow">State API</p><h2>Cluster topology</h2><p>Explore Coordinator and Worker relationships reported by the Ray Dashboard.</p></div><div className="topology-count"><strong>{alive}</strong><span>of {nodes.length} nodes alive</span></div></div>
      <section className="panel topology-panel">
        <div className="panel-heading compact"><div><p className="eyebrow">Interactive graph</p><h2>Node network</h2></div><span className="graph-help">Drag nodes · pan canvas · scroll to zoom</span></div>
        <ClusterGraph nodes={nodes} fallbackCoordinatorAddress={lifecycleStatus?.join_address || "Coordinator"} coordinatorRunning={lifecycleStatus?.state === "running"} />
      </section>
      <section className="panel">
        <div className="panel-heading compact"><div><p className="eyebrow">Inventory</p><h2>Node details</h2></div></div>
        <div className="table-wrap"><table><thead><tr><th>Node</th><th>Role</th><th>Status</th><th>CPU</th><th>GPU</th><th>Memory</th><th>Address</th></tr></thead><tbody>{nodes.map((node) => <tr key={node.id}><td><strong>{node.name}</strong></td><td>{node.is_head ? "Coordinator" : "Worker"}</td><td><StatusBadge status={node.status} /></td><td>{node.cpus.toFixed(1)}</td><td>{node.gpus.toFixed(1)}</td><td>{node.memory_gb.toFixed(1)} GB</td><td><code>{node.address || "—"}</code></td></tr>)}</tbody></table></div>
        {nodes.length === 0 && <EmptyState icon={Boxes} title="No nodes reported" detail="Start or connect to a running Ray cluster to populate the topology." />}
      </section>
    </div>
  );
}

function SettingsView() {
  const clusters = useStore((state) => state.saved_clusters);
  const selectedId = useStore((state) => state.selected_cluster_id);
  const preferences = useStore((state) => state.preferences);
  const updateCluster = useStore((state) => state.updateCluster);
  const removeCluster = useStore((state) => state.removeCluster);
  const addCluster = useStore((state) => state.addCluster);
  const setPreferences = useStore((state) => state.setPreferences);
  const setError = useStore((state) => state.setError);
  return (
    <div className="page-stack">
      <div className="page-heading"><div><p className="eyebrow">Desktop preferences</p><h2>Settings</h2><p>Machine role, resources, connections, and UI preferences are persisted by Tauri.</p></div></div>
      <RoleSettings />
      <LifecycleSettings />
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Connections</p><h2>Saved clusters</h2></div></div>
        <div className="settings-list">{clusters.map((cluster) => <ClusterEditor key={cluster.id} cluster={cluster} selected={cluster.id === selectedId} onSave={updateCluster} onRemove={() => { if (window.confirm(`Remove ${cluster.name} from RayLab?`)) removeCluster(cluster.id); }} />)}</div>
        <div className="add-connection"><h3>Add another API-only connection</h3><ClusterForm compact onSubmit={(input) => { try { addCluster(input); } catch (error) { setError(errorMessage(error, "Invalid cluster")); } }} /></div>
      </section>
      <section className="panel preferences">
        <div className="panel-heading"><div><p className="eyebrow">Refresh behavior</p><h2>Live updates</h2></div></div>
        <label className="toggle-line"><span><strong>Auto-refresh</strong><small>Poll lifecycle, jobs, nodes, and connection health while RayLab is open.</small></span><input type="checkbox" checked={preferences.auto_refresh} onChange={(event) => setPreferences({ ...preferences, auto_refresh: event.target.checked })} /></label>
        <label>Polling interval (seconds)<input type="number" min="2" max="60" value={preferences.poll_interval_ms / 1000} onChange={(event) => setPreferences({ ...preferences, poll_interval_ms: Number(event.target.value) * 1000 })} /></label>
      </section>
    </div>
  );
}

function RoleSettings() {
  const mode = useStore((state) => state.app_mode);
  const lifecycle = useStore((state) => state.lifecycleStatus);
  const [target, setTarget] = useState<Exclude<AppMode, "unconfigured"> | null>(null);
  if (target) {
    return <section className="panel role-settings"><RoleConfiguration mode={target} onBack={() => setTarget(null)} compact /></section>;
  }
  const otherMode = mode === "coordinator" ? "worker" : "coordinator";
  const stopped = lifecycle?.state === "stopped";
  return (
    <section className="panel role-settings">
      <div className="panel-heading"><div><p className="eyebrow">Exclusive machine role</p><h2>{mode === "coordinator" ? "Coordinator" : "Worker"} mode</h2><p>One role is active at a time. Stop Ray before changing it.</p></div><div className={cls("role-badge", mode)}>{mode === "coordinator" ? <Server size={16} /> : <Cpu size={16} />}{mode}</div></div>
      <button className="secondary" disabled={!stopped} onClick={() => setTarget(otherMode)}>{mode === "coordinator" ? <Cpu size={16} /> : <Server size={16} />}Switch to {otherMode}</button>
      {!stopped && <small className="setting-hint">Use {mode === "coordinator" ? "Stop coordinator" : "Leave cluster"} on Overview before switching.</small>}
    </section>
  );
}

function LifecycleSettings() {
  const config = useStore((state) => state.lifecycle);
  const mode = useStore((state) => state.app_mode);
  const status = useStore((state) => state.lifecycleStatus);
  const update = useStore((state) => state.updateLifecycleConfig);
  const [draft, setDraft] = useState(config);
  useEffect(() => setDraft(config), [config]);
  useEffect(() => {
    if (mode !== "coordinator" || !status?.local_node_ip) return;
    setDraft((current) => prefillCoordinatorNodeIp(mode, current, status.local_node_ip));
  }, [mode, status?.local_node_ip]);
  const locked = status?.state !== "stopped";
  return (
    <section className="panel lifecycle-settings">
      <div className="panel-heading"><div><p className="eyebrow">Local node</p><h2>Lifecycle and resource settings</h2><p>These values become validated arguments to Ray’s local node startup adapter.</p></div></div>
      <fieldset disabled={locked}>
        {mode === "worker" && <label>Coordinator host<input value={draft.head_host} onChange={(event) => setDraft({ ...draft, head_host: event.target.value })} placeholder="10.0.0.20" /></label>}
        <label>Node IP <span className="optional">{mode === "coordinator" ? "detected automatically; editable" : "blank = automatic"}</span><input value={draft.node_ip_address} onChange={(event) => setDraft({ ...draft, node_ip_address: event.target.value })} placeholder="Enter this machine’s LAN IPv4" /></label>
        <div className="field-row three"><NumberField label="Shared CPUs" value={draft.cpus} min={0} step={1} onChange={(cpus) => setDraft({ ...draft, cpus })} /><NumberField label="Shared GPUs" value={draft.gpus} min={0} step={1} onChange={(gpus) => setDraft({ ...draft, gpus })} /><NumberField label="Concurrent jobs" value={draft.max_concurrent_jobs} min={1} step={1} onChange={(max_concurrent_jobs) => setDraft({ ...draft, max_concurrent_jobs })} /></div>
        <details><summary>Network ports</summary><div className="field-row three ports"><NumberField label="Ray head" value={draft.ray_port} min={1} step={1} onChange={(ray_port) => setDraft({ ...draft, ray_port })} /><NumberField label="Dashboard" value={draft.dashboard_port} min={1} step={1} onChange={(dashboard_port) => setDraft({ ...draft, dashboard_port })} /><NumberField label="Ray Client" value={draft.client_port} min={1} step={1} onChange={(client_port) => setDraft({ ...draft, client_port })} /></div><p className="setting-hint">Workers also use fixed local ports 8076–8077, 52365–52367, and 20000–20100.</p></details>
        <button onClick={() => void update(draft)}>Save lifecycle settings</button>
      </fieldset>
      {locked && <p className="setting-hint">Stop Ray before changing addresses, ports, or resource offers.</p>}
    </section>
  );
}

function ClusterEditor({ cluster, selected, onSave, onRemove }: { cluster: SavedCluster; selected: boolean; onSave: (cluster: SavedCluster) => void; onRemove: () => void }) {
  const [draft, setDraft] = useState(cluster);
  const [editing, setEditing] = useState(false);
  const setError = useStore((state) => state.setError);
  return <div className={cls("cluster-editor", selected && "selected")}><div className="cluster-editor-title"><div><strong>{cluster.name}</strong>{selected && <span>Selected</span>}{cluster.managed && <span>Role managed</span>}<small>{cluster.dashboard_url}</small></div>{!cluster.managed && <div><button className="text-button" onClick={() => setEditing((value) => !value)}>{editing ? "Cancel" : "Edit"}</button><button className="icon-button subtle danger-icon" aria-label={`Remove ${cluster.name}`} onClick={onRemove}><Trash2 size={15} /></button></div>}</div>{editing && !cluster.managed && <div className="cluster-edit-fields"><input aria-label="Cluster name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /><input aria-label="Dashboard URL" value={draft.dashboard_url} onChange={(event) => setDraft({ ...draft, dashboard_url: event.target.value })} /><button onClick={() => { try { onSave({ ...draft, dashboard_url: normalizeDashboardUrl(draft.dashboard_url) }); setEditing(false); } catch (error) { setError(errorMessage(error, "Invalid dashboard URL")); } }}>Save</button></div>}</div>;
}

function RoleOnboarding() {
  const error = useStore((state) => state.error);
  const [mode, setMode] = useState<Exclude<AppMode, "unconfigured"> | null>(null);
  return <main className="onboarding"><section className="onboarding-copy"><div className="brand"><div className="brand-mark"><Server size={19} /></div><div><strong>RayLab</strong><small>Ray control plane</small></div></div><span className="hero-kicker"><CheckCircle2 size={15} /> One app · two exclusive roles</span><h1>Host the cluster or share this machine.</h1><p>RayLab owns the local Ray lifecycle through a narrow Tauri adapter, while durable jobs, logs, health, and node state remain API-first.</p><ul><li><Server size={17} />Start a coordinator others can join</li><li><Cpu size={17} />Join as a resource-capped worker</li><li><ShieldCheck size={17} />Authenticate every cluster connection</li></ul></section><section className="onboarding-card role-onboarding"><p className="eyebrow">First launch</p>{error && <Banner kind="error" message={error} />}{mode ? <RoleConfiguration mode={mode} onBack={() => setMode(null)} /> : <><h2>Choose this machine’s role</h2><p>You can switch later, but only after stopping the active Ray node.</p><div className="role-choice"><button onClick={() => setMode("coordinator")}><Server size={23} /><span><strong>Host this cluster</strong><small>Start the Ray head node and accept workers.</small></span><ArrowRight size={18} /></button><button onClick={() => setMode("worker")}><Cpu size={23} /><span><strong>Join a cluster</strong><small>Offer this machine’s CPU and GPU resources.</small></span><ArrowRight size={18} /></button></div></>}</section></main>;
}

function RoleConfiguration({ mode, onBack, compact = false }: { mode: Exclude<AppMode, "unconfigured">; onBack: () => void; compact?: boolean }) {
  const existing = useStore((state) => state.lifecycle);
  const configure = useStore((state) => state.configureMode);
  const setError = useStore((state) => state.setError);
  const [draft, setDraft] = useState<LifecycleConfig>(compact ? existing : defaultLifecycleConfig);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [detectingNodeIp, setDetectingNodeIp] = useState(mode === "coordinator" && !draft.node_ip_address);

  useEffect(() => {
    if (mode !== "coordinator" || draft.node_ip_address.trim()) {
      setDetectingNodeIp(false);
      return;
    }
    let active = true;
    setDetectingNodeIp(true);
    void api.detectLocalNodeIp()
      .then((detected) => {
        if (active) setDraft((current) => prefillCoordinatorNodeIp(mode, current, detected));
      })
      .catch((error) => {
        if (active) setError(errorMessage(error, "Could not detect this machine’s LAN IP address"));
      })
      .finally(() => {
        if (active) setDetectingNodeIp(false);
      });
    return () => {
      active = false;
    };
  }, [mode, setError]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await configure(mode, { ...draft, auth_enabled: true }, token);
      onBack();
    } catch {
      // The store exposes the actionable backend error in the global banner.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="role-configuration" onSubmit={(event) => void submit(event)}>
      <div className="role-form-heading"><button type="button" className="text-button" onClick={onBack}>← Back</button><div className={cls("role-badge", mode)}>{mode === "coordinator" ? <Server size={15} /> : <Cpu size={15} />}{mode}</div></div>
      <h2>{mode === "coordinator" ? "Host this cluster" : "Join a coordinator"}</h2>
      <p>{mode === "coordinator" ? "RayLab will generate a shared token and show the address workers need." : "Use the address and token shown by the coordinator’s RayLab app."}</p>
      {mode === "worker" && <><label>Coordinator host<input autoFocus value={draft.head_host} onChange={(event) => setDraft({ ...draft, head_host: event.target.value })} placeholder="10.0.0.20" required /></label><label>Shared cluster token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste token from coordinator" minLength={16} required /></label></>}
      {mode === "coordinator" && <label>Node IP <span className="optional">{detectingNodeIp ? "detecting…" : "detected automatically; editable"}</span><input autoFocus value={draft.node_ip_address} onChange={(event) => setDraft({ ...draft, node_ip_address: event.target.value })} placeholder={detectingNodeIp ? "Detecting…" : "Enter this machine’s LAN IPv4"} /></label>}
      <div className="field-row three"><NumberField label="Shared CPUs" value={draft.cpus} min={0} step={1} onChange={(cpus) => setDraft({ ...draft, cpus })} /><NumberField label="Shared GPUs" value={draft.gpus} min={0} step={1} onChange={(gpus) => setDraft({ ...draft, gpus })} /><NumberField label="Concurrent jobs" value={draft.max_concurrent_jobs} min={1} step={1} onChange={(max_concurrent_jobs) => setDraft({ ...draft, max_concurrent_jobs })} /></div>
      <details><summary>Advanced network settings</summary><div className="field-row three ports"><NumberField label="Ray head" value={draft.ray_port} min={1} step={1} onChange={(ray_port) => setDraft({ ...draft, ray_port })} /><NumberField label="Dashboard" value={draft.dashboard_port} min={1} step={1} onChange={(dashboard_port) => setDraft({ ...draft, dashboard_port })} /><NumberField label="Ray Client" value={draft.client_port} min={1} step={1} onChange={(client_port) => setDraft({ ...draft, client_port })} /></div></details>
      <div className="security-note"><ShieldCheck size={17} /><span><strong>Token authentication is enabled</strong><small>All machines must use Ray 2.57.0 and remain on a trusted private network.</small></span></div>
      <button className="wide-button" type="submit" disabled={busy}>{busy ? <Spinner /> : mode === "coordinator" ? <Network size={17} /> : <Wifi size={17} />}{busy ? "Saving…" : mode === "coordinator" ? "Configure coordinator" : "Configure worker"}</button>
    </form>
  );
}

function NumberField({ label, value, min, step, onChange }: { label: string; value: number; min: number; step: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" min={min} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function ClusterForm({ onSubmit, compact = false }: { onSubmit: (cluster: Omit<SavedCluster, "id">) => void; compact?: boolean }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("http://127.0.0.1:8265");
  return <form className={cls("cluster-form", compact && "compact")} onSubmit={(event) => { event.preventDefault(); if (!name.trim()) return; onSubmit({ name: name.trim(), dashboard_url: url }); if (compact) setName(""); }}><label>Cluster name<input autoFocus={!compact} value={name} onChange={(event) => setName(event.target.value)} placeholder="Research GPU cluster" required /></label><label>Ray Dashboard URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://10.0.0.20:8265" required /></label><button type="submit"><Plus size={17} />{compact ? "Add cluster" : "Connect cluster"}</button></form>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={cls("job-status", status.toLowerCase())}>{status || "UNKNOWN"}</span>;
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="meta"><span>{label}</span>{mono ? <code>{value}</code> : <strong>{value}</strong>}</div>;
}

function EmptyState({ icon: Icon, title, detail }: { icon: typeof Boxes; title: string; detail: string }) {
  return <div className="empty-state"><Icon size={23} /><strong>{title}</strong><span>{detail}</span></div>;
}

function Banner({ kind, message }: { kind: "error" | "success"; message: string }) {
  return <div className={cls("banner", kind)}>{kind === "error" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}<span>{message}</span></div>;
}

function connectionLabel(connection: string) {
  if (connection === "connected") return "Connected";
  if (connection === "connecting") return "Connecting";
  if (connection === "error") return "Unavailable";
  return "Not checked";
}
