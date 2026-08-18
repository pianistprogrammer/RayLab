import type { JobSubmission, RayJob } from "./types";

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "STOPPED", "FAILED"]);
const ACTIVE_STATUSES = new Set(["PENDING", "RUNNING"]);

export interface JobDraft {
  entrypoint: string;
  workingDir: string;
  runtimeEnvJson: string;
  metadataJson: string;
  submissionId: string;
  cpus: string;
  gpus: string;
}

export const defaultJobDraft: JobDraft = {
  entrypoint: "python train.py",
  workingDir: "",
  runtimeEnvJson: "{}",
  metadataJson: "{}",
  submissionId: "",
  cpus: "",
  gpus: "",
};

export function isTerminalJob(job: Pick<RayJob, "status"> | string) {
  const status = typeof job === "string" ? job : job.status;
  return TERMINAL_STATUSES.has(status.toUpperCase());
}

export function canStopJob(job: Pick<RayJob, "status">) {
  return ACTIVE_STATUSES.has(job.status.toUpperCase());
}

export function buildJobSubmission(draft: JobDraft): JobSubmission {
  const entrypoint = draft.entrypoint.trim();
  if (!entrypoint) throw new Error("Entrypoint is required");

  const runtime_env = parseObjectJson(draft.runtimeEnvJson, "Runtime environment");
  if (draft.workingDir.trim()) runtime_env.working_dir = draft.workingDir.trim();

  const rawMetadata = parseObjectJson(draft.metadataJson, "Metadata");
  const metadata = Object.fromEntries(
    Object.entries(rawMetadata).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
  );

  const job: JobSubmission = { entrypoint, runtime_env, metadata };
  if (draft.submissionId.trim()) job.submission_id = draft.submissionId.trim();
  const cpus = optionalNonNegativeNumber(draft.cpus, "CPU reservation");
  const gpus = optionalNonNegativeNumber(draft.gpus, "GPU reservation");
  if (cpus !== undefined) job.entrypoint_num_cpus = cpus;
  if (gpus !== undefined) job.entrypoint_num_gpus = gpus;
  return job;
}

export function parseObjectJson(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return { ...(parsed as Record<string, unknown>) };
}

export function formatRayTime(value: number | null) {
  if (!value) return "—";
  const millis = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function optionalNonNegativeNumber(raw: string, label: string) {
  if (!raw.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be zero or greater`);
  return value;
}
