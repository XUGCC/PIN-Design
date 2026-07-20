"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  deriveGridSize,
  detectBeadGrid,
  normalizeCrop,
  transformImageFile,
  type GridDetectionResult,
  type ImageTransform,
  type NormalizedCrop,
  type ProcessedImage,
  type QuarterTurn,
} from "./image-preprocess";

export interface ImagePreprocessDraft {
  file: File;
  dataUrl: string;
  imageWidth: number;
  imageHeight: number;
}

export interface ImagePreprocessCompleteResult {
  processed: ProcessedImage;
  detail: number;
  grid: GridDetectionResult | null;
  transform: ImageTransform;
}

export interface ImagePreprocessEditorProps {
  draft: ImagePreprocessDraft;
  mode: "photo" | "pattern";
  initialDetail: number;
  onCancel: () => void;
  onComplete: (result: ImagePreprocessCompleteResult) => void | Promise<void>;
}

type DragHandle = "move" | "north-west" | "north-east" | "south-west" | "south-east";

interface DragState {
  pointerId: number;
  handle: DragHandle;
  startClientX: number;
  startClientY: number;
  startCrop: NormalizedCrop;
}

const FULL_CROP: NormalizedCrop = { x: 0, y: 0, width: 1, height: 1 };

const HANDLE_STYLES: Record<Exclude<DragHandle, "move">, CSSProperties> = {
  "north-west": { left: 0, top: 0, cursor: "nwse-resize" },
  "north-east": { right: 0, top: 0, cursor: "nesw-resize" },
  "south-west": { left: 0, bottom: 0, cursor: "nesw-resize" },
  "south-east": { right: 0, bottom: 0, cursor: "nwse-resize" },
};

const HANDLE_LABELS: Record<Exclude<DragHandle, "move">, string> = {
  "north-west": "拖动左上角裁剪",
  "north-east": "拖动右上角裁剪",
  "south-west": "拖动左下角裁剪",
  "south-east": "拖动右下角裁剪",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function nextRotation(rotation: QuarterTurn): QuarterTurn {
  return ((rotation + 90) % 360) as QuarterTurn;
}

function drawPreview(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  transform: Pick<ImageTransform, "rotation" | "flipX" | "flipY">,
): void {
  const sourceWidth = Math.max(1, image.naturalWidth);
  const sourceHeight = Math.max(1, image.naturalHeight);
  const swapsDimensions = transform.rotation === 90 || transform.rotation === 270;
  const orientedWidth = swapsDimensions ? sourceHeight : sourceWidth;
  const orientedHeight = swapsDimensions ? sourceWidth : sourceHeight;
  // Keep enough native resolution for dense 80–120 cell screenshots. At
  // 1200 px the grid pitch of a 52-row chart could collapse to every second
  // line after resampling; 2048 px stays accurate while remaining practical
  // for a one-off mobile import.
  const scale = Math.min(1, 2048 / Math.max(orientedWidth, orientedHeight));
  canvas.width = Math.max(1, Math.round(orientedWidth * scale));
  canvas.height = Math.max(1, Math.round(orientedHeight * scale));
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("当前浏览器无法创建图片编辑画布");
  context.fillStyle = "#F2EEE9";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  context.rotate(transform.rotation * Math.PI / 180);
  context.drawImage(
    image,
    -sourceWidth * scale / 2,
    -sourceHeight * scale / 2,
    sourceWidth * scale,
    sourceHeight * scale,
  );
  context.restore();
}

function closestGridLine(
  value: number,
  lines: number[],
  sourceSize: number,
  threshold: number,
): number {
  if (!lines.length || sourceSize <= 0) return value;
  let best = value;
  let bestDistance = threshold;
  for (const line of lines) {
    const normalized = line / sourceSize;
    const distance = Math.abs(normalized - value);
    if (distance <= bestDistance) {
      best = normalized;
      bestDistance = distance;
    }
  }
  return best;
}

function gridAfterCrop(
  grid: GridDetectionResult | null,
  crop: NormalizedCrop,
  outputWidth: number,
  outputHeight: number,
): GridDetectionResult | null {
  if (!grid) return null;
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  const epsilonX = 1.5 / Math.max(1, grid.sourceWidth);
  const epsilonY = 1.5 / Math.max(1, grid.sourceHeight);
  const xLines = grid.xLines
    .map((line) => line / grid.sourceWidth)
    .filter((line) => line >= crop.x - epsilonX && line <= right + epsilonX)
    .map((line) => clamp((line - crop.x) / crop.width * outputWidth, 0, outputWidth));
  const yLines = grid.yLines
    .map((line) => line / grid.sourceHeight)
    .filter((line) => line >= crop.y - epsilonY && line <= bottom + epsilonY)
    .map((line) => clamp((line - crop.y) / crop.height * outputHeight, 0, outputHeight));
  if (xLines.length < 2 || yLines.length < 2) return null;
  return {
    left: xLines[0],
    top: yLines[0],
    right: xLines.at(-1)!,
    bottom: yLines.at(-1)!,
    columns: xLines.length - 1,
    rows: yLines.length - 1,
    xLines,
    yLines,
    confidence: grid.confidence,
    sourceWidth: outputWidth,
    sourceHeight: outputHeight,
  };
}

function detectGridInsideCrop(
  canvas: HTMLCanvasElement,
  crop: NormalizedCrop,
): GridDetectionResult | null {
  const left = Math.max(0, Math.floor(crop.x * canvas.width));
  const top = Math.max(0, Math.floor(crop.y * canvas.height));
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(crop.width * canvas.width)));
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(crop.height * canvas.height)));
  const usesFullCanvas = left === 0 && top === 0 && width === canvas.width && height === canvas.height;
  const source = usesFullCanvas ? canvas : document.createElement("canvas");
  if (!usesFullCanvas) {
    source.width = width;
    source.height = height;
    const context = source.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(canvas, left, top, width, height, 0, 0, width, height);
  }
  const detected = detectBeadGrid(source);
  if (!detected) return null;
  if (usesFullCanvas) return detected;
  return {
    ...detected,
    left: detected.left + left,
    top: detected.top + top,
    right: detected.right + left,
    bottom: detected.bottom + top,
    xLines: detected.xLines.map((line) => line + left),
    yLines: detected.yLines.map((line) => line + top),
    sourceWidth: canvas.width,
    sourceHeight: canvas.height,
  };
}

export default function ImagePreprocessEditor({
  draft,
  mode,
  initialDetail,
  onCancel,
  onComplete,
}: ImagePreprocessEditorProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [transform, setTransform] = useState<ImageTransform>({
    crop: FULL_CROP,
    rotation: 0,
    flipX: false,
    flipY: false,
  });
  const [detail, setDetail] = useState(() => clamp(Math.round(initialDetail || 40), 4, 200));
  const [grid, setGrid] = useState<GridDetectionResult | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const autoDetectionKeyRef = useRef("");

  const swapsDimensions = transform.rotation === 90 || transform.rotation === 270;
  const orientedWidth = swapsDimensions ? draft.imageHeight : draft.imageWidth;
  const orientedHeight = swapsDimensions ? draft.imageWidth : draft.imageHeight;
  const croppedWidth = Math.max(1, orientedWidth * transform.crop.width);
  const croppedHeight = Math.max(1, orientedHeight * transform.crop.height);
  const derivedGrid = useMemo(
    () => deriveGridSize(croppedWidth, croppedHeight, detail),
    [croppedHeight, croppedWidth, detail],
  );
  const orientationKey = `${draft.dataUrl}:${transform.rotation}:${transform.flipX}:${transform.flipY}`;

  useEffect(() => {
    let cancelled = false;
    const nextImage = new Image();
    nextImage.onload = () => {
      if (!cancelled) {
        setImage(nextImage);
        setError("");
      }
    };
    nextImage.onerror = () => {
      if (!cancelled) setError("图片无法解码，请尝试转换为 PNG 或 JPEG");
    };
    nextImage.src = draft.dataUrl;
    return () => {
      cancelled = true;
    };
  }, [draft.dataUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    setPreviewReady(false);
    try {
      drawPreview(canvas, image, {
        rotation: transform.rotation,
        flipX: transform.flipX,
        flipY: transform.flipY,
      });
      setPreviewReady(true);
      setError("");
    } catch (drawError) {
      setError(drawError instanceof Error ? drawError.message : "无法显示图片预览");
    }
  }, [image, transform.flipX, transform.flipY, transform.rotation]);

  const applyDetectedGrid = useCallback((detected: GridDetectionResult) => {
    const crop = normalizeCrop({
      x: detected.left / detected.sourceWidth,
      y: detected.top / detected.sourceHeight,
      width: (detected.right - detected.left) / detected.sourceWidth,
      height: (detected.bottom - detected.top) / detected.sourceHeight,
    });
    setGrid(detected);
    setTransform((current) => ({ ...current, crop }));
    setDetail(clamp(Math.max(detected.columns, detected.rows), 4, 200));
    setError("");
  }, []);

  const detectGrid = useCallback((): GridDetectionResult | null => {
    const canvas = canvasRef.current;
    if (!canvas || !previewReady) return null;
    const detected = detectGridInsideCrop(canvas, transform.crop);
    if (!detected) {
      setGrid(null);
      setError("没有找到稳定的规则网格，请先旋转或手动调整裁剪框后重试");
      return null;
    }
    applyDetectedGrid(detected);
    return detected;
  }, [applyDetectedGrid, previewReady, transform.crop]);

  useEffect(() => {
    if (mode !== "pattern" || !previewReady || autoDetectionKeyRef.current === orientationKey) return;
    autoDetectionKeyRef.current = orientationKey;
    const frame = window.requestAnimationFrame(() => {
      detectGrid();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detectGrid, mode, orientationKey, previewReady]);

  const resetOrientationSelection = (patch: Partial<ImageTransform>) => {
    setGrid(null);
    setError("");
    setTransform((current) => ({
      ...current,
      ...patch,
      crop: FULL_CROP,
    }));
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    handle: DragHandle,
  ) => {
    if (busy) return;
    event.preventDefault();
    event.stopPropagation();
    stageRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: transform.crop,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !stage) return;
    event.preventDefault();
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const deltaX = (event.clientX - drag.startClientX) / bounds.width;
    const deltaY = (event.clientY - drag.startClientY) / bounds.height;
    const start = drag.startCrop;
    const minimumWidth = Math.min(0.25, Math.max(0.025, 34 / bounds.width));
    const minimumHeight = Math.min(0.25, Math.max(0.025, 34 / bounds.height));

    if (drag.handle === "move") {
      setTransform((current) => ({
        ...current,
        crop: {
          ...start,
          x: clamp(start.x + deltaX, 0, 1 - start.width),
          y: clamp(start.y + deltaY, 0, 1 - start.height),
        },
      }));
      return;
    }

    let left = start.x;
    let top = start.y;
    let right = start.x + start.width;
    let bottom = start.y + start.height;
    if (drag.handle.includes("west")) left = clamp(start.x + deltaX, 0, right - minimumWidth);
    if (drag.handle.includes("east")) right = clamp(start.x + start.width + deltaX, left + minimumWidth, 1);
    if (drag.handle.includes("north")) top = clamp(start.y + deltaY, 0, bottom - minimumHeight);
    if (drag.handle.includes("south")) bottom = clamp(start.y + start.height + deltaY, top + minimumHeight, 1);

    if (mode === "pattern" && grid) {
      const thresholdX = Math.max(0.004, 13 / bounds.width);
      const thresholdY = Math.max(0.004, 13 / bounds.height);
      if (drag.handle.includes("west")) left = closestGridLine(left, grid.xLines, grid.sourceWidth, thresholdX);
      if (drag.handle.includes("east")) right = closestGridLine(right, grid.xLines, grid.sourceWidth, thresholdX);
      if (drag.handle.includes("north")) top = closestGridLine(top, grid.yLines, grid.sourceHeight, thresholdY);
      if (drag.handle.includes("south")) bottom = closestGridLine(bottom, grid.yLines, grid.sourceHeight, thresholdY);
    }
    setTransform((current) => ({
      ...current,
      crop: normalizeCrop({ x: left, y: top, width: right - left, height: bottom - top }),
    }));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (stageRef.current?.hasPointerCapture(event.pointerId)) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }
  };

  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const processed = await transformImageFile(draft.file, transform);
      const adjustedGrid = gridAfterCrop(grid, transform.crop, processed.width, processed.height);
      await onComplete({
        processed,
        detail,
        grid: adjustedGrid,
        transform: processed.transform,
      });
    } catch (completionError) {
      setError(completionError instanceof Error ? completionError.message : "图片处理失败");
    } finally {
      setBusy(false);
    }
  };

  const cropStyle: CSSProperties = {
    left: `${transform.crop.x * 100}%`,
    top: `${transform.crop.y * 100}%`,
    width: `${transform.crop.width * 100}%`,
    height: `${transform.crop.height * 100}%`,
  };

  return (
    <section
      className="wb-image-editor"
      aria-label={mode === "pattern" ? "成品图纸预处理" : "图片预处理"}
      style={{ display: "grid", gap: 12 }}
    >
      <div
        ref={stageRef}
        className="wb-image-editor-stage"
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        style={{
          position: "relative",
          width: `min(100%, ${Math.max(18, 56 * orientedWidth / Math.max(1, orientedHeight))}dvh)`,
          aspectRatio: `${Math.max(1, orientedWidth)} / ${Math.max(1, orientedHeight)}`,
          marginInline: "auto",
          overflow: "hidden",
          borderRadius: 18,
          background: "#D9D3CD",
          boxShadow: "inset 0 0 0 1px rgba(55,45,38,.14)",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label="待裁剪图片"
          style={{ position: "absolute", inset: 0, display: "block", width: "100%", height: "100%" }}
        />
        {previewReady && (
          <div
            className="wb-image-editor-crop"
            onPointerDown={(event) => startDrag(event, "move")}
            style={{
              ...cropStyle,
              position: "absolute",
              border: "2px solid #FF6B4A",
              borderRadius: 4,
              boxShadow: "0 0 0 9999px rgba(24,21,19,.48), inset 0 0 0 1px rgba(255,255,255,.92)",
              cursor: "move",
              touchAction: "none",
            }}
          >
            {(Object.keys(HANDLE_STYLES) as Array<Exclude<DragHandle, "move">>).map((handle) => (
              <button
                key={handle}
                type="button"
                aria-label={HANDLE_LABELS[handle]}
                onPointerDown={(event) => startDrag(event, handle)}
                style={{
                  position: "absolute",
                  width: 38,
                  height: 38,
                  padding: 0,
                  border: "5px solid transparent",
                  borderRadius: "50%",
                  background: "#FF6B4A",
                  backgroundClip: "content-box",
                  touchAction: "none",
                  ...HANDLE_STYLES[handle],
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="wb-image-editor-tools"
        style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => resetOrientationSelection({ rotation: nextRotation(transform.rotation) })}
        >
          ↻ 旋转 90°
        </button>
        <button
          type="button"
          disabled={busy}
          aria-pressed={transform.flipX}
          onClick={() => resetOrientationSelection({ flipX: !transform.flipX })}
        >
          ↔ 水平翻转
        </button>
        <button
          type="button"
          disabled={busy}
          aria-pressed={transform.flipY}
          onClick={() => resetOrientationSelection({ flipY: !transform.flipY })}
        >
          ↕ 垂直翻转
        </button>
      </div>

      {mode === "photo" ? (
        <label
          className="wb-image-editor-detail"
          style={{ display: "grid", gap: 8, padding: 12, borderRadius: 14, background: "rgba(255,255,255,.72)" }}
        >
          <span style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <b>图纸清晰度</b>
            <strong>{derivedGrid.width} × {derivedGrid.height} 格</strong>
          </span>
          <input
            type="range"
            min="8"
            max="200"
            value={detail}
            onChange={(event) => setDetail(Number(event.target.value))}
          />
          <small>只调整格子数量，始终锁定裁剪后图片比例。</small>
        </label>
      ) : (
        <div
          className="wb-image-editor-grid-tools"
          style={{ display: "grid", gap: 8, padding: 12, borderRadius: 14, background: "rgba(255,255,255,.72)" }}
        >
          <button type="button" disabled={busy || !previewReady} onClick={detectGrid}>
            ⊞ 自动对齐拼豆网格
          </button>
          {grid && (
            <p style={{ margin: 0, fontSize: 13, textAlign: "center" }}>
              已识别 <strong>{grid.columns} × {grid.rows}</strong> 格
              · 置信度 {Math.round(grid.confidence * 100)}%
            </p>
          )}
          <small>拖动橙色四角可微调；靠近网格线时会自动吸附。</small>
        </div>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, padding: "9px 12px", borderRadius: 12, color: "#9C3426", background: "#FFF0EC" }}>
          {error}
        </p>
      )}

      <div
        className="wb-image-editor-actions"
        style={{ display: "grid", gridTemplateColumns: "1fr 1.7fr", gap: 9 }}
      >
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button
          type="button"
          disabled={busy || !previewReady || (mode === "pattern" && !grid)}
          className="wb-primary"
          onClick={finish}
        >
          {busy ? "处理中…" : mode === "pattern" ? "完成并识别图纸" : "完成并生成图纸"}
        </button>
      </div>
    </section>
  );
}
