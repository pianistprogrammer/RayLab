import type { AppMode, LifecycleConfig, SavedCluster } from "./types";

export const MANAGED_CLUSTER_ID = "raylab-managed-cluster";

export const defaultLifecycleConfig: LifecycleConfig = {
  head_host: "127.0.0.1",
  node_ip_address: "",
  ray_port: 6379,
  dashboard_port: 8265,
  client_port: 10001,
  cpus: 4,
  gpus: 0,
  max_concurrent_jobs: 1,
  auth_enabled: true,
};

export function normalizeLifecycleConfig(value: Partial<LifecycleConfig> | null | undefined): LifecycleConfig {
  return {
    head_host: value?.head_host?.trim() || defaultLifecycleConfig.head_host,
    node_ip_address: value?.node_ip_address?.trim() || "",
    ray_port: validPort(value?.ray_port, defaultLifecycleConfig.ray_port),
    dashboard_port: validPort(value?.dashboard_port, defaultLifecycleConfig.dashboard_port),
    client_port: validPort(value?.client_port, defaultLifecycleConfig.client_port),
    cpus: nonNegative(value?.cpus, defaultLifecycleConfig.cpus),
    gpus: nonNegative(value?.gpus, defaultLifecycleConfig.gpus),
    max_concurrent_jobs: Math.max(1, Math.round(nonNegative(value?.max_concurrent_jobs, 1))),
    auth_enabled: value?.auth_enabled !== false,
  };
}

export interface ParsedCoordinatorInput {
  host: string;
  ray_port?: number;
  dashboard_port?: number;
  token?: string;
}

export function parseCoordinatorInput(raw: string): ParsedCoordinatorInput | null {
  const value = raw.trim();
  if (!value) return null;
  const inviteMatch = value.match(/^raylab:\/\/join\?(.+)$/i);
  const params = inviteMatch ? new URLSearchParams(inviteMatch[1]) : null;
  let host = (params?.get("host") ?? value).trim();
  if (!host) return null;
  host = host.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  host = host.replace(/^[^/@]*@/, "");
  host = host.split(/[/?#]/)[0].trim();
  if (!host || /\s/.test(host)) return null;

  let ray_port: number | undefined;
  const colonIndex = host.lastIndexOf(":");
  if (colonIndex > -1 && /^\d+$/.test(host.slice(colonIndex + 1))) {
    const candidate = Number(host.slice(colonIndex + 1));
    if (candidate > 0 && candidate <= 65535) {
      ray_port = candidate;
      host = host.slice(0, colonIndex);
    }
  }
  if (params) {
    ray_port ??= validPort(params.get("ray_port"), NaN) || undefined;
  }
  const parsed: ParsedCoordinatorInput = { host };
  if (ray_port) parsed.ray_port = ray_port;
  if (params) {
    const dashboard_port = validPort(params.get("dashboard_port"), NaN);
    if (dashboard_port) parsed.dashboard_port = dashboard_port;
    const token = params.get("token")?.trim();
    if (token) parsed.token = token;
  }
  return parsed;
}

export function buildJoinLink(joinAddress: string, token: string, config?: Pick<LifecycleConfig, "ray_port" | "dashboard_port">) {
  const [hostPart, portPart] = joinAddress.trim().split(":");
  const host = hostPart.trim();
  if (!host) return "";
  const params = new URLSearchParams();
  params.set("host", host);
  if (portPart) params.set("ray_port", portPart);
  else if (config?.ray_port) params.set("ray_port", String(config.ray_port));
  if (config?.dashboard_port) params.set("dashboard_port", String(config.dashboard_port));
  params.set("token", token.trim());
  return `raylab://join?${params.toString()}`;
}

export function validateRoleSetup(mode: AppMode, config: LifecycleConfig, token = "") {
  if (mode === "unconfigured") throw new Error("Choose Coordinator or Worker mode");
  if (mode === "worker") {
    const host = config.head_host.trim();
    if (!host || host.includes("://") || host.includes(":") || /\s/.test(host)) {
      throw new Error("Enter the coordinator IP address or DNS hostname without a scheme or port");
    }
    if (config.auth_enabled && token.trim().length < 16) {
      throw new Error("Paste the coordinator's shared token (at least 16 characters)");
    }
  }
  if (config.node_ip_address && !/^\d{1,3}(\.\d{1,3}){3}$/.test(config.node_ip_address)) {
    throw new Error("Node IP must be an IPv4 address or left blank for automatic detection");
  }
  if (config.cpus < 0 || config.gpus < 0) throw new Error("Shared CPU and GPU values cannot be negative");
}

export function managedCluster(mode: Exclude<AppMode, "unconfigured">, config: LifecycleConfig, detectedNodeIp: string): SavedCluster {
  const host = mode === "coordinator" ? detectedNodeIp : config.head_host.trim();
  return {
    id: MANAGED_CLUSTER_ID,
    name: mode === "coordinator" ? "My RayLab cluster" : `RayLab cluster at ${host}`,
    dashboard_url: `http://${host}:${config.dashboard_port}`,
    managed: true,
  };
}

export function prefillCoordinatorNodeIp(
  mode: Exclude<AppMode, "unconfigured">,
  config: LifecycleConfig,
  detectedNodeIp: string,
): LifecycleConfig {
  const detected = detectedNodeIp.trim();
  if (mode !== "coordinator" || config.node_ip_address.trim() || !isUsableIpv4(detected)) return config;
  return { ...config, node_ip_address: detected };
}

function validPort(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : fallback;
}

function nonNegative(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function isUsableIpv4(value: string) {
  const parts = value.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && parts[0] !== "127"
    && value !== "0.0.0.0";
}
