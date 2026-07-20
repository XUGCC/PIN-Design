import { describe, expect, it } from "vitest";
import {
  bestPaletteEntryForCodes,
  extractPatternCells,
  parseCsv,
  projectToCsv,
  recognizePrintedCodeGlyph,
  validateImportFile,
} from "./import-export";
import type { PaletteEntry } from "./model";

describe("file import validation", () => {
  it("accepts images supplied by a phone photo picker", () => {
    const heic = { name: "IMG_0001.HEIC", type: "image/heic" } as File;
    const cameraJpeg = { name: "camera-photo", type: "image/jpeg" } as File;
    expect(validateImportFile(heic)).toBe("image");
    expect(validateImportFile(cameraJpeg)).toBe("image");
  });
});

describe("CSV import and export", () => {
  it("round-trips transparent and colored cells", () => {
    const project = parseCsv("#FFFFFF,TRANSPARENT\n#000000,#FF0000", "CSV");
    expect(project.optimize.width).toBe(2);
    expect(project.optimize.height).toBe(2);
    expect(project.cells[1].colorId).toBeNull();
    const text = projectToCsv(project);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("TRANSPARENT");
  });

  it("rejects inconsistent row widths and invalid colors", () => {
    expect(() => parseCsv("#FFFFFF\n#000000,#FF0000")).toThrow("列数必须一致");
    expect(() => parseCsv("red")).toThrow("不是有效的 HEX 颜色");
  });
});

describe("finished pattern recognition", () => {
  const palette: PaletteEntry[] = [
    { id: "red", hex: "#E33232", codes: { MARD: "R1" } },
    { id: "green", hex: "#28B45A", codes: { MARD: "G1" } },
    { id: "white", hex: "#FFFFFF", codes: { MARD: "W1" } },
  ];

  it("ignores grid borders and central printed codes while preserving source colors", () => {
    const width = 20;
    const height = 10;
    const pixels = new Uint8ClampedArray(width * height * 4);
    const paint = (x: number, y: number, color: [number, number, number]) => {
      const offset = (y * width + x) * 4;
      pixels.set([...color, 255], offset);
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const border = x === 0 || x === 9 || x === 10 || x === 19 || y === 0 || y === 9;
        paint(x, y, border ? [20, 20, 20] : x < 10 ? [230, 48, 48] : [38, 184, 86]);
      }
    }
    // Simulate a dark color code printed in the centre of both cells.
    for (let y = 3; y <= 6; y += 1) {
      for (const x of [4, 5, 14, 15]) paint(x, y, [0, 0, 0]);
    }

    const cells = extractPatternCells(pixels, width, height, { width: 2, height: 1 }, palette);
    expect(cells.map((cell) => cell.colorId)).toEqual(["red", "green"]);
    expect(cells.map((cell) => cell.sourceHex)).toEqual(["#E63030", "#26B856"]);
  });

  it("can treat near-white chart cells as empty without changing other cells", () => {
    const pixels = new Uint8ClampedArray([
      252, 252, 252, 255,
      230, 48, 48, 255,
    ]);
    const cells = extractPatternCells(
      pixels,
      2,
      1,
      { width: 2, height: 1, whiteAsEmpty: true },
      palette,
    );
    expect(cells[0]).toEqual({ colorId: null, completed: false });
    expect(cells[1].colorId).toBe("red");
  });

  it("keeps a near-white bead when a printed color code is present", () => {
    const width = 10;
    const height = 10;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels.set([250, 248, 246, 255], offset);
      }
    }
    for (let y = 3; y <= 6; y += 1) {
      for (const x of [4, 5]) pixels.set([40, 40, 40, 255], (y * width + x) * 4);
    }

    const [cell] = extractPatternCells(
      pixels,
      width,
      height,
      { width: 1, height: 1, whiteAsEmpty: true },
      palette,
    );
    expect(cell.colorId).toBe("white");
    expect(cell.sourceHex).toBe("#FAF8F6");
  });

  it("lets an exact printed code override a misleading background color", () => {
    const matched = bestPaletteEntryForCodes(
      ["G1"],
      "red",
      "#E33232",
      palette,
      "MARD",
    );
    expect(matched.id).toBe("green");
  });

  it("uses fill color to resolve an ambiguous OCR stroke", () => {
    const palePalette: PaletteEntry[] = [
      { id: "e16", hex: "#FFF3EB", codes: { MARD: "E16" } },
      { id: "e18", hex: "#FFC7DB", codes: { MARD: "E18" } },
    ];
    expect(bestPaletteEntryForCodes(["EI8"], "e16", "#FCF6F4", palePalette, "MARD").id).toBe("e16");
  });

  it("recognizes a tiny printed code even when screenshot color points elsewhere", () => {
    const chartPalette: PaletteEntry[] = [
      { id: "e4", hex: "#E8649E", codes: { MARD: "E04" } },
      { id: "r27", hex: "#EA8CB1", codes: { MARD: "R27" } },
      { id: "e9", hex: "#E970CC", codes: { MARD: "E09" } },
    ];
    // Binary rows sampled from a compressed 52 × 52 chart. The isolated
    // corner pixels imitate a faint diagonal watermark crossing the cell.
    const glyph = [
      "#...#####.##.##.",
      ".#..#####.##.##.",
      "....###...##.##.",
      "....#####.#####.",
      "....#####.#####.",
      "....##......##..",
      "....#####...##..",
      "....####....##.#",
    ];

    expect(recognizePrintedCodeGlyph(glyph, "#DB87AB", chartPalette, "MARD")?.id).toBe("e4");
  });

  it("rejects diagonal watermark contrast that has no color-code shape", () => {
    const watermark = [
      "#..............",
      ".##............",
      "...##..........",
      ".....##........",
      ".......##......",
      ".........##....",
      "...........##..",
      ".............##",
    ];
    expect(recognizePrintedCodeGlyph(watermark, "#FFFFFF", palette, "MARD")).toBeNull();
  });
});
