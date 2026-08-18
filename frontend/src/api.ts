import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  DesktopState,
  JobAction,
  JobSubmission,
  RayApiVersion,
  RayJob,
  RayNode,
  SavedCluster,
  SubmitJobResult,
} from "./types";

function clusterInput(cluster: SavedCluster) {
  return { dashboard_url: cluster.dashboard_url };
}

export const api = {
  loadAppState: () => invoke<DesktopState>("load_app_state"),
  saveAppState: (state: DesktopState) => invoke<DesktopState>("save_app_state", { state }),
  version: (cluster: SavedCluster) => invoke<RayApiVersion>("ray_api_version", { cluster: clusterInput(cluster) }),
  listJobs: (cluster: SavedCluster) => invoke<RayJob[]>("list_jobs", { cluster: clusterInput(cluster) }),
  getJob: (cluster: SavedCluster, id: string) => invoke<RayJob>("get_job", { cluster: clusterInput(cluster), id }),
  getJobLogs: (cluster: SavedCluster, id: string) => invoke<string>("get_job_logs", { cluster: clusterInput(cluster), id }),
  submitJob: (cluster: SavedCluster, job: JobSubmission) => invoke<SubmitJobResult>("submit_job", { cluster: clusterInput(cluster), job }),
  stopJob: (cluster: SavedCluster, id: string) => invoke<JobAction>("stop_job", { cluster: clusterInput(cluster), id }),
  deleteJob: (cluster: SavedCluster, id: string) => invoke<JobAction>("delete_job", { cluster: clusterInput(cluster), id }),
  listNodes: (cluster: SavedCluster) => invoke<RayNode[]>("list_nodes", { cluster: clusterInput(cluster) }),
  openDashboard: (cluster: SavedCluster) => openUrl(cluster.dashboard_url),
};

export function errorMessage(error: unknown, fallback = "Something went wrong") {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
