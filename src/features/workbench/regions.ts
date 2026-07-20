import type { CountDirection, PixelCell } from "./model";

export interface GridPoint {
  x: number;
  y: number;
  index: number;
}

export interface Region extends GridPoint {
  cells: GridPoint[];
  colorId: string;
}

export interface BoundaryEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CountHint {
  count: number;
  x: number;
  y: number;
  startIndex: number;
  endIndex: number;
  direction: "horizontal" | "vertical";
}

const neighbors = (index: number, width: number, height: number): number[] => {
  const x = index % width;
  const y = Math.floor(index / width);
  const result: number[] = [];
  if (x > 0) result.push(index - 1);
  if (x + 1 < width) result.push(index + 1);
  if (y > 0) result.push(index - width);
  if (y + 1 < height) result.push(index + width);
  return result;
};

export function connectedRegion(
  cells: PixelCell[],
  width: number,
  height: number,
  startIndex: number,
  onlyUnfinished = true,
): Region | null {
  const start = cells[startIndex];
  if (!start?.colorId || (onlyUnfinished && start.completed)) return null;
  const seen = new Set<number>([startIndex]);
  const queue = [startIndex];
  const points: GridPoint[] = [];
  let cursor = 0;
  while (cursor < queue.length) {
    const index = queue[cursor++];
    const x = index % width;
    const y = Math.floor(index / width);
    points.push({ x, y, index });
    for (const next of neighbors(index, width, height)) {
      const cell = cells[next];
      if (
        !seen.has(next) &&
        cell?.colorId === start.colorId &&
        (!onlyUnfinished || !cell.completed)
      ) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const anchor = points[0];
  return { ...anchor, cells: points, colorId: start.colorId };
}

export function allRegions(
  cells: PixelCell[],
  width: number,
  height: number,
  colorId?: string,
  onlyUnfinished = true,
): Region[] {
  const visited = new Set<number>();
  const regions: Region[] = [];
  cells.forEach((cell, index) => {
    if (visited.has(index) || !cell.colorId || (colorId && cell.colorId !== colorId)) return;
    if (onlyUnfinished && cell.completed) return;
    const region = connectedRegion(cells, width, height, index, onlyUnfinished);
    if (!region) return;
    region.cells.forEach((point) => visited.add(point.index));
    regions.push(region);
  });
  return regions;
}

export function regionBoundary(region: Region): BoundaryEdge[] {
  const occupied = new Set(region.cells.map((cell) => `${cell.x},${cell.y}`));
  const edges: BoundaryEdge[] = [];
  for (const cell of region.cells) {
    const { x, y } = cell;
    if (!occupied.has(`${x},${y - 1}`)) edges.push({ x1: x, y1: y, x2: x + 1, y2: y });
    if (!occupied.has(`${x + 1},${y}`)) edges.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1 });
    if (!occupied.has(`${x},${y + 1}`)) edges.push({ x1: x + 1, y1: y + 1, x2: x, y2: y + 1 });
    if (!occupied.has(`${x - 1},${y}`)) edges.push({ x1: x, y1: y + 1, x2: x, y2: y });
  }
  return edges;
}

function horizontalHints(region: Region): CountHint[] {
  const byRow = new Map<number, GridPoint[]>();
  region.cells.forEach((cell) => byRow.set(cell.y, [...(byRow.get(cell.y) ?? []), cell]));
  const hints: CountHint[] = [];
  for (const [y, row] of byRow) {
    row.sort((a, b) => a.x - b.x);
    let start = 0;
    for (let i = 1; i <= row.length; i += 1) {
      if (i === row.length || row[i].x !== row[i - 1].x + 1) {
        const run = row.slice(start, i);
        hints.push({
          count: run.length,
          x: (run[0].x + run[run.length - 1].x + 1) / 2,
          y: y + 0.5,
          startIndex: run[0].index,
          endIndex: run[run.length - 1].index,
          direction: "horizontal",
        });
        start = i;
      }
    }
  }
  return hints;
}

function verticalHints(region: Region): CountHint[] {
  const byColumn = new Map<number, GridPoint[]>();
  region.cells.forEach((cell) => byColumn.set(cell.x, [...(byColumn.get(cell.x) ?? []), cell]));
  const hints: CountHint[] = [];
  for (const [x, column] of byColumn) {
    column.sort((a, b) => a.y - b.y);
    let start = 0;
    for (let i = 1; i <= column.length; i += 1) {
      if (i === column.length || column[i].y !== column[i - 1].y + 1) {
        const run = column.slice(start, i);
        hints.push({
          count: run.length,
          x: x + 0.5,
          y: (run[0].y + run[run.length - 1].y + 1) / 2,
          startIndex: run[0].index,
          endIndex: run[run.length - 1].index,
          direction: "vertical",
        });
        start = i;
      }
    }
  }
  return hints;
}

export function countHints(
  region: Region,
  direction: CountDirection,
): { direction: "horizontal" | "vertical"; hints: CountHint[] } {
  const horizontal = horizontalHints(region);
  const vertical = verticalHints(region);
  if (direction === "horizontal") return { direction, hints: horizontal };
  if (direction === "vertical") return { direction, hints: vertical };
  if (horizontal.length < vertical.length) return { direction: "horizontal", hints: horizontal };
  if (vertical.length < horizontal.length) return { direction: "vertical", hints: vertical };
  const minX = Math.min(...region.cells.map((cell) => cell.x));
  const maxX = Math.max(...region.cells.map((cell) => cell.x));
  const minY = Math.min(...region.cells.map((cell) => cell.y));
  const maxY = Math.max(...region.cells.map((cell) => cell.y));
  return maxX - minX >= maxY - minY
    ? { direction: "horizontal", hints: horizontal }
    : { direction: "vertical", hints: vertical };
}

export function chooseGuidedRegion(
  regions: Region[],
  mode: "nearest" | "largest" | "edge",
  fromIndex: number | null,
  width: number,
  height: number,
): Region | null {
  if (!regions.length) return null;
  if (mode === "largest") return [...regions].sort((a, b) => b.cells.length - a.cells.length)[0];
  if (mode === "edge") {
    const edgeDistance = (region: Region) => Math.min(
      ...region.cells.map((cell) => Math.min(cell.x, cell.y, width - cell.x - 1, height - cell.y - 1)),
    );
    return [...regions].sort((a, b) => edgeDistance(a) - edgeDistance(b) || b.cells.length - a.cells.length)[0];
  }
  if (fromIndex === null) return regions[0];
  const fx = fromIndex % width;
  const fy = Math.floor(fromIndex / width);
  const distance = (region: Region) => Math.min(
    ...region.cells.map((cell) => Math.abs(cell.x - fx) + Math.abs(cell.y - fy)),
  );
  return [...regions].sort((a, b) => distance(a) - distance(b))[0];
}
