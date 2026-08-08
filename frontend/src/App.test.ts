import { describe, expect, it } from "vitest";

describe("RayLab frontend", () => {
  it("keeps tests wired", () => {
    expect("raylab").toContain("ray");
  });
});
