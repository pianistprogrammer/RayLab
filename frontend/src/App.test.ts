import { describe, expect, it } from "vitest";
import { buildJobSubmission, formatRayTime, isTerminalJob, parseObjectJson } from "./jobs";
import { defaultLifecycleConfig, managedCluster, normalizeLifecycleConfig, validateRoleSetup } from "./roles";
import { normalizeDashboardUrl, normalizeDesktopState, normalizePreferences } from "./store";

describe("Ray Jobs submission", () => {
  it("builds a structured payload without invoking a CLI", () => {
    const payload = buildJobSubmission({
      entrypoint: " python train.py ",
      workingDir: "s3://research/project.zip",
      runtimeEnvJson: '{"pip":["torch"]}',
      metadataJson: '{"team":"vision","attempt":2}',
      submissionId: "training-42",
      cpus: "2",
      gpus: "1",
    });

    expect(payload).toEqual({
      entrypoint: "python train.py",
      runtime_env: { pip: ["torch"], working_dir: "s3://research/project.zip" },
      metadata: { team: "vision", attempt: "2" },
      submission_id: "training-42",
      entrypoint_num_cpus: 2,
      entrypoint_num_gpus: 1,
    });
  });

  it("rejects arrays where Ray expects an object", () => {
    expect(() => parseObjectJson("[]", "Runtime environment")).toThrow("JSON object");
  });

  it("recognizes every Ray terminal job state", () => {
    expect(isTerminalJob("SUCCEEDED")).toBe(true);
    expect(isTerminalJob("FAILED")).toBe(true);
    expect(isTerminalJob("STOPPED")).toBe(true);
    expect(isTerminalJob("RUNNING")).toBe(false);
  });

  it("formats millisecond timestamps from the Jobs API", () => {
    expect(formatRayTime(0)).toBe("—");
    expect(formatRayTime(1_700_000_000_000)).not.toBe("—");
  });
});

describe("desktop state", () => {
  it("normalizes dashboard endpoints to their origin", () => {
    expect(normalizeDashboardUrl("10.0.0.20:8265/api/jobs")).toBe("http://10.0.0.20:8265");
  });

  it("rejects credentials embedded in endpoint URLs", () => {
    expect(() => normalizeDashboardUrl("https://token@example.test:8265")).toThrow("credentials separately");
  });

  it("repairs a stale selected cluster during migration", () => {
    const state = normalizeDesktopState({
      active_view: "jobs",
      selected_cluster_id: "missing",
      selected_job_id: null,
      saved_clusters: [{ id: "cluster-a", name: "A", dashboard_url: "http://localhost:8265" }],
      preferences: { auto_refresh: true, poll_interval_ms: 100 },
    });
    expect(state.selected_cluster_id).toBe("cluster-a");
    expect(state.preferences.poll_interval_ms).toBe(2000);
  });

  it("bounds unsafe polling intervals", () => {
    expect(normalizePreferences({ auto_refresh: true, poll_interval_ms: 100 }).poll_interval_ms).toBe(2000);
    expect(normalizePreferences({ auto_refresh: true, poll_interval_ms: 100_000 }).poll_interval_ms).toBe(60_000);
  });

  it("migrates API-only state into an explicit unconfigured role", () => {
    const state = normalizeDesktopState({
      active_view: "overview",
      selected_cluster_id: null,
      selected_job_id: null,
      saved_clusters: [],
      preferences: { auto_refresh: true, poll_interval_ms: 5000 },
    });
    expect(state.app_mode).toBe("unconfigured");
    expect(state.lifecycle).toEqual(defaultLifecycleConfig);
  });
});

describe("exclusive coordinator and worker setup", () => {
  it("creates the coordinator's managed Dashboard connection from the detected node IP", () => {
    expect(managedCluster("coordinator", defaultLifecycleConfig, "10.0.0.20")).toEqual({
      id: "raylab-managed-cluster",
      name: "My RayLab cluster",
      dashboard_url: "http://10.0.0.20:8265",
      managed: true,
    });
  });

  it("creates a worker connection to the chosen coordinator", () => {
    const config = normalizeLifecycleConfig({ ...defaultLifecycleConfig, head_host: "10.0.0.20" });
    expect(managedCluster("worker", config, "10.0.0.21").dashboard_url).toBe("http://10.0.0.20:8265");
  });

  it("requires a protected worker join token", () => {
    const config = { ...defaultLifecycleConfig, head_host: "10.0.0.20" };
    expect(() => validateRoleSetup("worker", config, "short")).toThrow("shared token");
    expect(() => validateRoleSetup("worker", config, "0123456789abcdef")).not.toThrow();
  });
});
