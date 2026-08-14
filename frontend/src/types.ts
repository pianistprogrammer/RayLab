export type AppMode = "unconfigured" | "coordinator" | "node";
export type ClusterState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ScheduleWindow {
  days: number[];
  start: string;
  end: string;
}

export interface NodePolicy {
  master_enabled: boolean;
  manual_override: "auto" | "force_on" | "force_off" | "panic";
  schedule_enabled: boolean;
  schedule_windows: ScheduleWindow[];
  idle_only_enabled: boolean;
  idle_minutes: number;
  max_cpu_percent_for_idle: number;
  max_gpu_percent_for_idle: number;
}

export interface ResourceCaps {
  cpus: number;
  gpus: number;
  memory_gb: number;
  gpu_memory_gb: number;
  max_concurrent_jobs: number;
}

export interface CoordinatorConfig {
  head_host: string;
  dashboard_host: string;
  node_ip_address: string;
  ray_port: number;
  dashboard_port: number;
  client_port: number;
  node_manager_port: number;
  object_manager_port: number;
  preflight_port: number;
  cluster_token_ref: string;
  dashboard_token_ref: string;
  bind_private_only: boolean;
  allow_external_workers: boolean;
}

export interface PrivacyConfig {
  worker_account: string;
  worker_account_required: boolean;
  allow_home_access: boolean;
  require_runtime_working_dir: boolean;
  container_runtime: "docker";
  require_gpu_container_runtime: boolean;
}

export interface ObjectStoreConfig {
  endpoint_url: string;
  bucket: string;
  region: string;
  access_key_ref: string;
  secret_key_ref: string;
}

export interface Submitter {
  id: string;
  name: string;
  token_ref: string;
  revoked: boolean;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  event_type: string;
  actor: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AppConfig {
  app_mode: AppMode;
  coordinator: CoordinatorConfig;
  node_policy: NodePolicy;
  resource_caps: ResourceCaps;
  privacy: PrivacyConfig;
  object_store: ObjectStoreConfig;
  submitters: Submitter[];
  audit: AuditEvent[];
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface NetworkPreflightCheck {
  id: string;
  label: string;
  protocol: "tcp";
  transport?: "h2c" | "tcp";
  direction: "coordinator_to_worker";
  port: number;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string | null;
}

export interface NetworkPreflightResult {
  ok: boolean;
  status: "pass" | "warn" | "fail";
  summary: string;
  endpoint?: string;
  checks: NetworkPreflightCheck[];
}

export interface ClusterStatus {
  state: ClusterState;
  mode: AppMode;
  address?: string;
  dashboard_url?: string;
  message: string;
  diagnostics: DiagnosticCheck[];
}

export interface PortConflictOwner {
  pid: number;
  command: string;
}

export interface PortConflict {
  name: string;
  host: string;
  port: number;
  owners: PortConflictOwner[];
}

export interface NodeInfo {
  node_id: string;
  hostname: string;
  status: string;
  owner: string;
  cpus_total: number;
  gpus_total: number;
  memory_total_gb: number;
  cpu_percent: number;
  gpu_percent: number;
  ram_percent: number;
  last_seen: string;
}

export interface JobSubmission {
  submitter_id: string;
  entrypoint: string;
  working_dir: string;
  runtime_env: Record<string, unknown>;
  container_image?: string;
  metadata: Record<string, string>;
}

export interface InstallStatus {
  running: boolean;
  succeeded: boolean | null;
  message: string;
  command: string[];
  started_at?: string | null;
  finished_at?: string | null;
  log_tail: string[];
}

export interface SetupTask {
  id: string;
  label: string;
  status: "pending" | "running" | "pass" | "warn" | "fail" | "skipped";
  detail: string;
  fix?: string | null;
}

export interface SetupRunStatus {
  running: boolean;
  succeeded: boolean | null;
  can_continue: boolean;
  progress: number;
  message: string;
  started_at?: string | null;
  finished_at?: string | null;
  tasks: SetupTask[];
}

export interface HardwareInfo {
  cpu_logical: number;
  cpu_physical?: number | null;
  memory_total_gb?: number | null;
  gpu_count: number;
  gpu_names: string[];
  gpu_type: string;
  gpu_memory_total_gb?: number | null;
  gpu_memory_shared: boolean;
  source: string;
}

export interface TerminalLogEntry {
  timestamp: string;
  stream: string;
  message: string;
}

export interface DiscoveryCandidate {
  host: string;
  ray_port: number;
  dashboard_port?: number | null;
  dashboard_url?: string | null;
  confidence: number;
  detail: string;
}
