const MOBILE_MAX_BACKING_PIXELS = 8_000_000;
const MOBILE_MAX_BACKING_DIMENSION = 3_072;
const DESKTOP_MAX_BACKING_PIXELS = 18_000_000;
const DESKTOP_MAX_BACKING_DIMENSION = 8_192;

export function canvasBackingScale(
  logicalWidth: number,
  logicalHeight: number,
  devicePixelRatio: number,
  coarsePointer: boolean,
): number {
  const width = Math.max(1, logicalWidth);
  const height = Math.max(1, logicalHeight);
  const maxPixels = coarsePointer ? MOBILE_MAX_BACKING_PIXELS : DESKTOP_MAX_BACKING_PIXELS;
  const maxDimension = coarsePointer ? MOBILE_MAX_BACKING_DIMENSION : DESKTOP_MAX_BACKING_DIMENSION;
  const pixelScale = Math.sqrt(maxPixels / (width * height));
  const dimensionScale = maxDimension / Math.max(width, height);
  return Math.max(
    0.01,
    Math.min(Math.max(0.5, devicePixelRatio || 1), 2, pixelScale, dimensionScale),
  );
}

