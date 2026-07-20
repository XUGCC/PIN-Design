import { describe, expect, it } from "vitest";
import { connectedRegion, countHints, regionBoundary, type Region } from "./regions";
import type { PixelCell } from "./model";

const colored = (colorId: string | null): PixelCell => ({ colorId, completed: false });

describe("region guidance", () => {
  it("finds a four-connected region without crossing diagonals", () => {
    const cells = [colored("a"), colored(null), colored("a"), colored("a")];
    const region = connectedRegion(cells, 2, 2, 0);
    expect(region?.cells.map((cell) => cell.index)).toEqual([0, 2, 3]);
  });

  it("returns only the true external boundary", () => {
    const region: Region = {
      x: 0, y: 0, index: 0, colorId: "a",
      cells: [
        { x: 0, y: 0, index: 0 }, { x: 1, y: 0, index: 1 },
        { x: 0, y: 1, index: 2 }, { x: 1, y: 1, index: 3 },
      ],
    };
    expect(regionBoundary(region)).toHaveLength(8);
  });

  it("keeps the boundary around a hole without adding shared internal edges", () => {
    const points = [];
    let index = 0;
    for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) {
      if (x !== 1 || y !== 1) points.push({ x, y, index: index++ });
    }
    expect(regionBoundary({ x: 0, y: 0, index: 0, colorId: "a", cells: points })).toHaveLength(16);
  });

  it("generates vertical counts like 2, 6, 9", () => {
    const points: Region["cells"] = [];
    let index = 0;
    [[7, 8], [3, 8], [0, 8]].forEach(([start, end], x) => {
      for (let y = start; y <= end; y += 1) points.push({ x, y, index: index++ });
    });
    const result = countHints({ x: 0, y: 7, index: 0, colorId: "a", cells: points }, "vertical");
    expect(result.hints.map((hint) => hint.count)).toEqual([2, 6, 9]);
    expect(result.hints.every((hint) => hint.direction === "vertical")).toBe(true);
  });

  it("auto mode chooses the direction with fewer labels", () => {
    const points = Array.from({ length: 8 }, (_, index) => ({ x: index % 4, y: Math.floor(index / 4), index }));
    const result = countHints({ x: 0, y: 0, index: 0, colorId: "a", cells: points }, "auto");
    expect(result.direction).toBe("horizontal");
    expect(result.hints).toHaveLength(2);
  });

  it("completed cells split the remaining connected region", () => {
    const cells = [colored("a"), { colorId: "a", completed: true }, colored("a")];
    expect(connectedRegion(cells, 3, 1, 0)?.cells).toHaveLength(1);
    expect(connectedRegion(cells, 3, 1, 2)?.cells).toHaveLength(1);
  });
});
