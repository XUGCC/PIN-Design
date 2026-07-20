import { describe, expect, it } from "vitest";
import { applyEditAction } from "./editing";
import { createProject } from "./model";

const makeProject = () => createProject({
  optimize: { width: 3, height: 2, mode: "dominant", mergeTolerance: 8, removeBackground: false, backgroundColor: "#fff", excludedColorIds: [] },
  cells: [
    { colorId: "a", completed: false }, { colorId: "a", completed: false }, { colorId: "b", completed: false },
    { colorId: "a", completed: false }, { colorId: null, completed: false }, { colorId: "b", completed: false },
  ],
});

describe("editing actions", () => {
  it("paints, erases and picks", () => {
    const painted = applyEditAction(makeProject(), 4, "paint", "c");
    expect(painted.project.cells[4].colorId).toBe("c");
    expect(applyEditAction(painted.project, 4, "erase", "c").project.cells[4].colorId).toBeNull();
    expect(applyEditAction(makeProject(), 2, "picker", null).pickedColorId).toBe("b");
  });

  it("erases a connected region and replaces a color globally", () => {
    const erased = applyEditAction(makeProject(), 0, "fill-erase", null).project;
    expect(erased.cells.filter((cell) => cell.colorId === "a")).toHaveLength(0);
    const replaced = applyEditAction(makeProject(), 2, "replace", "c").project;
    expect(replaced.cells.filter((cell) => cell.colorId === "c")).toHaveLength(2);
  });
});

