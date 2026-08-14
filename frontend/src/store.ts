import { create } from "zustand";
import { api } from "./api";
import type { AppConfig, AppMode, AuditEvent, ClusterStatus, HardwareInfo, InstallStatus, NodeInfo, SetupRunStatus, TerminalLogEntry } from "./types";

const CONFIG_CACHE_KEY = "raylab:last-config";

export const fallbackConfig: AppConfig = {
  app_mode: "unconfigured",
  coordinator: {
    head_host: "127.0.0.1",
    dashboard_host: "127.0.0.1",
    node_ip_address: "",
    ray_port: 6379,
    dashboard_port: 8265,
    client_port: 10001,
    node_manager_port: 18076,
    object_manager_port: 18077,
    cluster_token_ref: "raylab.cluster_token",
    dashboard_token_ref: "raylab.dashboard_token",
    bind_private_only: true,
    allow_external_workers: false,
  },
  node_policy: {
    master_enabled: false,
    manual_override: "auto",
    schedule_enabled: false,
    schedule_windows: [],
    idle_only_enabled: false,
    idle_minutes: 10,
    max_cpu_percent_for_idle: 20,
    max_gpu_percent_for_idle: 10,
  },
  resource_caps: { cpus: 4, gpus: 1, memory_gb: 16, gpu_memory_gb: 12, max_concurrent_jobs: 1 },
  privacy: {
    worker_account: "raylab-worker",
    worker_account_required: true,
    allow_home_access: false,
    require_runtime_working_dir: true,
    container_runtime: "docker",
    require_gpu_container_runtime: true,
  },
  object_store: { endpoint_url: "", bucket: "", region: "", access_key_ref: "raylab.object_store_access_key", secret_key_ref: "raylab.object_store_secret_key" },
  submitters: [],
  audit: [],
};

export function loadCachedConfig(): AppConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_CACHE_KEY);
    if (!raw) return fallbackConfig;
    return { ...fallbackConfig, ...JSON.parse(raw) } as AppConfig;
  } catch {
    return fallbackConfig;
  }
}

export function cacheConfig(config: AppConfig) {
  try {
    window.localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(config));
  } catch {
    // The local backend remains the source of truth; this cache only avoids reload flicker.
  }
}

interface AppState {
  config: AppConfig;
  status: ClusterStatus | null;
  nodes: NodeInfo[];
  audit: AuditEvent[];
  rayInstall: InstallStatus | null;
  setupRun: SetupRunStatus | null;
  hardware: HardwareInfo | null;
  terminalLogs: TerminalLogEntry[];
  backendReady: boolean;
  // Which named action is in flight — null when idle.
  activeAction: string | null;
  modeSaving: boolean;
  error: string | null;
  notice: string | null;

  setConfig: (config: AppConfig) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
  setActiveAction: (activeAction: string | null) => void;
  refresh: () => Promise<void>;
  persistMode: (mode: AppMode) => void;
  saveConfig: (next?: AppConfig, actionKey?: string) => Promise<void>;
  runAction: (task: () => Promise<unknown>, success: string, actionKey: string) => Promise<void>;
}

// Only surface a fetch error after this many consecutive poll failures.
// Transient blips (backend briefly busy, app waking from sleep) are swallowed.
const CONSECUTIVE_FAIL_THRESHOLD = 3;
let consecutiveFailCount = 0;

// Held in the store closure — not in state so it never triggers re-renders.
let pendingMode: AppMode | null = null;

async function electronBackendStatus(): Promise<{ running: boolean; error?: string | null } | null> {
  try {
    return await window.electronAPI.invoke("backend_status") as { running: boolean; error?: string | null };
  } catch {
    return null;
  }
}

export const useStore = create<AppState>((set, get) => ({
  config: loadCachedConfig(),
  status: null,
  nodes: [],
  audit: [],
  rayInstall: null,
  setupRun: null,
  hardware: null,
  terminalLogs: [],
  backendReady: false,
  activeAction: null,
  modeSaving: false,
  error: null,
  notice: null,

  setConfig: (config) => set({ config }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  setActiveAction: (activeAction) => set({ activeAction }),

  refresh: async () => {
    let backendStartupError: string | null = null;
    try {
      const backendStatus = await electronBackendStatus();
      backendStartupError = backendStatus?.error ?? null;
      const [nextConfig, nextStatus] = await Promise.all([api.getConfig(), api.status()]);
      const [nodesResult, auditResult, installResult, setupResult, hardwareResult, terminalResult] = await Promise.allSettled([
        api.nodes(),
        api.audit(),
        api.rayInstallStatus(),
        api.setupStatus(),
        api.hardware(),
        api.terminalLogs(),
      ]);
      const current = get();
      const nextNodes = nodesResult.status === "fulfilled" ? nodesResult.value : current.nodes;
      const nextAudit = auditResult.status === "fulfilled" ? auditResult.value : current.audit;
      const nextInstall = installResult.status === "fulfilled" ? installResult.value : current.rayInstall;
      const nextSetup = setupResult.status === "fulfilled" ? setupResult.value : current.setupRun;
      const nextHardware = hardwareResult.status === "fulfilled" ? hardwareResult.value : current.hardware;
      const nextTerminalLogs = terminalResult.status === "fulfilled" ? terminalResult.value : current.terminalLogs;

      consecutiveFailCount = 0;

      // If the server has caught up to a pending mode switch, clear the lock.
      if (pendingMode && nextConfig.app_mode === pendingMode) {
        pendingMode = null;
      }
      // While a mode switch is in flight, keep showing the optimistic value.
      const effectiveConfig = pendingMode
        ? { ...nextConfig, app_mode: pendingMode }
        : nextConfig;
      cacheConfig(effectiveConfig);

      // Only update config if it actually changed — avoids triggering
      // draft resets in editing components when the poll returns identical data.
      const prevConfig = current.config;
      const configChanged = JSON.stringify(effectiveConfig) !== JSON.stringify(prevConfig);

      set({
        ...(configChanged ? { config: effectiveConfig } : {}),
        status: nextStatus,
        nodes: nextNodes,
        audit: nextAudit,
        rayInstall: nextInstall,
        setupRun: nextSetup,
        hardware: nextHardware,
        terminalLogs: nextTerminalLogs,
        backendReady: true,
        error: null,
      });
    } catch (err) {
      consecutiveFailCount += 1;
      set({ backendReady: false });
      if (consecutiveFailCount >= CONSECUTIVE_FAIL_THRESHOLD) {
        set({ error: backendStartupError ?? (err instanceof Error ? err.message : "App is not reachable") });
      }
    }
  },

  persistMode: (mode) => {
    const current = get().config;
    const next = { ...current, app_mode: mode };
    // Set optimistic state immediately — UI reflects the choice at once.
    pendingMode = mode;
    set({ config: next, modeSaving: true, error: null });
    cacheConfig(next);

    void api.saveConfig(next)
      .then((saved) => {
        // Only apply if this is still the active switch (user hasn't switched again).
        if (pendingMode !== mode) return;
        pendingMode = null;
        const effective = { ...saved, app_mode: mode };
        cacheConfig(effective);
        set({ config: effective, modeSaving: false });
      })
      .catch((err) => {
        if (pendingMode !== mode) return;
        pendingMode = null;
        set({
          modeSaving: false,
          error: err instanceof Error ? err.message : "Mode save failed",
        });
        void get().refresh();
      });
  },

  saveConfig: async (next, actionKey = "save") => {
    const config = next ?? get().config;
    set({ activeAction: actionKey, error: null, config });
    try {
      const saved = await api.saveConfig(config);
      cacheConfig(saved);
      set({ config: saved, activeAction: null, notice: "Settings saved" });
    } catch (err) {
      set({ activeAction: null, error: err instanceof Error ? err.message : "Save failed" });
    }
  },

  runAction: async (task, success, actionKey) => {
    set({ activeAction: actionKey, error: null });
    try {
      await task();
      set({ notice: success });
      await get().refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Action failed" });
    } finally {
      set({ activeAction: null });
    }
  },
}));
