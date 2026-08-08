import type { AppConfig, AuditEvent, ClusterStatus, DiagnosticCheck, DiscoveryCandidate, HardwareInfo, InstallStatus, JobSubmission, NodeInfo, SetupRunStatus, TerminalLogEntry } from "./types";

const BASE_URL = "http://127.0.0.1:8765";
const FETCH_TIMEOUT_MS = 4000;   // per-request timeout
const SIDECAR_RETRY_COUNT = 2;   // retries for transient failures
const SIDECAR_RETRY_DELAY_MS = 300;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body
    ? { "Content-Type": "application/json", ...(init?.headers ?? {}) }
    : init?.headers;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= SIDECAR_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const body = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(body.detail ?? response.statusText);
      }
      return response.json() as Promise<T>;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (attempt < SIDECAR_RETRY_COUNT) await sleep(SIDECAR_RETRY_DELAY_MS);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : "Sidecar is not reachable");
}

export const api = {
  health: () => request<{ ok: boolean; version: string; ray_available: boolean; ray_version?: string }>("/health"),
  getConfig: () => request<AppConfig>("/config"),
  saveConfig: (config: AppConfig) => request<AppConfig>("/config", { method: "PUT", body: JSON.stringify(config) }),
  status: () => request<ClusterStatus>("/cluster/status"),
  diagnostics: () => request<DiagnosticCheck[]>("/diagnostics"),
  hardware: () => request<HardwareInfo>("/hardware"),
  terminalLogs: () => request<TerminalLogEntry[]>("/terminal/logs"),
  discoverCoordinators: () => request<DiscoveryCandidate[]>("/discovery/coordinators"),
  rayInstallStatus: () => request<InstallStatus>("/setup/ray-install"),
  installRay: () => request<InstallStatus>("/setup/ray-install", { method: "POST" }),
  setupStatus: () => request<SetupRunStatus>("/setup/run"),
  runSetup: () => request<SetupRunStatus>("/setup/run", { method: "POST" }),
  start: () => request<ClusterStatus>("/cluster/start", { method: "POST" }),
  stop: () => request<ClusterStatus>("/cluster/stop", { method: "POST" }),
  panic: () => request<ClusterStatus>("/cluster/panic", { method: "POST" }),
  nodes: () => request<NodeInfo[]>("/nodes"),
  audit: () => request<AuditEvent[]>("/audit"),
  createSubmitter: (name: string) => request<{ id: string; name: string; token: string }>("/submitters", { method: "POST", body: JSON.stringify({ name }) }),
  revokeSubmitter: (id: string) => request<AppConfig>(`/submitters/${id}/revoke`, { method: "POST" }),
  submitJob: (job: JobSubmission) => request<{ job_id: string; status: string; message: string }>("/jobs", { method: "POST", body: JSON.stringify(job) }),
  killJob: (id: string) => request<{ job_id: string; status: string; message: string }>(`/jobs/${id}/kill`, { method: "POST" }),
};
