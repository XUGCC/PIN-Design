import { describe, expect, it } from "vitest";
import { applyEditAction } from "./editing";
import { parseCsv, projectToCsv } from "./import-export";
import { parseProjectFile, serializeProject } from "./model";

describe("first-version project workflow", () => {
  it("imports, edits, records progress, backs up and exports", () => {
    let project = parseCsv("#FFFFFF,#FFFFFF\nTRANSPARENT,#000000", "流程测试");
    project = applyEditAction(project, 2, "paint", project.cells[0].colorId).project;
    project = { ...project, stage: "bead", cells: project.cells.map((cell, index) => index === 0 ? { ...cell, completed: true } : cell) };
    const restored = parseProjectFile(serializeProject(project));
    expect(restored.stage).toBe("bead");
    expect(restored.cells[0].completed).toBe(true);
    expect(projectToCsv(restored)).toContain("#");
  });
});

