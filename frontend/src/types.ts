export type AppView = "overview" | "jobs" | "nodes" | "settings";
export type ConnectionState = "idle" | "connecting" | "connected" | "error";

export interface SavedCluster {
  id: string;
  name: string;
  dashboard_url: string;
}

export interface Preferences {
  auto_refresh: boolean;
  poll_interval_ms: number;
}

export interface DesktopState {
  active_view: AppView;
  selected_cluster_id: string | null;
  selected_job_id: string | null;
  saved_clusters: SavedCluster[];
  preferences: Preferences;
}

export interface RayApiVersion {
  version: string;
  ray_version: string;
  ray_commit: string;
}

export interface RayJob {
  id: string;
  submission_id: string;
  job_id: string;
  job_type: string;
  entrypoint: string;
  status: string;
  message: string;
  error_type: string | null;
  start_time: number | null;
  end_time: number | null;
  metadata: Record<string, unknown>;
  runtime_env: Record<string, unknown>;
  driver_info: Record<string, unknown> | null;
}

export interface JobSubmission {
  entrypoint: string;
  runtime_env: Record<string, unknown>;
  metadata: Record<string, string>;
  submission_id?: string;
  entrypoint_num_cpus?: number;
  entrypoint_num_gpus?: number;
}

export interface SubmitJobResult {
  job_id: string;
  submission_id: string;
}

export interface JobAction {
  id: string;
  status: string;
  accepted: boolean;
}

export interface RayNode {
  id: string;
  name: string;
  address: string;
  status: string;
  is_head: boolean;
  cpus: number;
  gpus: number;
  memory_gb: number;
}
