import { describe, expect, it } from "vitest";
import { constrainConfigToHardware, fallbackConfig } from "./store";
import type { HardwareInfo } from "./types";

describe("resource caps", () => {
  it("does not offer more GPUs than hardware detection reports", () => {
    const hardware: HardwareInfo = {
      cpu_logical: 8,
      cpu_physical: 4,
      memory_total_gb: 32,
      gpu_count: 0,
      gpu_names: [],
      gpu_type: "none",
      gpu_memory_total_gb: null,
      gpu_memory_shared: false,
      source: "test",
    };

    const config = constrainConfigToHardware(
      { ...fallbackConfig, resource_caps: { ...fallbackConfig.resource_caps, gpus: 1, gpu_memory_gb: 12 } },
      hardware,
    );

    expect(config.resource_caps.gpus).toBe(0);
    expect(config.resource_caps.gpu_memory_gb).toBe(0);
  });
});
