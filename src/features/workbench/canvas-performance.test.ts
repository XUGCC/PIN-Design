import { describe, expect, it } from "vitest";
import { canvasBackingScale } from "./canvas-performance";

describe("canvas backing-store limits", () => {
  it("keeps large mobile canvases below the mobile pixel and texture budgets", () => {
    const logicalSize = 100 * 22;
    const scale = canvasBackingScale(logicalSize, logicalSize, 3, true);
    const backingSize = Math.floor(logicalSize * scale);
    expect(backingSize).toBeLessThanOrEqual(3072);
    expect(backingSize * backingSize).toBeLessThanOrEqual(8_000_000);
  });

  it("allows a larger backing store on desktop", () => {
    const logicalSize = 100 * 22;
    const mobile = canvasBackingScale(logicalSize, logicalSize, 2, true);
    const desktop = canvasBackingScale(logicalSize, logicalSize, 2, false);
    expect(desktop).toBeGreaterThan(mobile);
  });

  it("still respects the budget at the maximum 200 by 200 grid", () => {
    const logicalSize = 200 * 22;
    const scale = canvasBackingScale(logicalSize, logicalSize, 3, true);
    const backingSize = Math.floor(logicalSize * scale);
    expect(backingSize).toBeLessThanOrEqual(3072);
    expect(backingSize * backingSize).toBeLessThanOrEqual(8_000_000);
  });
});

