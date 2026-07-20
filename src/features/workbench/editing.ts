import type { WorkbenchProject } from "./model";
import { connectedRegion } from "./regions";

export type EditTool = "paint" | "erase" | "fill-erase" | "picker" | "replace";

export interface EditResult {
  project: WorkbenchProject;
  pickedColorId?: string | null;
  changed: boolean;
}

export function applyEditAction(
  project: WorkbenchProject,
  index: number,
  tool: EditTool,
  selectedColorId: string | null,
): EditResult {
  const source = project.cells[index];
  if (!source) return { project, changed: false };
  if (tool === "picker") return { project, pickedColorId: source.colorId, changed: false };
  const cells = project.cells.map((cell) => ({ ...cell }));
  if (tool === "paint") cells[index] = { colorId: selectedColorId, completed: false };
  if (tool === "erase") cells[index] = { colorId: null, completed: false };
  if (tool === "fill-erase") {
    const region = connectedRegion(cells, project.optimize.width, project.optimize.height, index, false);
    region?.cells.forEach((point) => { cells[point.index] = { colorId: null, completed: false }; });
  }
  if (tool === "replace" && source.colorId && selectedColorId) {
    cells.forEach((cell, cellIndex) => {
      if (cell.colorId === source.colorId) cells[cellIndex] = { colorId: selectedColorId, completed: false };
    });
  }
  const changed = cells.some((cell, cellIndex) => (
    cell.colorId !== project.cells[cellIndex].colorId ||
    cell.completed !== project.cells[cellIndex].completed ||
    cell.sourceHex !== project.cells[cellIndex].sourceHex
  ));
  return { project: changed ? { ...project, cells } : project, changed };
}
