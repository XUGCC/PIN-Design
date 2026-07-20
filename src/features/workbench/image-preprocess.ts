export interface NormalizedCrop {
  /** Left edge in the oriented image, from 0 to 1. */
  x: number;
  /** Top edge in the oriented image, from 0 to 1. */
  y: number;
  /** Width in the oriented image, from 0 to 1. */
  width: number;
  /** Height in the oriented image, from 0 to 1. */
  height: number;
}

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface ImageTransform {
  /**
   * Crop coordinates are measured after rotation and flipping. This makes the
   * same transform usable by the touch editor and by the final image renderer.
   */
  crop: NormalizedCrop;
  rotation: QuarterTurn;
  flipX: boolean;
  flipY: boolean;
}

export interface GridDetectionResult {
  /** Detected outer grid bounds, in pixels of the supplied image. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  columns: number;
  rows: number;
  /** Grid-line centres, in pixels of the supplied image. */
  xLines: number[];
  yLines: number[];
  /** A conservative value from 0 to 1. */
  confidence: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface ProcessedImage {
  file: File;
  dataUrl: string;
  width: number;
  height: number;
  transform: ImageTransform;
}

export interface GridDetectionOptions {
  minCells?: number;
  maxCells?: number;
}

type ImageDataLike = Pick<ImageData, "data" | "width" | "height">;
type CanvasLike = Pick<HTMLCanvasElement, "width" | "height" | "getContext">;

interface AxisDetection {
  lines: number[];
  pitch: number;
  correlation: number;
  regularity: number;
  strength: number;
}

interface PitchCandidate {
  pitch: number;
  correlation: number;
  score: number;
}

const FULL_CROP: NormalizedCrop = { x: 0, y: 0, width: 1, height: 1 };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedQuarterTurn(value: number): QuarterTurn {
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return normalized as QuarterTurn;
}

export function normalizeCrop(crop: Partial<NormalizedCrop> | undefined): NormalizedCrop {
  const x = clamp(Number(crop?.x) || 0, 0, 0.999);
  const y = clamp(Number(crop?.y) || 0, 0, 0.999);
  const width = clamp(Number(crop?.width) || 1, 0.001, 1 - x);
  const height = clamp(Number(crop?.height) || 1, 0.001, 1 - y);
  return { x, y, width, height };
}

/**
 * Derives square-bead grid dimensions while preserving the image aspect ratio.
 * `detail` is the number of cells along the longer side.
 */
export function deriveGridSize(
  imageWidth: number,
  imageHeight: number,
  detail: number,
  maximum = 200,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Number(imageWidth) || 1);
  const safeHeight = Math.max(1, Number(imageHeight) || 1);
  const safeMaximum = Math.max(1, Math.round(Number(maximum) || 200));
  const longEdge = clamp(Math.round(Number(detail) || 1), 1, safeMaximum);
  if (safeWidth >= safeHeight) {
    return {
      width: longEdge,
      height: clamp(Math.round(longEdge * safeHeight / safeWidth), 1, safeMaximum),
    };
  }
  return {
    width: clamp(Math.round(longEdge * safeWidth / safeHeight), 1, safeMaximum),
    height: longEdge,
  };
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))] ?? 0;
}

function projectionProminence(projection: number[]): number[] {
  const result = Array.from({ length: projection.length }, () => 0);
  for (let index = 0; index < projection.length; index += 1) {
    let total = 0;
    let count = 0;
    // A 13-pixel moving background works for both dense 8px screenshot
    // grids and larger 20–30px charts. Sampling only a few offsets can land
    // on neighbouring grid lines and accidentally erase the true base pitch.
    for (
      let sample = Math.max(0, index - 6);
      sample <= Math.min(projection.length - 1, index + 6);
      sample += 1
    ) {
      total += projection[sample];
      count += 1;
    }
    const localBackground = count ? total / count : projection[index];
    result[index] = Math.max(0, projection[index] - localBackground);
  }
  return result;
}

function normalizedAutocorrelation(signal: number[], lag: number): number {
  let product = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index + lag < signal.length; index += 1) {
    const left = signal[index];
    const right = signal[index + lag];
    product += left * right;
    leftSquare += left * left;
    rightSquare += right * right;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 1e-9 ? product / denominator : 0;
}

function pitchCandidates(
  signal: number[],
  options: Required<GridDetectionOptions>,
): PitchCandidate[] {
  const minimumPitch = Math.max(4, Math.floor(signal.length / (options.maxCells * 1.08)));
  const maximumPitch = Math.max(
    minimumPitch,
    Math.min(512, Math.floor(signal.length / Math.max(2, options.minCells))),
  );
  const correlations = Array.from({ length: maximumPitch + 1 }, () => 0);
  for (let pitch = minimumPitch; pitch <= maximumPitch; pitch += 1) {
    correlations[pitch] = Math.max(0, normalizedAutocorrelation(signal, pitch));
  }
  const rawCandidates: PitchCandidate[] = [];
  for (let pitch = minimumPitch; pitch <= maximumPitch; pitch += 1) {
    const correlation = correlations[pitch];
    if (
      correlation < 0.075
      || correlation < (correlations[pitch - 1] ?? 0)
      || correlation < (correlations[pitch + 1] ?? 0)
    ) continue;
    const harmonics: number[] = [];
    for (
      let multiple = 2;
      multiple <= 16 && Math.round(pitch * multiple) <= maximumPitch;
      multiple += 1
    ) {
      const centre = Math.round(pitch * multiple);
      harmonics.push(Math.max(
        correlations[centre - 1] ?? 0,
        correlations[centre] ?? 0,
        correlations[centre + 1] ?? 0,
      ));
    }
    const usefulHarmonics = harmonics.filter((value) => value >= Math.max(0.09, correlation * 0.3));
    const harmonicMean = usefulHarmonics.length
      ? usefulHarmonics.reduce((total, value) => total + value, 0) / usefulHarmonics.length
      : 0;
    const periods = signal.length / pitch;
    const score = (
      correlation * 0.48
      + harmonicMean * 0.3
      + Math.min(1, usefulHarmonics.length / 6) * 0.14
      + Math.min(1, periods / 24) * 0.08
    );
    rawCandidates.push({ pitch, correlation, score });
  }
  if (!rawCandidates.length) return [];
  const bestCorrelation = Math.max(...rawCandidates.map(({ correlation }) => correlation));
  // Thick section dividers every five or ten cells often have the strongest
  // autocorrelation. The true cell pitch is the earliest local maximum that
  // still carries at least 55% of the strongest periodic evidence. This
  // deliberately turns the common 2×/5×/10× divider harmonics back into one
  // bead cell.
  const fundamentals = rawCandidates
    .filter(({ correlation }) => correlation >= Math.max(0.09, bestCorrelation * 0.55))
    .sort((left, right) => left.pitch - right.pitch);
  const selected = fundamentals[0] ?? [...rawCandidates].sort((left, right) => right.score - left.score)[0];
  return [
    selected,
    ...rawCandidates
      .filter(({ pitch }) => pitch !== selected.pitch)
      .sort((left, right) => right.score - left.score),
  ];
}

function snappedLine(signal: number[], position: number, tolerance: number): { position: number; value: number } {
  const centre = Math.round(position);
  const radius = Math.max(1, Math.round(tolerance));
  let bestPosition = clamp(centre, 0, signal.length - 1);
  let bestValue = signal[bestPosition] ?? 0;
  for (
    let candidate = Math.max(0, centre - radius);
    candidate <= Math.min(signal.length - 1, centre + radius);
    candidate += 1
  ) {
    if ((signal[candidate] ?? 0) > bestValue) {
      bestPosition = candidate;
      bestValue = signal[candidate] ?? 0;
    }
  }
  return { position: bestPosition, value: bestValue };
}

function bestLatticeWindow(
  signal: number[],
  runProjection: number[],
  pitch: number,
  options: Required<GridDetectionOptions>,
): { lines: number[]; score: number } | null {
  const tolerance = Math.max(1, pitch * 0.16);
  const phaseSteps = Math.max(4, Math.round(pitch * 2));
  const maximumSignal = Math.max(...signal, 1e-9);
  const hardSupportThreshold = Math.max(
    0.003,
    maximumSignal * 0.075,
    percentile(signal, 0.84),
  );
  const runSupportThreshold = Math.max(
    0.11,
    percentile(runProjection, 0.82) * 0.48,
  );
  let best: { lines: number[]; score: number } | null = null;
  for (let phaseStep = 0; phaseStep < phaseSteps; phaseStep += 1) {
    const phase = phaseStep * pitch / phaseSteps;
    const lattice: Array<{ position: number; value: number }> = [];
    for (let position = phase; position < signal.length; position += pitch) {
      lattice.push(snappedLine(signal, position, tolerance));
    }
    if (lattice.length < options.minCells + 1) continue;
    const values = lattice.map(({ value }) => value);
    const positive = values.filter((value) => value > 1e-7);
    if (positive.length < options.minCells + 1) continue;
    const scale = Math.max(
      percentile(positive, 0.72),
      percentile(signal, 0.82),
      1e-6,
    );
    const normalized = values.map((value) => clamp(value / scale, 0, 1.25));
    const hardSupport = values.map((value) => value >= hardSupportThreshold);
    const runSupport = lattice.map(({ position }) => (
      (runProjection[position] ?? 0) >= runSupportThreshold
    ));
    const maximumLines = Math.min(lattice.length, options.maxCells + 3);
    for (let start = 0; start < lattice.length; start += 1) {
      let total = 0;
      let supported = 0;
      let hardSupported = 0;
      let runSupported = 0;
      for (
        let end = start;
        end < lattice.length && end - start + 1 <= maximumLines;
        end += 1
      ) {
        total += normalized[end];
        if (normalized[end] >= 0.2) supported += 1;
        if (hardSupport[end]) hardSupported += 1;
        if (runSupport[end]) runSupported += 1;
        const lineCount = end - start + 1;
        if (lineCount < options.minCells + 1) continue;
        const average = total / lineCount;
        const supportRatio = supported / lineCount;
        const boundary = (normalized[start] + normalized[end]) / 2;
        const hardSupportRatio = hardSupported / lineCount;
        const runSupportRatio = runSupported / lineCount;
        if (
          supportRatio < 0.26
          || hardSupportRatio < 0.24
          || runSupportRatio < 0.48
          || average < 0.14
        ) continue;
        // Grid artwork can hide many thin lines while the 5/10-cell dividers
        // remain visible. Prefer the largest reasonably supported lattice;
        // otherwise a dark character or watermark wins as a smaller,
        // deceptively high-contrast grid.
        const score = (
          runSupported * 1.08
          - (lineCount - runSupported) * 0.74
          + hardSupported * 0.22
          + average * 1.4
          + supportRatio
          + Math.min(1.25, boundary) * 0.5
        );
        if (best && score <= best.score) continue;
        const rawLines = lattice.slice(start, end + 1).map(({ position }) => position);
        const uniqueLines = rawLines.filter((position, index) => index === 0 || position > rawLines[index - 1]);
        if (uniqueLines.length >= options.minCells + 1) best = { lines: uniqueLines, score };
      }
    }
  }
  return best;
}

function detectAxis(
  projection: number[],
  options: Required<GridDetectionOptions>,
  preferredPitch?: number,
): AxisDetection | null {
  const signal = projectionProminence(projection);
  const candidates = pitchCandidates(signal, options);
  if (!candidates.length) return null;
  const ordered = preferredPitch
    ? [...candidates].sort((left, right) => {
      const leftDistance = Math.abs(left.pitch - preferredPitch) / Math.max(1, preferredPitch);
      const rightDistance = Math.abs(right.pitch - preferredPitch) / Math.max(1, preferredPitch);
      return (leftDistance - rightDistance) || (right.score - left.score);
    })
    : candidates;
  let fitted: { lines: number[]; score: number; candidate: PitchCandidate } | null = null;
  for (const candidate of ordered.slice(0, 8)) {
    if (preferredPitch && Math.abs(candidate.pitch - preferredPitch) / preferredPitch > 0.28) continue;
    const window = bestLatticeWindow(signal, projection, candidate.pitch, options);
    if (!window) continue;
    const fundamentalPitch = ordered[0]?.pitch ?? candidate.pitch;
    const pitchDistance = Math.abs(candidate.pitch - fundamentalPitch) / Math.max(1, fundamentalPitch);
    const fundamentalWeight = candidate.pitch === fundamentalPitch
      ? 1.28
      : clamp(1 - pitchDistance * 0.55, 0.36, 0.95);
    const score = window.score * (0.72 + candidate.score * 0.28) * fundamentalWeight;
    if (!fitted || score > fitted.score) fitted = { ...window, score, candidate };
  }
  if (!fitted) return null;
  const lines = fitted.lines;

  const differences = lines.slice(1).map((position, index) => position - lines[index]);
  const meanPitch = differences.reduce((total, value) => total + value, 0) / differences.length;
  const variance = differences.reduce((total, value) => total + (value - meanPitch) ** 2, 0) / differences.length;
  const regularity = clamp(1 - Math.sqrt(variance) / Math.max(1, meanPitch), 0, 1);
  const maximumSignal = Math.max(...signal, 1e-9);
  const strength = clamp(
    lines.reduce((total, position) => total + signal[position], 0) / lines.length / maximumSignal,
    0,
    1,
  );
  return {
    lines,
    pitch: meanPitch,
    correlation: clamp(fitted.candidate.correlation, 0, 1),
    regularity,
    strength,
  };
}

function imageDataFromSource(source: ImageDataLike | CanvasLike): ImageDataLike | null {
  if ("data" in source) return source;
  const context = source.getContext("2d", { willReadFrequently: true });
  return context?.getImageData(0, 0, source.width, source.height) ?? null;
}

/**
 * A grid line is long in one direction even when it is faint. Full-screen UI,
 * artwork and watermarks can be dark too, but usually form short or broad
 * shapes. Measuring the longest dark run per column/row and then applying the
 * normal local-prominence filter isolates the thin orthogonal lattice much
 * better than averaging all dark pixels in a screenshot.
 */
function darkRunProjections(image: ImageDataLike): {
  vertical: number[];
  horizontal: number[];
  verticalStarts: number[];
  verticalEnds: number[];
  horizontalStarts: number[];
  horizontalEnds: number[];
} {
  const vertical = Array.from({ length: image.width }, () => 0);
  const horizontal = Array.from({ length: image.height }, () => 0);
  const verticalStarts = Array.from({ length: image.width }, () => 0);
  const verticalEnds = Array.from({ length: image.width }, () => 0);
  const horizontalStarts = Array.from({ length: image.height }, () => 0);
  const horizontalEnds = Array.from({ length: image.height }, () => 0);
  const columnStarts = Array.from({ length: image.width }, () => -1);
  const columnLastDark = Array.from({ length: image.width }, () => -99);
  const columnBest = Array.from({ length: image.width }, () => 0);
  for (let y = 0; y < image.height; y += 1) {
    let rowStart = -1;
    let rowLastDark = -99;
    let rowBest = 0;
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const luminance = (
        image.data[offset] * 0.2126
        + image.data[offset + 1] * 0.7152
        + image.data[offset + 2] * 0.0722
      );
      // Compression and social-app screenshots often lift thin grey grid
      // lines above RGB 205. A slightly wider threshold keeps those lines
      // continuous without turning the near-white page background into one
      // large run.
      const dark = image.data[offset + 3] >= 16 && luminance < 215;
      if (dark) {
        if (rowStart < 0 || x - rowLastDark > 4) rowStart = x;
        rowLastDark = x;
        const rowLength = x - rowStart + 1;
        if (rowLength > rowBest) {
          rowBest = rowLength;
          horizontalStarts[y] = rowStart;
          horizontalEnds[y] = x;
        }
        if (columnStarts[x] < 0 || y - columnLastDark[x] > 4) columnStarts[x] = y;
        columnLastDark[x] = y;
        const columnLength = y - columnStarts[x] + 1;
        if (columnLength > columnBest[x]) {
          columnBest[x] = columnLength;
          verticalStarts[x] = columnStarts[x];
          verticalEnds[x] = y;
        }
      } else {
        if (rowStart >= 0 && x - rowLastDark > 3) rowStart = -1;
        if (columnStarts[x] >= 0 && y - columnLastDark[x] > 3) columnStarts[x] = -1;
      }
    }
    horizontal[y] = rowBest / Math.max(1, image.width);
  }
  for (let x = 0; x < image.width; x += 1) {
    vertical[x] = columnBest[x] / Math.max(1, image.height);
  }
  return {
    vertical,
    horizontal,
    verticalStarts,
    verticalEnds,
    horizontalStarts,
    horizontalEnds,
  };
}

function bandStandardDeviation(
  data: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  const startX = clamp(Math.ceil(left), 0, imageWidth - 1);
  const endX = clamp(Math.floor(right), startX + 1, imageWidth);
  const startY = clamp(Math.ceil(top), 0, imageHeight - 1);
  const endY = clamp(Math.floor(bottom), startY + 1, imageHeight);
  const stepX = Math.max(1, Math.floor((endX - startX) / 40));
  const stepY = Math.max(1, Math.floor((endY - startY) / 80));
  let total = 0;
  let squareTotal = 0;
  let count = 0;
  for (let y = startY; y < endY; y += stepY) {
    for (let x = startX; x < endX; x += stepX) {
      const offset = (y * imageWidth + x) * 4;
      const luminance = (
        data[offset] * 0.2126
        + data[offset + 1] * 0.7152
        + data[offset + 2] * 0.0722
      ) / 255;
      total += luminance;
      squareTotal += luminance * luminance;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = total / count;
  return Math.sqrt(Math.max(0, squareTotal / count - mean * mean));
}

/**
 * Coordinate-labelled charts often have one extra regular strip on all four
 * sides. It looks like another grid row/column geometrically, but its nearly
 * uniform grey background has much lower variance than the artwork beside it.
 */
function trimSymmetricCoordinateBands(
  xLines: number[],
  yLines: number[],
  image: ImageDataLike,
): { xLines: number[]; yLines: number[] } {
  let trimmedX = xLines;
  let trimmedY = yLines;
  if (xLines.length >= 5 && yLines.length >= 3) {
    const verticalTop = yLines[Math.min(1, yLines.length - 1)];
    const verticalBottom = yLines[Math.max(0, yLines.length - 2)];
    const outerLeft = bandStandardDeviation(image.data, image.width, image.height, xLines[0], verticalTop, xLines[1], verticalBottom);
    const innerLeft = bandStandardDeviation(image.data, image.width, image.height, xLines[1], verticalTop, xLines[2], verticalBottom);
    const outerRight = bandStandardDeviation(image.data, image.width, image.height, xLines.at(-2)!, verticalTop, xLines.at(-1)!, verticalBottom);
    const innerRight = bandStandardDeviation(image.data, image.width, image.height, xLines.at(-3)!, verticalTop, xLines.at(-2)!, verticalBottom);
    if (
      outerLeft > 0.04
      && outerRight > 0.04
      && outerLeft < 0.3
      && outerRight < 0.3
      && outerLeft < innerLeft * 0.72
      && outerRight < innerRight * 0.72
    ) trimmedX = xLines.slice(1, -1);
  }
  if (yLines.length >= 5 && trimmedX.length >= 3) {
    const horizontalLeft = trimmedX[Math.min(1, trimmedX.length - 1)];
    const horizontalRight = trimmedX[Math.max(0, trimmedX.length - 2)];
    const outerTop = bandStandardDeviation(image.data, image.width, image.height, horizontalLeft, yLines[0], horizontalRight, yLines[1]);
    const innerTop = bandStandardDeviation(image.data, image.width, image.height, horizontalLeft, yLines[1], horizontalRight, yLines[2]);
    const outerBottom = bandStandardDeviation(image.data, image.width, image.height, horizontalLeft, yLines.at(-2)!, horizontalRight, yLines.at(-1)!);
    const innerBottom = bandStandardDeviation(image.data, image.width, image.height, horizontalLeft, yLines.at(-3)!, horizontalRight, yLines.at(-2)!);
    if (
      outerTop > 0.04
      && outerBottom > 0.04
      && outerTop < 0.3
      && outerBottom < 0.3
      && outerTop < innerTop * 0.72
      && outerBottom < innerBottom * 0.72
    ) trimmedY = yLines.slice(1, -1);
  }
  return { xLines: trimmedX, yLines: trimmedY };
}

/**
 * A detected horizontal grid line usually runs from the real left border to
 * the real right border (and vice versa). Use those perpendicular run
 * endpoints to recover faint blank margins that a contrast-only lattice
 * window may omit in screenshots.
 */
function linesFromCrossRuns(
  sampleLines: number[],
  runStarts: number[],
  runEnds: number[],
  targetProjection: number[],
  pitch: number,
  options: Required<GridDetectionOptions>,
): number[] | null {
  const targetSize = targetProjection.length;
  const runs = sampleLines
    .map((line) => {
      const index = clamp(Math.round(line), 0, runStarts.length - 1);
      const start = runStarts[index] ?? 0;
      const end = runEnds[index] ?? 0;
      return { start, end, span: Math.max(0, end - start) };
    })
    .filter(({ span }) => span >= targetSize * 0.18);
  if (runs.length < Math.max(4, Math.ceil(sampleLines.length * 0.22))) return null;
  const strongSpan = Math.max(targetSize * 0.2, percentile(runs.map(({ span }) => span), 0.7) * 0.72);
  const strongRuns = runs.filter(({ span }) => span >= strongSpan);
  if (strongRuns.length < 3) return null;
  const start = percentile(strongRuns.map((run) => run.start), 0.18);
  const end = percentile(strongRuns.map((run) => run.end), 0.82);
  const span = end - start;
  const cells = Math.round(span / Math.max(1, pitch));
  if (
    cells < options.minCells
    || cells > options.maxCells + 2
    || span < pitch * options.minCells * 0.8
  ) return null;
  const fittedPitch = span / Math.max(1, cells);
  const signal = projectionProminence(targetProjection);
  const tolerance = Math.max(1, fittedPitch * 0.18);
  const lines = Array.from({ length: cells + 1 }, (_, index) => (
    snappedLine(signal, start + fittedPitch * index, tolerance).position
  ));
  const unique = lines.filter((position, index) => index === 0 || position > lines[index - 1]);
  return unique.length >= options.minCells + 1 ? unique : null;
}

/**
 * Detects an axis-aligned bead grid using long-line projections followed by a
 * periodicity score. The function is deliberately pure for use in workers and
 * tests; a Canvas can also be supplied as a convenience.
 */
export function detectBeadGrid(
  source: ImageDataLike | CanvasLike,
  options: GridDetectionOptions = {},
): GridDetectionResult | null {
  const image = imageDataFromSource(source);
  if (!image || image.width < 8 || image.height < 8 || image.data.length < image.width * image.height * 4) return null;
  const resolvedOptions: Required<GridDetectionOptions> = {
    minCells: clamp(Math.round(options.minCells ?? 3), 2, 200),
    maxCells: clamp(Math.round(options.maxCells ?? 200), 2, 200),
  };
  if (resolvedOptions.maxCells < resolvedOptions.minCells) {
    resolvedOptions.maxCells = resolvedOptions.minCells;
  }

  const {
    vertical: verticalProjection,
    horizontal: horizontalProjection,
    verticalStarts,
    verticalEnds,
    horizontalStarts,
    horizontalEnds,
  } = darkRunProjections(image);

  const horizontalAxis = detectAxis(verticalProjection, resolvedOptions);
  const verticalAxis = detectAxis(horizontalProjection, resolvedOptions);
  if (!horizontalAxis || !verticalAxis) return null;
  const crossRunXLines = linesFromCrossRuns(
    verticalAxis.lines,
    horizontalStarts,
    horizontalEnds,
    verticalProjection,
    horizontalAxis.pitch,
    resolvedOptions,
  );
  const crossRunYLines = linesFromCrossRuns(
    horizontalAxis.lines,
    verticalStarts,
    verticalEnds,
    horizontalProjection,
    verticalAxis.pitch,
    resolvedOptions,
  );
  const trimmed = trimSymmetricCoordinateBands(
    crossRunXLines ?? horizontalAxis.lines,
    crossRunYLines ?? verticalAxis.lines,
    image,
  );
  if (
    trimmed.xLines.length < resolvedOptions.minCells + 1
    || trimmed.yLines.length < resolvedOptions.minCells + 1
  ) return null;

  const coverage = clamp(
    Math.min(trimmed.xLines.length - 1, trimmed.yLines.length - 1) / 16,
    0,
    1,
  );
  const confidence = clamp(
    (horizontalAxis.correlation + verticalAxis.correlation) * 0.24
    + (horizontalAxis.regularity + verticalAxis.regularity) * 0.18
    + (horizontalAxis.strength + verticalAxis.strength) * 0.06
    + coverage * 0.04,
    0,
    1,
  );
  return {
    left: trimmed.xLines[0],
    top: trimmed.yLines[0],
    right: trimmed.xLines.at(-1)!,
    bottom: trimmed.yLines.at(-1)!,
    columns: trimmed.xLines.length - 1,
    rows: trimmed.yLines.length - 1,
    xLines: trimmed.xLines,
    yLines: trimmed.yLines,
    confidence,
    sourceWidth: image.width,
    sourceHeight: image.height,
  };
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片文件"));
    reader.readAsDataURL(file);
  });
}

function dataUrlAsImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法解码"));
    image.src = dataUrl;
  });
}

function canvasAsBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("浏览器无法生成处理后的 PNG"));
    }, "image/png");
  });
}

function drawOrientedImage(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  orientedWidth: number,
  orientedHeight: number,
  transform: Pick<ImageTransform, "rotation" | "flipX" | "flipY">,
  offsetX = 0,
  offsetY = 0,
): void {
  context.save();
  context.translate(offsetX + orientedWidth / 2, offsetY + orientedHeight / 2);
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  context.rotate(transform.rotation * Math.PI / 180);
  context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  context.restore();
}

/**
 * Applies rotation/flipping first, then crops in the resulting orientation.
 */
export async function transformImageFile(
  file: File,
  rawTransform: ImageTransform,
): Promise<ProcessedImage> {
  const dataUrl = await fileAsDataUrl(file);
  const image = await dataUrlAsImage(dataUrl);
  const rotation = normalizedQuarterTurn(rawTransform.rotation);
  const transform: ImageTransform = {
    crop: normalizeCrop(rawTransform.crop ?? FULL_CROP),
    rotation,
    flipX: Boolean(rawTransform.flipX),
    flipY: Boolean(rawTransform.flipY),
  };
  const sourceWidth = Math.max(1, image.naturalWidth);
  const sourceHeight = Math.max(1, image.naturalHeight);
  const orientedWidth = rotation === 90 || rotation === 270 ? sourceHeight : sourceWidth;
  const orientedHeight = rotation === 90 || rotation === 270 ? sourceWidth : sourceHeight;
  const cropX = Math.floor(transform.crop.x * orientedWidth);
  const cropY = Math.floor(transform.crop.y * orientedHeight);
  const outputWidth = Math.max(1, Math.round(transform.crop.width * orientedWidth));
  const outputHeight = Math.max(1, Math.round(transform.crop.height * orientedHeight));
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("当前浏览器无法处理图片");
  context.clearRect(0, 0, outputWidth, outputHeight);
  drawOrientedImage(
    context,
    image,
    sourceWidth,
    sourceHeight,
    orientedWidth,
    orientedHeight,
    transform,
    -cropX,
    -cropY,
  );
  const blob = await canvasAsBlob(canvas);
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  const processedFile = new File([blob], `${baseName}-edited.png`, { type: "image/png" });
  return {
    file: processedFile,
    dataUrl: canvas.toDataURL("image/png"),
    width: outputWidth,
    height: outputHeight,
    transform,
  };
}
