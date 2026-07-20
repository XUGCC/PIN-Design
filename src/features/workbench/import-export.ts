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
  width: number,
  height: number,
  mode: PixelationMode = "dominant",
  palette = FULL_PALETTE,
): Promise<WorkbenchProject> {
  if (file.size > 40 * 1024 * 1024) throw new Error("图片不能超过 40 MB");
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
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
  const commonOcrConfusions = ["I1LT7", "O0Q4", "S5", "G68B", "Z2P", "NMH", "VY"];
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

function makeCodePatch(
  analysis: PatternCellAnalysis,
  pixels: Uint8ClampedArray,
  pixelWidth: number,
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
      if (pixels[sourceOffset + 3] >= 32 && contrast > 38) {
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

function bestPaletteEntryForCodes(
  texts: string[],
  initialId: string,
  sourceHex: string,
  palette: PaletteEntry[],
  colorSystem: ColorSystem,
): PaletteEntry {
  const normalizedTexts = texts.map(normalizedBeadCode).filter((text) => text.length >= 1 && text.length <= 5);
  const initial = palette.find((entry) => entry.id === initialId) ?? nearestPaletteEntry(sourceHex, palette);
  if (!normalizedTexts.length) return initial;
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
    const initialBonus = entry.id === initialId ? -0.12 : 0;
    const score = ocrDistance * 2 + colorDistance * 2 + initialBonus;
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

  try {
    const recognize = await loadOcrad();
    let groupNumber = 0;
    for (const [initialId, indices] of groups) {
      groupNumber += 1;
      onStatus?.(`正在读取色号 ${groupNumber}/${groups.size}…`);
      const representatives = [...indices]
        .sort((left, right) => analyses[right].labelInkPixels - analyses[left].labelInkPixels)
        .slice(0, 4);
      const texts: string[] = [];
      for (const index of representatives) {
        const text = recognize(makeCodePatch(analyses[index], pixels, pixelWidth)).trim();
        if (text) texts.push(text);
      }
      const sample = analyses[indices[0]].cell;
      if (!sample.colorId || !sample.sourceHex) continue;
      const matched = bestPaletteEntryForCodes(texts, initialId, sample.sourceHex, palette, colorSystem);
      indices.forEach((index) => {
        cells[index] = { ...cells[index], colorId: matched.id };
      });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  } catch {
    // Text presence still determines occupied cells. Color matching remains a
    // safe fallback when the OCR model cannot load on a particular phone.
    onStatus?.("文字模型暂不可用，已保留文字格并按颜色纠错");
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
