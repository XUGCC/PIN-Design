import {
  createProject,
  parseProjectFile,
  serializeProject,
  type ColorSystem,
  type PaletteEntry,
  type PixelCell,
  type PixelationMode,
  type WorkbenchProject,
} from "./model";
import { FULL_PALETTE, nearestPaletteEntry, paletteCode, paletteEntryById } from "./palette";

type OcradRecognizer = (image: HTMLCanvasElement | CanvasRenderingContext2D | ImageData) => string;
let ocradLoader: Promise<OcradRecognizer> | null = null;

function loadOcrad(): Promise<OcradRecognizer> {
  if (window.OCRAD) return Promise.resolve(window.OCRAD);
  if (ocradLoader) return ocradLoader;
  ocradLoader = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-perler-ocrad="true"]');
    const script = existing ?? document.createElement("script");
    const finish = () => window.OCRAD ? resolve(window.OCRAD) : reject(new Error("文字识别器加载失败"));
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", () => reject(new Error("文字识别器加载失败")), { once: true });
    if (!existing) {
      script.dataset.perlerOcrad = "true";
      const basePath = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
      script.src = new URL(`${basePath}vendor/ocrad.js`, window.location.origin).toString();
      document.head.appendChild(script);
    }
  });
  return ocradLoader;
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
]);

export function validateImportFile(file: File): "image" | "csv" | "project" {
  const name = file.name.toLowerCase();
  if (IMAGE_TYPES.has(file.type.toLowerCase()) || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/.test(name)) return "image";
  if (file.type === "text/csv" || name.endsWith(".csv")) return "csv";
  if (file.type === "application/json" || /\.(json|perler)$/.test(name)) return "project";
  throw new Error("支持手机相册图片、JPEG、PNG、WebP、GIF、CSV 和 .perler/.json 项目文件");
}

export function readFileAsText(file: File): Promise<string> {
  return file.text();
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片文件"));
    reader.readAsDataURL(file);
  });
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法解码或已经损坏；HEIC / HEIF 可先转为 JPG 或 PNG 再导入"));
    image.src = dataUrl;
  });
}

export async function projectFromImage(
  file: File,
  requestedWidth: number,
  requestedHeight: number,
  mode: PixelationMode = "dominant",
  palette = FULL_PALETTE,
): Promise<WorkbenchProject> {
  if (file.size > 40 * 1024 * 1024) throw new Error("图片不能超过 40 MB");
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const detail = Math.max(1, Math.min(200, Math.round(Math.max(requestedWidth, requestedHeight))));
  const imageAspect = image.naturalWidth / Math.max(1, image.naturalHeight);
  const width = imageAspect >= 1 ? detail : Math.max(1, Math.round(detail * imageAspect));
  const height = imageAspect >= 1 ? Math.max(1, Math.round(detail / imageAspect)) : detail;
  const canvas = document.createElement("canvas");
  const sampleFactor = Math.max(1, Math.min(4, Math.floor(800 / Math.max(width, height))));
  canvas.width = width * sampleFactor;
  canvas.height = height * sampleFactor;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前浏览器无法处理图片");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const cells: PixelCell[] = [];
  for (let index = 0; index < width * height; index += 1) {
    const cellX = index % width;
    const cellY = Math.floor(index / width);
    let alphaTotal = 0;
    let redTotal = 0;
    let greenTotal = 0;
    let blueTotal = 0;
    const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (let sy = 0; sy < sampleFactor; sy += 1) {
      for (let sx = 0; sx < sampleFactor; sx += 1) {
        const sampleX = cellX * sampleFactor + sx;
        const sampleY = cellY * sampleFactor + sy;
        const offset = (sampleY * canvas.width + sampleX) * 4;
        const alpha = pixels[offset + 3];
        if (alpha < 32) continue;
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        alphaTotal += 1;
        redTotal += r;
        greenTotal += g;
        blueTotal += b;
        const bucket = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
        const current = buckets.get(bucket) ?? { count: 0, r: 0, g: 0, b: 0 };
        current.count += 1;
        current.r += r;
        current.g += g;
        current.b += b;
        buckets.set(bucket, current);
      }
    }
    if (!alphaTotal) {
      cells.push({ colorId: null, completed: false });
      continue;
    }
    const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
    const rgb = mode === "average"
      ? [redTotal / alphaTotal, greenTotal / alphaTotal, blueTotal / alphaTotal]
      : [dominant.r / dominant.count, dominant.g / dominant.count, dominant.b / dominant.count];
    const hex = `#${rgb
      .map((value) => Math.round(value).toString(16).padStart(2, "0"))
      .join("")}`.toUpperCase();
    cells.push({ colorId: nearestPaletteEntry(hex, palette.length ? palette : FULL_PALETTE).id, completed: false });
  }
  return createProject({
    name: file.name.replace(/\.[^.]+$/, "") || "图片项目",
    palette: palette.length ? palette : FULL_PALETTE,
    cells,
    sourceImage: {
      name: file.name,
      mimeType: file.type || "image/png",
      width: image.naturalWidth,
      height: image.naturalHeight,
      dataUrl,
    },
    optimize: {
      width,
      height,
      mode,
      mergeTolerance: 8,
      removeBackground: false,
      backgroundColor: "#FFFFFF",
      excludedColorIds: [],
    },
  });
}

export interface PatternGridImportOptions {
  width: number;
  height: number;
  cropTop?: number;
  cropRight?: number;
  cropBottom?: number;
  cropLeft?: number;
  whiteAsEmpty?: boolean;
  colorSystem?: ColorSystem;
  onStatus?: (status: string) => void;
}

interface PatternCellAnalysis {
  cell: PixelCell;
  background: [number, number, number];
  labelInkPixels: number;
  hasPrintedCode: boolean;
  cellLeft: number;
  cellRight: number;
  cellTop: number;
  cellBottom: number;
}

function clampCrop(value: number | undefined): number {
  return Math.max(0, Math.min(45, Number(value) || 0));
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/**
 * Samples the quiet area around the centre of every chart cell. Grid borders
 * and the central label area are deliberately skipped, so screenshots with
 * grid lines or printed bead codes still resolve to the underlying fill.
 */
function analyzePatternCells(
  pixels: Uint8ClampedArray,
  pixelWidth: number,
  pixelHeight: number,
  options: PatternGridImportOptions,
  palette = FULL_PALETTE,
): PatternCellAnalysis[] {
  const width = Math.max(1, Math.min(200, Math.round(options.width)));
  const height = Math.max(1, Math.min(200, Math.round(options.height)));
  if (pixels.length < pixelWidth * pixelHeight * 4) throw new Error("图纸像素数据不完整");
  if (!palette.length) throw new Error("至少需要一种可匹配的拼豆颜色");

  const cropLeft = clampCrop(options.cropLeft) / 100;
  const cropRight = clampCrop(options.cropRight) / 100;
  const cropTop = clampCrop(options.cropTop) / 100;
  const cropBottom = clampCrop(options.cropBottom) / 100;
  const left = Math.floor(pixelWidth * cropLeft);
  const right = Math.ceil(pixelWidth * (1 - cropRight));
  const top = Math.floor(pixelHeight * cropTop);
  const bottom = Math.ceil(pixelHeight * (1 - cropBottom));
  const usableWidth = right - left;
  const usableHeight = bottom - top;
  if (usableWidth < width || usableHeight < height) throw new Error("裁剪后的图纸太小，无法按设定网格识别");

  const analyses: PatternCellAnalysis[] = [];
  for (let cellY = 0; cellY < height; cellY += 1) {
    for (let cellX = 0; cellX < width; cellX += 1) {
      const cellLeft = left + (cellX * usableWidth) / width;
      const cellRight = left + ((cellX + 1) * usableWidth) / width;
      const cellTop = top + (cellY * usableHeight) / height;
      const cellBottom = top + ((cellY + 1) * usableHeight) / height;
      const cellWidth = cellRight - cellLeft;
      const cellHeight = cellBottom - cellTop;
      const sampleLeft = Math.max(0, Math.floor(cellLeft + cellWidth * 0.14));
      const sampleRight = Math.min(pixelWidth, Math.ceil(cellRight - cellWidth * 0.14));
      const sampleTop = Math.max(0, Math.floor(cellTop + cellHeight * 0.14));
      const sampleBottom = Math.min(pixelHeight, Math.ceil(cellBottom - cellHeight * 0.14));
      const stepX = Math.max(1, Math.floor(cellWidth / 14));
      const stepY = Math.max(1, Math.floor(cellHeight / 14));
      const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

      const addPixel = (x: number, y: number) => {
        const offset = (y * pixelWidth + x) * 4;
        if (pixels[offset + 3] < 32) return;
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
        const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        buckets.set(key, bucket);
      };

      for (let y = sampleTop; y < sampleBottom; y += stepY) {
        const normalizedY = (y + 0.5 - cellTop) / cellHeight;
        for (let x = sampleLeft; x < sampleRight; x += stepX) {
          const normalizedX = (x + 0.5 - cellLeft) / cellWidth;
          // Printed color codes normally occupy this central rectangle.
          if (normalizedX > 0.34 && normalizedX < 0.66 && normalizedY > 0.3 && normalizedY < 0.7) continue;
          addPixel(x, y);
        }
      }
      if (!buckets.size) {
        addPixel(
          Math.max(0, Math.min(pixelWidth - 1, Math.floor((cellLeft + cellRight) / 2))),
          Math.max(0, Math.min(pixelHeight - 1, Math.floor((cellTop + cellBottom) / 2))),
        );
      }
      const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
      if (!dominant) {
        analyses.push({
          cell: { colorId: null, completed: false },
          background: [255, 255, 255],
          labelInkPixels: 0,
          hasPrintedCode: false,
          cellLeft,
          cellRight,
          cellTop,
          cellBottom,
        });
        continue;
      }
      const r = dominant.r / dominant.count;
      const g = dominant.g / dominant.count;
      const b = dominant.b / dominant.count;
      const codeLeft = Math.max(0, Math.floor(cellLeft + cellWidth * 0.18));
      const codeRight = Math.min(pixelWidth, Math.ceil(cellRight - cellWidth * 0.18));
      const codeTop = Math.max(0, Math.floor(cellTop + cellHeight * 0.22));
      const codeBottom = Math.min(pixelHeight, Math.ceil(cellBottom - cellHeight * 0.22));
      let labelInkPixels = 0;
      for (let y = codeTop; y < codeBottom; y += 1) {
        for (let x = codeLeft; x < codeRight; x += 1) {
          const offset = (y * pixelWidth + x) * 4;
          const contrast = Math.max(
            Math.abs(pixels[offset] - r),
            Math.abs(pixels[offset + 1] - g),
            Math.abs(pixels[offset + 2] - b),
          );
          if (pixels[offset + 3] >= 32 && contrast > 42) labelInkPixels += 1;
        }
      }
      const minimumLabelInk = Math.max(3, Math.round(cellWidth * cellHeight * 0.008));
      const hasPrintedCode = labelInkPixels >= minimumLabelInk;
      const sourceHex = rgbHex(r, g, b);
      const isEmptyWhite = Boolean(options.whiteAsEmpty && r >= 245 && g >= 245 && b >= 245 && !hasPrintedCode);
      analyses.push({
        cell: isEmptyWhite ? { colorId: null, completed: false } : {
          colorId: nearestPaletteEntry(sourceHex, palette).id,
          completed: false,
          sourceHex,
        },
        background: [r, g, b],
        labelInkPixels,
        hasPrintedCode,
        cellLeft,
        cellRight,
        cellTop,
        cellBottom,
      });
    }
  }
  return analyses;
}

export function extractPatternCells(
  pixels: Uint8ClampedArray,
  pixelWidth: number,
  pixelHeight: number,
  options: PatternGridImportOptions,
  palette = FULL_PALETTE,
): PixelCell[] {
  return analyzePatternCells(pixels, pixelWidth, pixelHeight, options, palette).map(({ cell }) => cell);
}

function normalizedBeadCode(value: string): string {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = /^([A-Z]+)0*([0-9]+)$/.exec(cleaned);
  return match ? `${match[1]}${Number(match[2])}` : cleaned;
}

function substitutionCost(left: string, right: string): number {
  if (left === right) return 0;
  const commonOcrConfusions = ["I1LT7", "O0Q4", "S5", "G68B", "Z2P", "NMH", "VY4", "FP", "CE"];
  return commonOcrConfusions.some((group) => group.includes(left) && group.includes(right)) ? 0.22 : 1;
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const before = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + substitutionCost(left[i - 1], right[j - 1]));
      previous = before;
    }
  }
  return row[right.length];
}

type BinaryGlyph = boolean[][];

// A compact 5 × 7 alphabet is substantially more reliable than general OCR
// for the 5–9 px labels commonly found in shared bead charts. It is only used
// as a constrained scorer against codes that actually exist in the selected
// palette; OCR remains a second, independent signal.
const CODE_GLYPH_ROWS: Record<string, string> = {
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01111/10000/10000/10000/10000/10000/01111",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01111/10000/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "11111/00100/00100/00100/00100/00100/11111",
  J: "00111/00010/00010/00010/10010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/10101/10011/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/10101/01010",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
  "0": "01110/10001/10011/10101/11001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111",
  "3": "11110/00001/00001/01110/00001/00001/11110",
  // Tiny chart fonts usually draw an open-top four instead of a diagonal one.
  "4": "10010/10010/10010/11111/00010/00010/00010",
  "5": "11111/10000/10000/11110/00001/00001/11110",
  "6": "01110/10000/10000/11110/10001/10001/01110",
  "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110",
  "9": "01110/10001/10001/01111/00001/00001/01110",
};

const CODE_GLYPHS = new Map(
  Object.entries(CODE_GLYPH_ROWS).map(([character, rows]) => [
    character,
    rows.split("/").map((row) => [...row].map((pixel) => pixel === "1")),
  ]),
);

function templateForCode(code: string): BinaryGlyph | null {
  const characters = [...code];
  if (!characters.length || characters.some((character) => !CODE_GLYPHS.has(character))) return null;
  const width = characters.length * 6 - 1;
  const template = Array.from({ length: 7 }, () => Array.from({ length: width }, () => false));
  characters.forEach((character, characterIndex) => {
    const glyph = CODE_GLYPHS.get(character)!;
    glyph.forEach((row, y) => row.forEach((pixel, x) => {
      template[y][characterIndex * 6 + x] = pixel;
    }));
  });
  return template;
}

function trimGlyph(glyph: BinaryGlyph): BinaryGlyph | null {
  if (!glyph.length || !glyph[0]?.length) return null;
  const occupiedRows: number[] = [];
  const occupiedColumns: number[] = [];
  glyph.forEach((row, y) => row.forEach((pixel, x) => {
    if (!pixel) return;
    occupiedRows.push(y);
    occupiedColumns.push(x);
  }));
  if (occupiedRows.length < 4) return null;
  const top = Math.min(...occupiedRows);
  const bottom = Math.max(...occupiedRows);
  const left = Math.min(...occupiedColumns);
  const right = Math.max(...occupiedColumns);
  return glyph.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
}

function glyphDistance(source: BinaryGlyph, template: BinaryGlyph): number {
  const sourceHeight = source.length;
  const sourceWidth = source[0]?.length ?? 0;
  if (!sourceHeight || !sourceWidth) return Number.POSITIVE_INFINITY;
  const templateHeight = template.length;
  const templateWidth = template[0].length;
  const resized = Array.from({ length: sourceHeight }, (_, y) =>
    Array.from({ length: sourceWidth }, (_, x) =>
      template[Math.min(templateHeight - 1, Math.floor(((y + 0.5) * templateHeight) / sourceHeight))]
        [Math.min(templateWidth - 1, Math.floor(((x + 0.5) * templateWidth) / sourceWidth))],
    ),
  );
  const directionalDistance = (left: BinaryGlyph, right: BinaryGlyph) => {
    let total = 0;
    let count = 0;
    left.forEach((row, y) => row.forEach((pixel, x) => {
      if (!pixel) return;
      count += 1;
      let nearest = 3;
      for (let searchY = Math.max(0, y - 2); searchY <= Math.min(right.length - 1, y + 2); searchY += 1) {
        for (let searchX = Math.max(0, x - 2); searchX <= Math.min(right[0].length - 1, x + 2); searchX += 1) {
          if (right[searchY][searchX]) {
            nearest = Math.min(nearest, Math.max(Math.abs(searchX - x), Math.abs(searchY - y)));
          }
        }
      }
      total += nearest;
    }));
    return total / Math.max(1, count);
  };
  const sourceAspect = sourceWidth / sourceHeight;
  const templateAspect = templateWidth / templateHeight;
  const aspectPenalty = Math.abs(Math.log(Math.max(0.1, sourceAspect / templateAspect))) * 0.22;
  return directionalDistance(source, resized) + directionalDistance(resized, source) + aspectPenalty;
}

function codeGlyphFromAnalysis(
  analysis: PatternCellAnalysis,
  pixels: Uint8ClampedArray,
  pixelWidth: number,
  contrastThreshold: number,
): BinaryGlyph | null {
  const cellWidth = Math.max(1, analysis.cellRight - analysis.cellLeft);
  const cellHeight = Math.max(1, analysis.cellBottom - analysis.cellTop);
  const left = Math.max(0, Math.floor(analysis.cellLeft + cellWidth * 0.1));
  const right = Math.max(left + 1, Math.ceil(analysis.cellRight - cellWidth * 0.1));
  const top = Math.max(0, Math.floor(analysis.cellTop + cellHeight * 0.18));
  const bottom = Math.max(top + 1, Math.ceil(analysis.cellBottom - cellHeight * 0.18));
  const [backgroundR, backgroundG, backgroundB] = analysis.background;
  const glyph = Array.from({ length: bottom - top }, () => Array.from({ length: right - left }, () => false));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * pixelWidth + x) * 4;
      const contrast = Math.max(
        Math.abs(pixels[offset] - backgroundR),
        Math.abs(pixels[offset + 1] - backgroundG),
        Math.abs(pixels[offset + 2] - backgroundB),
      );
      glyph[y - top][x - left] = pixels[offset + 3] >= 32 && contrast > contrastThreshold;
    }
  }
  return trimGlyph(glyph);
}

interface GlyphPaletteMatch {
  entry: PaletteEntry;
  glyphScore: number;
  combinedScore: number;
}

function aggregateGlyphScore(glyphs: BinaryGlyph[], template: BinaryGlyph): number {
  const glyphScores = glyphs
    .map((glyph) => glyphDistance(glyph, template))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!glyphScores.length) return Number.POSITIVE_INFINITY;
  const keep = Math.max(1, Math.min(5, Math.ceil(glyphScores.length * 0.7)));
  return glyphScores.slice(0, keep).reduce((sum, score) => sum + score, 0) / keep;
}

function matchGlyphToPalette(
  glyphs: BinaryGlyph[],
  sourceHex: string,
  palette: PaletteEntry[],
  colorSystem: ColorSystem,
  texts: string[] = [],
): GlyphPaletteMatch | null {
  if (!glyphs.length) return null;
  const sourceChannels = sourceHex.match(/[0-9A-F]{2}/gi);
  if (!sourceChannels) return null;
  const [sourceR, sourceG, sourceB] = sourceChannels.map((value) => Number.parseInt(value, 16));
  const normalizedTexts = texts
    .map(normalizedBeadCode)
    .filter((text) => /^[A-Z]{1,2}[0-9]{1,3}$/.test(text));
  const partialTexts = texts
    .map(normalizedBeadCode)
    .filter((text) => text.length >= 1 && text.length <= 5);
  let best: GlyphPaletteMatch | null = null;
  for (const entry of palette) {
    const rawCode = entry.codes[colorSystem] || entry.codes.MARD;
    if (!rawCode) continue;
    const code = normalizedBeadCode(rawCode);
    if (!/^[A-Z]{1,2}[0-9]{1,3}$/.test(code)) continue;
    const template = templateForCode(code);
    if (!template) continue;
    const glyphScore = aggregateGlyphScore(glyphs, template);
    if (!Number.isFinite(glyphScore)) continue;
    const entryChannels = entry.hex.match(/[0-9A-F]{2}/gi);
    if (!entryChannels) continue;
    const [entryR, entryG, entryB] = entryChannels.map((value) => Number.parseInt(value, 16));
    const colorDistance = Math.hypot(sourceR - entryR, sourceG - entryG, sourceB - entryB) / 255;
    const ocrDistance = normalizedTexts.length
      ? normalizedTexts
        .map((text) => editDistance(text, code) / Math.max(text.length, code.length, 1))
        .sort((left, right) => left - right)
        .slice(0, 4)
        .reduce((sum, score, _, values) => sum + score / values.length, 0)
      : 0.45;
    const partialOcrDistance = partialTexts.length
      ? partialTexts
        .map((text) => editDistance(text, code) / Math.max(text.length, code.length, 1))
        .sort((left, right) => left - right)
        .slice(0, 4)
        .reduce((sum, score, _, values) => sum + score / values.length, 0)
      : 0.45;
    const exactVotes = normalizedTexts.filter((text) => text === code).length;
    const combinedScore =
      glyphScore +
      colorDistance * 1.7 +
      ocrDistance * 0.7 +
      partialOcrDistance * 0.35 -
      Math.min(0.55, exactVotes * 0.22);
    if (!best || combinedScore < best.combinedScore) best = { entry, glyphScore, combinedScore };
  }
  return best;
}

/**
 * Pure helper used by tests and diagnostics. A null result means the contrast
 * looks like a watermark/speckle rather than a palette code.
 */
export function recognizePrintedCodeGlyph(
  rows: readonly string[],
  sourceHex: string,
  palette: PaletteEntry[],
  colorSystem: ColorSystem,
): PaletteEntry | null {
  const glyph = trimGlyph(rows.map((row) => [...row].map((pixel) => pixel === "#")));
  if (!glyph) return null;
  const match = matchGlyphToPalette([glyph], sourceHex, palette, colorSystem);
  return match && match.glyphScore <= 1.65 ? match.entry : null;
}

function makeCodePatch(
  analysis: PatternCellAnalysis,
  pixels: Uint8ClampedArray,
  pixelWidth: number,
  contrastThreshold = 38,
): HTMLCanvasElement {
  const sourceWidth = Math.max(1, Math.ceil(analysis.cellRight - analysis.cellLeft));
  const sourceHeight = Math.max(1, Math.ceil(analysis.cellBottom - analysis.cellTop));
  const mask = document.createElement("canvas");
  mask.width = sourceWidth;
  mask.height = sourceHeight;
  const maskContext = mask.getContext("2d");
  if (!maskContext) throw new Error("当前浏览器无法创建文字识别画布");
  const imageData = maskContext.createImageData(sourceWidth, sourceHeight);
  imageData.data.fill(255);
  const [backgroundR, backgroundG, backgroundB] = analysis.background;
  for (let y = Math.floor(sourceHeight * 0.18); y < Math.ceil(sourceHeight * 0.82); y += 1) {
    for (let x = Math.floor(sourceWidth * 0.12); x < Math.ceil(sourceWidth * 0.88); x += 1) {
      const sourceX = Math.max(0, Math.floor(analysis.cellLeft) + x);
      const sourceY = Math.max(0, Math.floor(analysis.cellTop) + y);
      const sourceOffset = (sourceY * pixelWidth + sourceX) * 4;
      const contrast = Math.max(
        Math.abs(pixels[sourceOffset] - backgroundR),
        Math.abs(pixels[sourceOffset + 1] - backgroundG),
        Math.abs(pixels[sourceOffset + 2] - backgroundB),
      );
      if (pixels[sourceOffset + 3] >= 32 && contrast > contrastThreshold) {
        const targetOffset = (y * sourceWidth + x) * 4;
        imageData.data[targetOffset] = 0;
        imageData.data[targetOffset + 1] = 0;
        imageData.data[targetOffset + 2] = 0;
      }
    }
  }
  maskContext.putImageData(imageData, 0, 0);
  const patch = document.createElement("canvas");
  patch.width = 230;
  patch.height = 230;
  const patchContext = patch.getContext("2d");
  if (!patchContext) throw new Error("当前浏览器无法创建文字识别画布");
  patchContext.fillStyle = "#FFFFFF";
  patchContext.fillRect(0, 0, patch.width, patch.height);
  patchContext.imageSmoothingEnabled = false;
  patchContext.drawImage(mask, 25, 25, 180, 180);
  return patch;
}

export function bestPaletteEntryForCodes(
  texts: string[],
  initialId: string,
  sourceHex: string,
  palette: PaletteEntry[],
  colorSystem: ColorSystem,
): PaletteEntry {
  const normalizedTexts = texts.map(normalizedBeadCode).filter((text) => text.length >= 1 && text.length <= 5);
  const initial = palette.find((entry) => entry.id === initialId) ?? nearestPaletteEntry(sourceHex, palette);
  if (!normalizedTexts.length) return initial;
  const exactMatches = normalizedTexts
    .map((text) => palette.find((entry) => {
      const rawCode = entry.codes[colorSystem] || entry.codes.MARD;
      return rawCode ? normalizedBeadCode(rawCode) === text : false;
    }))
    .filter((entry): entry is PaletteEntry => Boolean(entry));
  if (exactMatches.length) {
    const counts = new Map<string, number>();
    exactMatches.forEach((entry) => counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1));
    const exactId = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
    return palette.find((entry) => entry.id === exactId) ?? exactMatches[0];
  }
  const [sourceR, sourceG, sourceB] = sourceHex.match(/[0-9A-F]{2}/g)!.map((value) => Number.parseInt(value, 16));
  let best = initial;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const entry of palette) {
    const rawCode = entry.codes[colorSystem] || entry.codes.MARD;
    if (!rawCode) continue;
    const code = normalizedBeadCode(rawCode);
    const ocrDistance = normalizedTexts
      .map((text) => editDistance(text, code) / Math.max(text.length, code.length, 1))
      .sort((a, b) => a - b)
      .slice(0, 3)
      .reduce((sum, value, _, values) => sum + value / values.length, 0);
    const [entryR, entryG, entryB] = entry.hex.match(/[0-9A-F]{2}/g)!.map((value) => Number.parseInt(value, 16));
    const colorDistance = Math.sqrt((sourceR - entryR) ** 2 + (sourceG - entryG) ** 2 + (sourceB - entryB) ** 2) / 255;
    const initialBonus = entry.id === initialId ? -0.04 : 0;
    // Printed text remains the primary signal, while the fill corrects common
    // single-stroke OCR ambiguities such as E16 → EI8/E18.
    const score = ocrDistance * 3 + colorDistance * 2 + initialBonus;
    if (score < bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

async function applyPrintedCodes(
  analyses: PatternCellAnalysis[],
  pixels: Uint8ClampedArray,
  pixelWidth: number,
  palette: PaletteEntry[],
  colorSystem: ColorSystem,
  onStatus?: (status: string) => void,
): Promise<PixelCell[]> {
  const codeCellCount = analyses.filter((analysis) => analysis.hasPrintedCode).length;
  const minimumTextCells = Math.max(3, Math.round(analyses.length * 0.01));
  if (codeCellCount < minimumTextCells) return analyses.map(({ cell }) => cell);

  // In a code-labelled chart, the label is authoritative: no label means no bead.
  const cells = analyses.map((analysis) => analysis.hasPrintedCode ? analysis.cell : { colorId: null, completed: false });
  const groups = new Map<string, number[]>();
  analyses.forEach((analysis, index) => {
    if (!analysis.hasPrintedCode || !analysis.cell.colorId) return;
    const indices = groups.get(analysis.cell.colorId) ?? [];
    indices.push(index);
    groups.set(analysis.cell.colorId, indices);
  });
  onStatus?.(`检测到色号文字，正在识别 ${groups.size} 组颜色…`);

  let recognize: OcradRecognizer | null = null;
  try {
    recognize = await loadOcrad();
  } catch {
    // The dedicated glyph matcher below works offline. OCR is a useful second
    // vote, but must never decide whether a watermark is a bead.
    onStatus?.("通用文字模型暂不可用，改用本地色号字形识别");
  }

  let groupNumber = 0;
  for (const [initialId, indices] of groups) {
    groupNumber += 1;
    onStatus?.(`正在读取色号 ${groupNumber}/${groups.size}…`);
    const inkValues = indices.map((index) => analyses[index].labelInkPixels).sort((left, right) => left - right);
    const medianInk = inkValues[Math.floor(inkValues.length / 2)] ?? 0;
    // Watermarks add far more contrast than a two/three-character code. Cells
    // nearest the group median are therefore safer representatives than the
    // previous "highest ink first" strategy.
    const representatives = [...indices]
      .sort((left, right) =>
        Math.abs(analyses[left].labelInkPixels - medianInk) -
        Math.abs(analyses[right].labelInkPixels - medianInk),
      )
      .slice(0, 8);
    const glyphs = representatives.flatMap((index) =>
      [34, 42, 52]
        .map((threshold) => codeGlyphFromAnalysis(analyses[index], pixels, pixelWidth, threshold))
        .filter((glyph): glyph is BinaryGlyph => Boolean(glyph)),
    );
    const texts: string[] = [];
    if (recognize) {
      for (const index of representatives.slice(0, 4)) {
        for (const threshold of [34, 48]) {
          const text = recognize(makeCodePatch(analyses[index], pixels, pixelWidth, threshold)).trim();
          if (text) texts.push(text);
        }
      }
    }
    const medianBackground = ([0, 1, 2] as const).map((channel) => {
      const values = representatives
        .map((index) => analyses[index].background[channel])
        .sort((left, right) => left - right);
      return values[Math.floor(values.length / 2)] ?? 255;
    }) as [number, number, number];
    const sourceHex = rgbHex(...medianBackground);
    const glyphMatch = matchGlyphToPalette(glyphs, sourceHex, palette, colorSystem, texts);
    const hasValidOcrVote = texts.some((text) => /^[A-Z]{1,2}[0-9]{1,3}$/.test(normalizedBeadCode(text)));
    if (!glyphMatch || (glyphMatch.glyphScore > 1.3 && !hasValidOcrVote)) {
      // Contrast without a plausible palette-code shape is normally a
      // diagonal watermark, app overlay, or screenshot compression speckle.
      indices.forEach((index) => {
        cells[index] = { colorId: null, completed: false };
      });
    } else {
      const matched = glyphMatch.glyphScore <= 1.65
        ? glyphMatch.entry
        : bestPaletteEntryForCodes(texts, initialId, sourceHex, palette, colorSystem);
      const matchedCode = normalizedBeadCode(matched.codes[colorSystem] || matched.codes.MARD || "");
      const matchedTemplate = templateForCode(matchedCode);
      indices.forEach((index) => {
        let colorId = matched.id;
        const cellGlyphs = [34, 42, 52]
          .map((threshold) => codeGlyphFromAnalysis(analyses[index], pixels, pixelWidth, threshold))
          .filter((glyph): glyph is BinaryGlyph => Boolean(glyph));
        const centralGlyph = cellGlyphs[1] ?? cellGlyphs[0];
        const localSourceHex = analyses[index].cell.sourceHex ?? sourceHex;
        const localMatch = cellGlyphs.length
          ? matchGlyphToPalette(cellGlyphs, localSourceHex, palette, colorSystem)
          : null;
        if (!localMatch || localMatch.glyphScore > 1.7) {
          // This individual cell has contrast, but none of the legal palette
          // codes resembles it. Do not let a genuine white-code group turn a
          // watermark crossing otherwise empty cells into extra beads.
          cells[index] = { colorId: null, completed: false };
          return;
        }
        if (matchedTemplate && centralGlyph) {
          const observedAspect = (centralGlyph[0]?.length ?? 1) / Math.max(1, centralGlyph.length);
          const matchedAspect = matchedTemplate[0].length / matchedTemplate.length;
          // A nearest-color bucket can contain two pale codes (notably E16
          // and H2). Different code lengths expose that mixture even when the
          // screenshot colors are indistinguishable.
          if (Math.abs(Math.log(Math.max(0.1, observedAspect / matchedAspect))) > 0.32) {
            const matchedGlyphScore = aggregateGlyphScore(cellGlyphs, matchedTemplate);
            if (
              localMatch.entry.id !== matched.id &&
              localMatch.glyphScore < 1.05 &&
              localMatch.glyphScore + 0.16 < matchedGlyphScore
            ) {
              colorId = localMatch.entry.id;
            }
          }
        }
        cells[index] = { ...cells[index], colorId };
      });
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  return cells;
}

export async function projectFromPatternImage(
  file: File,
  options: PatternGridImportOptions,
  palette = FULL_PALETTE,
): Promise<WorkbenchProject> {
  if (file.size > 40 * 1024 * 1024) throw new Error("图片不能超过 40 MB");
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const maxEdge = 2048;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前浏览器无法识别图纸");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  options.onStatus?.("正在分析网格与色号文字…");
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const analyses = analyzePatternCells(
    pixels,
    canvas.width,
    canvas.height,
    options,
    palette,
  );
  const cells = await applyPrintedCodes(
    analyses,
    pixels,
    canvas.width,
    palette,
    options.colorSystem ?? "MARD",
    options.onStatus,
  );
  const counts = new Map<string, number>();
  cells.forEach((cell) => {
    if (cell.colorId) counts.set(cell.colorId, (counts.get(cell.colorId) ?? 0) + 1);
  });
  const selectedColorId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const width = Math.max(1, Math.min(200, Math.round(options.width)));
  const height = Math.max(1, Math.min(200, Math.round(options.height)));
  return createProject({
    name: `${file.name.replace(/\.[^.]+$/, "") || "成品图纸"}·拼豆`,
    stage: "bead",
    colorSystem: options.colorSystem ?? "MARD",
    palette,
    cells,
    sourceImage: {
      name: file.name,
      mimeType: file.type || "image/png",
      width: image.naturalWidth,
      height: image.naturalHeight,
      dataUrl,
    },
    optimize: {
      width,
      height,
      mode: "dominant",
      mergeTolerance: 8,
      removeBackground: false,
      backgroundColor: "#FFFFFF",
      excludedColorIds: [],
    },
    preview: {
      showGrid: true,
      showSectionLines: true,
      sectionInterval: 10,
      showCoordinates: false,
      showColorCodes: false,
    },
    bead: {
      guidanceMode: "nearest",
      unfinishedOpacity: 28,
      showSectionLines: true,
      sectionInterval: 10,
      showCountHints: true,
      countDirection: "auto",
      selectedColorId,
      activeCellIndex: null,
    },
  });
}

export function parseCsv(text: string, name = "CSV 项目"): WorkbenchProject {
  const rows = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(",").map((value) => value.trim()));
  if (!rows.length || !rows[0].length) throw new Error("CSV 文件为空");
  const width = rows[0].length;
  const height = rows.length;
  if (width > 200 || height > 200) throw new Error("CSV 最大支持 200 × 200 格");
  if (rows.some((row) => row.length !== width)) throw new Error("CSV 每一行的列数必须一致");
  const cells = rows.flatMap((row, y) => row.map((raw, x) => {
    const value = raw.toUpperCase();
    if (!value || value === "TRANSPARENT" || value === "EMPTY") return { colorId: null, completed: false };
    if (!/^#[0-9A-F]{6}$/.test(value)) throw new Error(`第 ${y + 1} 行第 ${x + 1} 列不是有效的 HEX 颜色`);
    return { colorId: nearestPaletteEntry(value).id, completed: false };
  }));
  return createProject({
    name,
    palette: FULL_PALETTE,
    cells,
    optimize: {
      width,
      height,
      mode: "dominant",
      mergeTolerance: 8,
      removeBackground: false,
      backgroundColor: "#FFFFFF",
      excludedColorIds: [],
    },
  });
}

export async function importProjectFile(file: File): Promise<WorkbenchProject> {
  const kind = validateImportFile(file);
  if (kind === "csv") return parseCsv(await file.text(), file.name.replace(/\.csv$/i, ""));
  if (kind === "project") return parseProjectFile(await file.text());
  throw new Error("图片导入需要先选择网格尺寸");
}

export function projectToCsv(project: WorkbenchProject): string {
  const { width, height } = project.optimize;
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < width; x += 1) {
      const cell = project.cells[y * width + x];
      row.push(cell?.colorId ? paletteEntryById(cell.colorId)?.hex ?? "TRANSPARENT" : "TRANSPARENT");
    }
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

export async function renderProjectPng(project: WorkbenchProject, includeCodes = false, includeStats = true): Promise<Blob | null> {
  const { width, height } = project.optimize;
  const cellSize = includeCodes ? 34 : Math.max(8, Math.min(24, Math.floor(1600 / Math.max(width, height))));
  const titleHeight = 64;
  const axisMargin = project.preview.showCoordinates ? 32 : 0;
  const stats = includeStats ? colorStatistics(project) : [];
  const statsColumns = Math.max(1, Math.min(4, Math.floor((width * cellSize + axisMargin) / 180)));
  const statsRows = Math.ceil(stats.length / statsColumns);
  const statsHeight = includeStats ? 52 + statsRows * 30 : 0;
  const canvas = document.createElement("canvas");
  canvas.width = width * cellSize + axisMargin;
  canvas.height = height * cellSize + titleHeight + axisMargin + statsHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#fffdf9";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#2c2724";
  context.font = "600 22px system-ui, sans-serif";
  context.fillText(project.name, 18, 30);
  context.font = "13px system-ui, sans-serif";
  context.fillStyle = "#716862";
  context.fillText(`${width} × ${height} · ${project.colorSystem}`, 18, 51);
  project.cells.forEach((cell, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const entry = paletteEntryById(cell.colorId);
    context.fillStyle = cell.sourceHex ?? entry?.hex ?? "#F7F4EF";
    context.fillRect(axisMargin + x * cellSize, titleHeight + axisMargin + y * cellSize, cellSize, cellSize);
    if (project.preview.showGrid) {
      context.strokeStyle = "rgba(55,45,40,.22)";
      context.lineWidth = 0.6;
      context.strokeRect(axisMargin + x * cellSize, titleHeight + axisMargin + y * cellSize, cellSize, cellSize);
    }
    if (includeCodes && entry) {
      context.fillStyle = contrastColor(entry.hex);
      context.font = "9px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(paletteCode(entry, project.colorSystem), axisMargin + (x + 0.5) * cellSize, titleHeight + axisMargin + (y + 0.5) * cellSize);
    }
  });
  if (axisMargin) {
    const step = Math.max(1, project.preview.sectionInterval);
    context.fillStyle = "#356f9f";
    context.font = "600 10px system-ui, sans-serif";
    context.textBaseline = "middle";
    context.textAlign = "center";
    for (let x = 0; x < width; x += step) {
      context.fillText(String(x + 1), axisMargin + (x + 0.5) * cellSize, titleHeight + axisMargin / 2);
    }
    context.textAlign = "right";
    for (let y = 0; y < height; y += step) {
      context.fillText(String(y + 1), axisMargin - 6, titleHeight + axisMargin + (y + 0.5) * cellSize);
    }
  }
  if (project.preview.showSectionLines && project.preview.sectionInterval > 0) {
    context.strokeStyle = "rgba(43,129,205,.82)";
    context.lineWidth = 1.5;
    context.beginPath();
    for (let x = project.preview.sectionInterval; x < width; x += project.preview.sectionInterval) {
      context.moveTo(axisMargin + x * cellSize, titleHeight + axisMargin);
      context.lineTo(axisMargin + x * cellSize, titleHeight + axisMargin + height * cellSize);
    }
    for (let y = project.preview.sectionInterval; y < height; y += project.preview.sectionInterval) {
      context.moveTo(axisMargin, titleHeight + axisMargin + y * cellSize);
      context.lineTo(axisMargin + width * cellSize, titleHeight + axisMargin + y * cellSize);
    }
    context.stroke();
  }
  if (includeStats) {
    const startY = titleHeight + axisMargin + height * cellSize + 22;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = "#3d3733";
    context.font = "700 14px system-ui, sans-serif";
    context.fillText(`用色统计 · 共 ${project.cells.filter((cell) => cell.colorId).length} 颗`, 12, startY);
    const itemWidth = canvas.width / statsColumns;
    stats.forEach((item, index) => {
      const entry = paletteEntryById(item.id);
      if (!entry) return;
      const column = index % statsColumns;
      const row = Math.floor(index / statsColumns);
      const x = column * itemWidth + 12;
      const y = startY + 28 + row * 30;
      context.fillStyle = entry.hex;
      context.beginPath();
      context.arc(x + 9, y, 8, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = "rgba(0,0,0,.18)";
      context.stroke();
      context.fillStyle = "#49423e";
      context.font = "12px system-ui, sans-serif";
      context.fillText(`${paletteCode(entry, project.colorSystem)}  ${item.count} 颗`, x + 23, y);
    });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function renderProjectThumbnail(project: WorkbenchProject): string | undefined {
  const { width, height } = project.optimize;
  const maxSize = 280;
  const scale = Math.max(1, Math.floor(maxSize / Math.max(width, height)));
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.fillStyle = "#f7f3ee";
  context.fillRect(0, 0, canvas.width, canvas.height);
  project.cells.forEach((cell, index) => {
    const entry = paletteEntryById(cell.colorId);
    if (!entry) return;
    context.fillStyle = cell.sourceHex ?? entry.hex;
    context.fillRect((index % width) * scale, Math.floor(index / width) * scale, scale, scale);
  });
  return canvas.toDataURL("image/png", 0.82);
}

function contrastColor(hex: string): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "#2e2926" : "#ffffff";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

export async function saveImageToPhotos(blob: Blob, filename: string, title: string): Promise<"shared" | "downloaded"> {
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  const shareNavigator = navigator as Navigator & {
    share?: (data: { title?: string; files?: File[] }) => Promise<void>;
    canShare?: (data: { files?: File[] }) => boolean;
  };
  if (
    typeof shareNavigator.share === "function" &&
    typeof shareNavigator.canShare === "function" &&
    shareNavigator.canShare({ files: [file] })
  ) {
    await shareNavigator.share({ title, files: [file] });
    return "shared";
  }
  downloadBlob(file, file.name);
  return "downloaded";
}

export function downloadProject(project: WorkbenchProject, includeSource = true): void {
  const exported = includeSource ? project : { ...project, sourceImage: null };
  downloadBlob(new Blob([serializeProject(exported)], { type: "application/json;charset=utf-8" }), `${safeName(project.name)}.perler`);
}

export function downloadCsv(project: WorkbenchProject): void {
  downloadBlob(new Blob([`\uFEFF${projectToCsv(project)}`], { type: "text/csv;charset=utf-8" }), `${safeName(project.name)}.csv`);
}

export async function shareProject(project: WorkbenchProject): Promise<"shared" | "downloaded"> {
  const file = new File([serializeProject(project)], `${safeName(project.name)}.perler`, {
    type: "application/json",
  });
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    await navigator.share({ title: project.name, text: "我的拼豆图纸项目", files: [file] });
    return "shared";
  }
  downloadBlob(file, file.name);
  return "downloaded";
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "拼豆项目";
}

export function colorStatistics(project: WorkbenchProject): Array<{ id: string; count: number; completed: number }> {
  const counts = new Map<string, { count: number; completed: number }>();
  project.cells.forEach((cell) => {
    if (!cell.colorId) return;
    const current = counts.get(cell.colorId) ?? { count: 0, completed: 0 };
    current.count += 1;
    if (cell.completed) current.completed += 1;
    counts.set(cell.colorId, current);
  });
  return [...counts.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.count - a.count);
}

export function remapExcludedColors(project: WorkbenchProject): WorkbenchProject {
  const excluded = new Set(project.optimize.excludedColorIds);
  if (!excluded.size) return project;
  const candidates = project.palette.filter((entry) => !excluded.has(entry.id));
  if (!candidates.length) return project;
  return {
    ...project,
    cells: project.cells.map((cell) => {
      if (!cell.colorId || !excluded.has(cell.colorId)) return cell;
      const original = paletteEntryById(cell.colorId);
      return original ? { ...cell, colorId: nearestPaletteEntry(original.hex, candidates).id, sourceHex: undefined } : cell;
    }),
    updatedAt: Date.now(),
  };
}

export function mergeSimilarColors(project: WorkbenchProject, tolerance: number): WorkbenchProject {
  const stats = colorStatistics(project);
  const used = stats.map((item) => paletteEntryById(item.id)).filter(Boolean) as NonNullable<ReturnType<typeof paletteEntryById>>[];
  const replacements = new Map<string, string>();
  for (let i = 0; i < used.length; i += 1) {
    if (replacements.has(used[i].id)) continue;
    const base = parseInt(used[i].hex.slice(1), 16);
    const br = (base >> 16) & 255;
    const bg = (base >> 8) & 255;
    const bb = base & 255;
    for (let j = i + 1; j < used.length; j += 1) {
      if (replacements.has(used[j].id)) continue;
      const other = parseInt(used[j].hex.slice(1), 16);
      const distance = Math.sqrt(((other >> 16 & 255) - br) ** 2 + ((other >> 8 & 255) - bg) ** 2 + ((other & 255) - bb) ** 2);
      if (distance <= tolerance * 3) replacements.set(used[j].id, used[i].id);
    }
  }
  return {
    ...project,
    cells: project.cells.map((cell) => cell.colorId && replacements.has(cell.colorId)
      ? { ...cell, colorId: replacements.get(cell.colorId)!, sourceHex: undefined }
      : cell),
    updatedAt: Date.now(),
  };
}

export function projectFromJson(text: string): WorkbenchProject {
  return parseProjectFile(text);
}
