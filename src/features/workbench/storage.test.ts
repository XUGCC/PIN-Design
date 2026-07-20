import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyPayload, migrateLegacyProjectOnce } from "./storage";

let storageValues: Map<string, string>;

describe("legacy migration", () => {
  beforeEach(() => {
    storageValues = new Map<string, string>();
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storageValues.get(key) ?? null,
        setItem: (key: string, value: string) => storageValues.set(key, String(value)),
        removeItem: (key: string) => storageValues.delete(key),
      },
    });
  });

  it("imports old focus-mode pixels, dimensions and color system", () => {
    const project = migrateLegacyPayload({
      dimensions: { N: 2, M: 1 },
      selectedColorSystem: "COCO",
      paletteSelections: { "#FFFFFF": true },
      pixelData: [[
        { key: "white", color: "#FFFFFF" },
        { key: "empty", color: "#FFFFFF", isExternal: true },
      ]],
    });
    expect(project?.optimize).toMatchObject({ width: 2, height: 1 });
    expect(project?.colorSystem).toBe("COCO");
    expect(project?.palette).toHaveLength(1);
    expect(project?.cells[0].colorId).toBeTruthy();
    expect(project?.cells[1].colorId).toBeNull();
  });

  it("rejects malformed legacy dimensions", () => {
    expect(migrateLegacyPayload({ pixelData: [], dimensions: { N: 0, M: 999 } })).toBeNull();
  });

  it("migrates only once and does not delete the old recovery keys", async () => {
    storageValues.set("focusMode_pixelData", JSON.stringify([[{ color: "#FFFFFF" }]]));
    storageValues.set("focusMode_gridDimensions", JSON.stringify({ N: 1, M: 1 }));
    storageValues.set("focusMode_colorCounts", JSON.stringify({ "#FFFFFF": { color: "#FFFFFF", count: 1 } }));
    const first = await migrateLegacyProjectOnce();
    const second = await migrateLegacyProjectOnce();
    expect(first?.cells).toHaveLength(1);
    expect(second).toBeNull();
    expect(storageValues.has("focusMode_pixelData")).toBe(true);
  });
});
