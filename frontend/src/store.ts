import { create } from "zustand";
import { api, errorMessage } from "./api";
import { MANAGED_CLUSTER_ID, defaultLifecycleConfig, managedCluster, normalizeLifecycleConfig, validateRoleSetup } from "./roles";
import type {
  AppMode,
  AppView,
  ConnectionState,
  DesktopState,
  LifecycleConfig,
  LifecycleStatus,
  Preferences,
  RayApiVersion,
  RayJob,
  RayNode,
  RecentCoordinator,
  SavedCluster,
} from "./types";

export const defaultDesktopState: DesktopState = {
  active_view: "overview",
  selected_cluster_id: null,
  selected_job_id: null,
  saved_clusters: [],
  preferences: { auto_refresh: true, poll_interval_ms: 5000 },
  app_mode: "unconfigured",
  lifecycle: defaultLifecycleConfig,
  recent_coordinators: [],
};

interface AppStore extends DesktopState {
  hydrated: boolean;
  connection: ConnectionState;
  version: RayApiVersion | null;
  jobs: RayJob[];
  nodes: RayNode[];
  loading: boolean;
  jobsLoading: boolean;
  error: string | null;
  notice: string | null;
  lifecycleStatus: LifecycleStatus | null;
  lifecycleLoading: boolean;
  lifecycleRefreshing: boolean;
  runtimeInstalling: boolean;
  lifecycleProgress: string[];

  hydrate: () => Promise<void>;
  setActiveView: (view: AppView) => void;
  setSelectedJob: (id: string | null) => void;
  selectCluster: (id: string) => void;
  addCluster: (cluster: Omit<SavedCluster, "id">) => void;
  updateCluster: (cluster: SavedCluster) => void;
  removeCluster: (id: string) => void;
  setPreferences: (preferences: Preferences) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
  configureMode: (mode: Exclude<AppMode, "unconfigured">, config: LifecycleConfig, token?: string) => Promise<void>;
  updateLifecycleConfig: (config: LifecycleConfig) => Promise<void>;
  refreshLifecycle: () => Promise<void>;
  installRuntime: () => Promise<void>;
  startLifecycle: () => Promise<void>;
  stopLifecycle: () => Promise<void>;
  refreshCluster: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  rememberCoordinator: (entry: RecentCoordinator) => void;
  pushLifecycleStage: (stage: string) => void;
}

let persistChain = Promise.resolve<unknown>(undefined);

export const useStore = create<AppStore>((set, get) => ({
  ...defaultDesktopState,
  hydrated: false,
  connection: "idle",
  version: null,
  jobs: [],
  nodes: [],
  loading: false,
  jobsLoading: false,
  error: null,
  notice: null,
  lifecycleStatus: null,
  lifecycleLoading: false,
  lifecycleRefreshing: false,
  runtimeInstalling: false,
  lifecycleProgress: [],

  hydrate: async () => {
    try {
      const saved = await api.loadAppState();
      const normalized = normalizeDesktopState(saved);
      set({ ...normalized, hydrated: true });
      if (normalized.app_mode !== "unconfigured") void get().refreshLifecycle();
    } catch (error) {
      set({ hydrated: true, error: errorMessage(error, "Could not load RayLab settings") });
    }
  },

  setActiveView: (active_view) => {
    set({ active_view });
    persist(get);
  },

  setSelectedJob: (selected_job_id) => {
    set({ selected_job_id });
    persist(get);
  },

  selectCluster: (selected_cluster_id) => {
    set({ selected_cluster_id, selected_job_id: null, jobs: [], nodes: [], version: null, connection: "idle", error: null });
    persist(get);
  },

  addCluster: (input) => {
    const cluster: SavedCluster = {
      id: globalThis.crypto.randomUUID(),
      name: input.name.trim(),
      dashboard_url: normalizeDashboardUrl(input.dashboard_url),
      managed: false,
    };
    set((state) => ({
      saved_clusters: [...state.saved_clusters, cluster],
      selected_cluster_id: cluster.id,
      selected_job_id: null,
      active_view: "overview",
      jobs: [],
      nodes: [],
      version: null,
      connection: "idle",
      notice: `${cluster.name} added`,
    }));
    persist(get);
  },

  updateCluster: (cluster) => {
    const normalized = { ...cluster, name: cluster.name.trim(), dashboard_url: normalizeDashboardUrl(cluster.dashboard_url) };
    set((state) => ({ saved_clusters: state.saved_clusters.map((item) => item.id === cluster.id ? normalized : item) }));
    persist(get);
  },

  removeCluster: (id) => {
    if (id === MANAGED_CLUSTER_ID) {
      set({ error: "The active role connection is managed by RayLab. Switch roles instead of removing it." });
      return;
    }
    set((state) => {
      const saved_clusters = state.saved_clusters.filter((cluster) => cluster.id !== id);
      const removedSelected = state.selected_cluster_id === id;
      return {
        saved_clusters,
        selected_cluster_id: removedSelected ? saved_clusters[0]?.id ?? null : state.selected_cluster_id,
        selected_job_id: removedSelected ? null : state.selected_job_id,
        jobs: removedSelected ? [] : state.jobs,
        nodes: removedSelected ? [] : state.nodes,
        version: removedSelected ? null : state.version,
        connection: removedSelected ? "idle" : state.connection,
      };
    });
    persist(get);
  },

  setPreferences: (preferences) => {
    set({ preferences: normalizePreferences(preferences) });
    persist(get);
  },

  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),

  configureMode: async (mode, input, token = "") => {
    const config = normalizeLifecycleConfig(input);
    const previousDesktop = desktopSnapshot(get());
    const previousLifecycleStatus = get().lifecycleStatus;
    const previousConnection = get().connection;
    const previousVersion = get().version;
    const previousJobs = get().jobs;
    const previousNodes = get().nodes;
    try {
      validateRoleSetup(mode, config, token);
      const currentMode = get().app_mode;
      if (currentMode !== "unconfigured" && currentMode !== mode) {
        const current = get().lifecycleStatus ?? await api.lifecycleStatus(get().lifecycle, currentMode);
        if (current.state !== "stopped") throw new Error("Stop the current Ray node before switching roles");
      }
      const preview = await api.lifecycleStatus(config, mode);
      if (config.auth_enabled) {
        if (mode === "coordinator") await api.ensureClusterToken(MANAGED_CLUSTER_ID);
        else await api.saveClusterToken(MANAGED_CLUSTER_ID, token.trim());
      }
      const cluster = managedCluster(mode, config, preview.local_node_ip);
      const saved_clusters = [cluster, ...get().saved_clusters.filter((item) => item.id !== MANAGED_CLUSTER_ID)];
      const recent_coordinators = mode === "worker"
        ? rememberCoordinatorEntry(get().recent_coordinators, {
            host: config.head_host.trim(),
            ray_port: config.ray_port,
            dashboard_port: config.dashboard_port,
          })
        : get().recent_coordinators;
      set({
        app_mode: mode,
        lifecycle: config,
        saved_clusters,
        recent_coordinators,
        selected_cluster_id: cluster.id,
        selected_job_id: null,
        active_view: "overview",
        lifecycleStatus: preview,
        jobs: [],
        nodes: [],
        version: null,
        connection: "idle",
        error: null,
        notice: mode === "coordinator" ? "Coordinator mode configured" : "Worker mode configured",
      });
      await persistStrict(get);
      await get().refreshLifecycle();
    } catch (error) {
      const message = errorMessage(error, "Could not configure this machine's role");
      set({
        ...previousDesktop,
        lifecycleStatus: previousLifecycleStatus,
        connection: previousConnection,
        version: previousVersion,
        jobs: previousJobs,
        nodes: previousNodes,
        notice: null,
        error: message,
      });
      throw new Error(message);
    }
  },

  updateLifecycleConfig: async (input) => {
    const mode = get().app_mode;
    if (mode === "unconfigured") return;
    const status = get().lifecycleStatus;
    if (status && status.state !== "stopped") {
      set({ error: "Stop Ray before changing lifecycle or resource settings" });
      return;
    }
    const config = normalizeLifecycleConfig(input);
    const previousDesktop = desktopSnapshot(get());
    const previousLifecycleStatus = get().lifecycleStatus;
    const previousConnection = get().connection;
    const previousVersion = get().version;
    try {
      validateRoleSetup(mode, config, mode === "worker" && config.auth_enabled ? "configured-token-placeholder" : "");
      const preview = await api.lifecycleStatus(config, mode);
      const cluster = managedCluster(mode, config, preview.local_node_ip);
      set((state) => ({
        lifecycle: config,
        lifecycleStatus: preview,
        saved_clusters: state.saved_clusters.map((item) => item.id === MANAGED_CLUSTER_ID ? cluster : item),
        connection: "idle",
        version: null,
        error: null,
        notice: "Lifecycle settings saved",
      }));
      await persistStrict(get);
    } catch (error) {
      set({
        ...previousDesktop,
        lifecycleStatus: previousLifecycleStatus,
        connection: previousConnection,
        version: previousVersion,
        notice: null,
        error: errorMessage(error, "Could not save lifecycle settings"),
      });
    }
  },

  refreshLifecycle: async () => {
    const mode = get().app_mode;
    if (mode === "unconfigured" || get().lifecycleLoading || get().lifecycleRefreshing || get().runtimeInstalling) return;
    set({ lifecycleRefreshing: true });
    try {
      const lifecycleStatus = await api.lifecycleStatus(get().lifecycle, mode);
      if (get().lifecycleLoading || get().runtimeInstalling) {
        set({ lifecycleRefreshing: false });
        return;
      }
      set({ lifecycleStatus, lifecycleRefreshing: false });
    } catch (error) {
      if (get().lifecycleLoading || get().runtimeInstalling) {
        set({ lifecycleRefreshing: false });
        return;
      }
      set({ lifecycleRefreshing: false, error: errorMessage(error, "Could not inspect the local Ray lifecycle") });
    }
  },

  installRuntime: async () => {
    if (get().runtimeInstalling) return;
    set({ runtimeInstalling: true, error: null });
    try {
      const runtime = await api.installRuntime();
      set((state) => ({
        runtimeInstalling: false,
        lifecycleStatus: state.lifecycleStatus ? { ...state.lifecycleStatus, runtime } : null,
        notice: "Managed Ray runtime installed",
      }));
      await get().refreshLifecycle();
    } catch (error) {
      set({ runtimeInstalling: false, error: errorMessage(error, "Could not install the managed Ray runtime") });
    }
  },

  startLifecycle: async () => {
    const mode = get().app_mode;
    if (mode === "unconfigured" || get().lifecycleLoading) return;
    set({ lifecycleLoading: true, error: null, lifecycleProgress: [] });
    try {
      const lifecycleStatus = await api.startLifecycle(get().lifecycle, mode);
      set({ lifecycleStatus, lifecycleLoading: false, lifecycleProgress: [], notice: mode === "coordinator" ? "Coordinator started" : "Worker joined the cluster" });
      await get().refreshCluster();
    } catch (error) {
      set({ lifecycleLoading: false, lifecycleProgress: [], error: errorMessage(error, "Could not start Ray") });
      await get().refreshLifecycle();
    }
  },

  stopLifecycle: async () => {
    const mode = get().app_mode;
    if (mode === "unconfigured" || get().lifecycleLoading) return;
    set({ lifecycleLoading: true, error: null });
    try {
      const lifecycleStatus = await api.stopLifecycle(get().lifecycle, mode);
      set({
        lifecycleStatus,
        lifecycleLoading: false,
        connection: "idle",
        version: null,
        jobs: [],
        nodes: [],
        notice: mode === "coordinator" ? "Coordinator stopped" : "Worker left the cluster",
      });
    } catch (error) {
      set({ lifecycleLoading: false, error: errorMessage(error, "Could not stop Ray") });
      await get().refreshLifecycle();
    }
  },

  refreshCluster: async () => {
    if (get().loading) return;
    const cluster = selectedCluster(get());
    if (!cluster) return;
    if (cluster.managed && get().lifecycleStatus?.state !== "running") {
      set({ connection: "idle", version: null, jobs: [], nodes: [], loading: false });
      return;
    }
    set({ loading: true, connection: "connecting", error: null });
    const previousNodes = get().nodes;
    const [versionResult, jobsResult, nodesResult] = await Promise.allSettled([
      api.version(cluster),
      api.listJobs(cluster),
      api.listNodes(cluster),
    ]);

    if (versionResult.status === "rejected") {
      set({
        loading: false,
        connection: "error",
        error: errorMessage(versionResult.reason, `Cannot connect to ${cluster.name}`),
      });
      return;
    }

    const nextNodes = nodesResult.status === "fulfilled" ? nodesResult.value : get().nodes;
    const activity = nodeActivityNotice(previousNodes, nextNodes);
    set((state) => ({
      loading: false,
      connection: "connected",
      version: versionResult.value,
      jobs: jobsResult.status === "fulfilled" ? sortJobs(jobsResult.value) : state.jobs,
      nodes: nodesResult.status === "fulfilled" ? nodesResult.value : state.nodes,
      error: jobsResult.status === "rejected"
        ? errorMessage(jobsResult.reason, "Connected, but jobs could not be loaded")
        : null,
      ...(activity ? { notice: activity } : {}),
    }));
  },

  refreshJobs: async () => {
    if (get().jobsLoading) return;
    const cluster = selectedCluster(get());
    if (!cluster) return;
    set({ jobsLoading: true });
    try {
      const jobs = await api.listJobs(cluster);
      set({ jobs: sortJobs(jobs), jobsLoading: false });
    } catch (error) {
      set({ jobsLoading: false, error: errorMessage(error, "Could not load Ray jobs") });
    }
  },

  rememberCoordinator: (entry) => {
    set((state) => ({ recent_coordinators: rememberCoordinatorEntry(state.recent_coordinators, entry) }));
    persist(get);
  },

  pushLifecycleStage: (stage) => {
    set((state) => (
      state.lifecycleProgress[state.lifecycleProgress.length - 1] === stage
        ? state
        : { lifecycleProgress: [...state.lifecycleProgress, stage] }
    ));
  },
}));

export function normalizeDashboardUrl(raw: string) {
  const value = raw.trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const parsed = new URL(withProtocol);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Dashboard URL must use http:// or https://");
  if (parsed.username || parsed.password) throw new Error("Store credentials separately; do not include them in the Dashboard URL");
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function normalizePreferences(value: Partial<Preferences> | undefined): Preferences {
  const interval = Number(value?.poll_interval_ms);
  return {
    auto_refresh: value?.auto_refresh !== false,
    poll_interval_ms: Number.isFinite(interval) ? Math.min(60000, Math.max(2000, Math.round(interval))) : 5000,
  };
}

export function normalizeDesktopState(value: Partial<DesktopState> | null | undefined): DesktopState {
  const saved_clusters = Array.isArray(value?.saved_clusters)
    ? value.saved_clusters.map((cluster) => ({ ...cluster, managed: cluster.id === MANAGED_CLUSTER_ID || cluster.managed === true }))
    : [];
  const selected = saved_clusters.some((cluster) => cluster.id === value?.selected_cluster_id)
    ? value?.selected_cluster_id ?? null
    : saved_clusters[0]?.id ?? null;
  const validViews: AppView[] = ["overview", "jobs", "nodes", "settings"];
  const validModes: AppMode[] = ["unconfigured", "coordinator", "worker"];
  return {
    ...defaultDesktopState,
    ...value,
    active_view: validViews.includes(value?.active_view as AppView) ? value?.active_view as AppView : "overview",
    saved_clusters,
    selected_cluster_id: selected,
    preferences: normalizePreferences(value?.preferences),
    app_mode: validModes.includes(value?.app_mode as AppMode) ? value?.app_mode as AppMode : "unconfigured",
    lifecycle: normalizeLifecycleConfig(value?.lifecycle),
    recent_coordinators: normalizeRecentCoordinators(value?.recent_coordinators),
  };
}

function selectedCluster(state: Pick<AppStore, "saved_clusters" | "selected_cluster_id">) {
  return state.saved_clusters.find((cluster) => cluster.id === state.selected_cluster_id) ?? null;
}

function desktopSnapshot(state: AppStore): DesktopState {
  return {
    active_view: state.active_view,
    selected_cluster_id: state.selected_cluster_id,
    selected_job_id: state.selected_job_id,
    saved_clusters: state.saved_clusters,
    preferences: state.preferences,
    app_mode: state.app_mode,
    lifecycle: state.lifecycle,
    recent_coordinators: state.recent_coordinators,
  };
}

function persist(get: () => AppStore) {
  const snapshot = desktopSnapshot(get());
  void enqueuePersist(snapshot);
}

function persistStrict(get: () => AppStore) {
  return enqueuePersist(desktopSnapshot(get()));
}

function enqueuePersist(snapshot: DesktopState) {
  const operation = persistChain
    .catch(() => undefined)
    .then(() => api.saveAppState(snapshot));
  persistChain = operation.catch((error) => {
    useStore.setState({ error: errorMessage(error, "Could not save RayLab settings") });
  });
  return operation;
}

function sortJobs(jobs: RayJob[]) {
  return [...jobs].sort((left, right) => (right.start_time ?? 0) - (left.start_time ?? 0));
}

export function nodeActivityNotice(previous: RayNode[], next: RayNode[]): string | null {
  if (previous.length === 0) return null;
  const previousIds = new Set(previous.map((node) => node.id));
  const nextIds = new Set(next.map((node) => node.id));
  const label = (node: RayNode) => node.name || node.address || node.id;
  const joined = next.filter((node) => !previousIds.has(node.id)).map(label);
  const left = previous.filter((node) => !nextIds.has(node.id)).map(label);
  const parts = [
    joined.length ? `${joined.slice(0, 3).join(", ")}${joined.length > 3 ? ` +${joined.length - 3}` : ""} joined` : "",
    left.length ? `${left.slice(0, 3).join(", ")}${left.length > 3 ? ` +${left.length - 3}` : ""} left the cluster` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function rememberCoordinatorEntry(existing: RecentCoordinator[], entry: RecentCoordinator): RecentCoordinator[] {
  const deduped = existing.filter(
    (item) => !(item.host === entry.host && item.ray_port === entry.ray_port && item.dashboard_port === entry.dashboard_port),
  );
  return [entry, ...deduped].slice(0, 5);
}

export function normalizeRecentCoordinators(value: unknown): RecentCoordinator[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: RecentCoordinator[] = [];
  for (const item of value) {
    const candidate = item as Partial<RecentCoordinator> | null;
    const host = typeof candidate?.host === "string" ? candidate.host.trim() : "";
    const rayPort = Number(candidate?.ray_port);
    const dashboardPort = Number(candidate?.dashboard_port);
    if (!host || host.includes("/") || host.includes(":") || /\s/.test(host)) continue;
    if (!Number.isInteger(rayPort) || rayPort <= 0 || rayPort > 65535) continue;
    if (!Number.isInteger(dashboardPort) || dashboardPort <= 0 || dashboardPort > 65535) continue;
    const key = `${host}|${rayPort}|${dashboardPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ host, ray_port: rayPort, dashboard_port: dashboardPort });
    if (result.length >= 5) break;
  }
  return result;
}
