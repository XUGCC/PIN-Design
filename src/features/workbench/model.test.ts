import { describe, expect, it } from "vitest";
import { createProject, parseProjectFile, projectProgress, serializeProject } from "./model";
import { FULL_PALETTE } from "./palette";

describe("project model", () => {
  it("round-trips a complete project file", () => {
    const project = createProject({
      name: "测试项目",
      palette: FULL_PALETTE.slice(0, 3),
      optimize: {
        width: 2,
        height: 2,
        mode: "dominant",
        mergeTolerance: 8,
        removeBackground: false,
        backgroundColor: "#FFFFFF",
        excludedColorIds: [],
      },
      cells: [
        { colorId: FULL_PALETTE[0].id, completed: true, sourceHex: "#123456" },
        { colorId: FULL_PALETTE[1].id, completed: false },
        { colorId: null, completed: false },
        { colorId: FULL_PALETTE[2].id, completed: false },
      ],
    });
    const restored = parseProjectFile(serializeProject(project));
    expect(restored.name).toBe("测试项目");
    expect(restored.cells).toEqual(project.cells);
    expect(restored.palette).toHaveLength(3);
    expect(projectProgress(restored)).toBe(33);
  });

  it("repairs missing cells and clamps dimensions", () => {
    const repaired = parseProjectFile(JSON.stringify({ optimize: { width: 999, height: 0 }, cells: [] }));
    expect(repaired.optimize.width).toBe(200);
    expect(repaired.optimize.height).toBe(1);
    expect(repaired.cells).toHaveLength(200);
  });
});
