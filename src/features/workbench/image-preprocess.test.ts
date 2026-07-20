import { describe, expect, it } from "vitest";
import { deriveGridSize, detectBeadGrid } from "./image-preprocess";

function syntheticGrid(
  columns: number,
  rows: number,
  cellSize: number,
  marginX: number,
  marginY: number,
) {
  const width = marginX * 2 + columns * cellSize + 1;
  const height = marginY * 2 + rows * cellSize + 1;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  const paint = (x: number, y: number, value: number) => {
    const offset = (y * width + x) * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  };
  const right = marginX + columns * cellSize;
  const bottom = marginY + rows * cellSize;
  for (let column = 0; column <= columns; column += 1) {
    const x = marginX + column * cellSize;
    for (let y = marginY; y <= bottom; y += 1) paint(x, y, 20);
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = marginY + row * cellSize;
    for (let x = marginX; x <= right; x += 1) paint(x, y, 20);
  }
  return { data, width, height, left: marginX, top: marginY, right, bottom };
}

describe("deriveGridSize", () => {
  it("preserves landscape and portrait aspect ratios", () => {
    expect(deriveGridSize(1600, 900, 80)).toEqual({ width: 80, height: 45 });
    expect(deriveGridSize(900, 1600, 80)).toEqual({ width: 45, height: 80 });
  });

  it("clamps the long edge and always keeps both dimensions usable", () => {
    expect(deriveGridSize(10000, 1, 999)).toEqual({ width: 200, height: 1 });
    expect(deriveGridSize(0, 0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe("detectBeadGrid", () => {
  it("detects a 52 by 52 regular grid surrounded by non-grid margins", () => {
    const source = syntheticGrid(52, 52, 9, 31, 27);
    const result = detectBeadGrid(source);
    expect(result).not.toBeNull();
    expect(result?.columns).toBe(52);
    expect(result?.rows).toBe(52);
    expect(result?.left).toBeCloseTo(source.left, 0);
    expect(result?.top).toBeCloseTo(source.top, 0);
    expect(result?.right).toBeCloseTo(source.right, 0);
    expect(result?.bottom).toBeCloseTo(source.bottom, 0);
    expect(result?.xLines).toHaveLength(53);
    expect(result?.yLines).toHaveLength(53);
    expect(result?.confidence).toBeGreaterThan(0.45);
  });
});
