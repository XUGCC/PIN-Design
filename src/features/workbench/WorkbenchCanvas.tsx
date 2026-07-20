"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import type { WorkbenchProject } from "./model";
import { paletteCode, paletteEntryById } from "./palette";
import { allRegions, chooseGuidedRegion, connectedRegion, countHints, regionBoundary, type Region } from "./regions";
import type { EditTool } from "./editing";
import { canvasBackingScale } from "./canvas-performance";

interface WorkbenchCanvasProps {
  project: WorkbenchProject;
  tool: EditTool;
  compareOriginal?: boolean;
  highlightColorId?: string | null;
  onCellAction: (index: number, tool: EditTool, continuingStroke?: boolean) => void;
  onBeadCell: (index: number) => void;
  locateRequest?: number;
}

const CELL_SIZE = 22;

interface CanvasView {
  zoom: number;
  x: number;
  y: number;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function paleGray(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  const luma = r * 0.299 + g * 0.587 + b * 0.114;
  const pale = Math.round(244 - (255 - luma) * 0.16);
  return `rgba(${pale},${pale},${pale},${alpha})`;
}

function contrast(hex: string): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 > 155 ? "#352f2c" : "#fff";
}

export default function WorkbenchCanvas({
  project,
  tool,
  compareOriginal = false,
  highlightColorId = null,
  onCellAction,
  onBeadCell,
  locateRequest = 0,
}: WorkbenchCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  const [view, setView] = useState<CanvasView>({ zoom: 1, x: 0, y: 0 });
  const [renderScale, setRenderScale] = useState(1);
  const [gestureActive, setGestureActive] = useState(false);
  const viewRef = useRef<CanvasView>(view);
  const viewFrame = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, lastX: 0, lastY: 0, pinchDistance: 0, pinchX: 0, pinchY: 0 });
  const autoDirection = useRef(new Map<string, "horizontal" | "vertical">());
  const lastStrokeIndex = useRef<number | null>(null);
  const logicalWidth = project.optimize.width * CELL_SIZE;
  const logicalHeight = project.optimize.height * CELL_SIZE;
  const fitScale = Math.min(
    Math.max(0.02, (viewport.width - 36) / Math.max(1, logicalWidth)),
    Math.max(0.02, (viewport.height - 36) / Math.max(1, logicalHeight)),
    1.35,
  );
  const displayScale = fitScale * view.zoom;

  const updateView = useCallback((updater: (current: CanvasView) => CanvasView, immediate = false) => {
    viewRef.current = updater(viewRef.current);
    if (immediate) {
      if (viewFrame.current !== null) window.cancelAnimationFrame(viewFrame.current);
      viewFrame.current = null;
      setView(viewRef.current);
      return;
    }
    if (viewFrame.current !== null) return;
    viewFrame.current = window.requestAnimationFrame(() => {
      viewFrame.current = null;
      setView(viewRef.current);
    });
  }, []);

  useEffect(() => {
    if (!viewportRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    updateView(() => ({ zoom: 1, x: 0, y: 0 }), true);
  }, [project.id, updateView]);

  useEffect(() => () => {
    if (viewFrame.current !== null) window.cancelAnimationFrame(viewFrame.current);
  }, []);

  useEffect(() => {
    if (gestureActive) return;
    const timeout = window.setTimeout(() => setRenderScale(displayScale), 120);
    return () => window.clearTimeout(timeout);
  }, [displayScale, gestureActive]);

  const activeRegion = useMemo<Region | null>(() => {
    if (project.stage !== "bead" || !project.bead.selectedColorId) return null;
    const active = project.bead.activeCellIndex;
    if (
      active !== null &&
      project.cells[active]?.colorId === project.bead.selectedColorId &&
      !project.cells[active]?.completed
    ) {
      return connectedRegion(project.cells, project.optimize.width, project.optimize.height, active);
    }
    const regions = allRegions(
      project.cells,
      project.optimize.width,
      project.optimize.height,
      project.bead.selectedColorId,
    );
    return chooseGuidedRegion(
      regions,
      project.bead.guidanceMode,
      project.bead.activeCellIndex,
      project.optimize.width,
      project.optimize.height,
    );
  }, [project]);

  useEffect(() => {
    if (!locateRequest || !activeRegion?.cells.length) return;
    const center = activeRegion.cells.reduce((result, cell) => ({ x: result.x + cell.x, y: result.y + cell.y }), { x: 0, y: 0 });
    center.x = (center.x / activeRegion.cells.length + 0.5) * CELL_SIZE;
    center.y = (center.y / activeRegion.cells.length + 0.5) * CELL_SIZE;
    const nextZoom = Math.max(1, Math.min(3.5, 1.7 / Math.max(fitScale, 0.1)));
    updateView(() => ({
      zoom: nextZoom,
      x: (logicalWidth / 2 - center.x) * fitScale * nextZoom,
      y: (logicalHeight / 2 - center.y) * fitScale * nextZoom,
    }), true);
  }, [locateRequest, activeRegion, fitScale, logicalHeight, logicalWidth, updateView]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = canvasBackingScale(
      logicalWidth,
      logicalHeight,
      window.devicePixelRatio || 1,
      window.matchMedia("(pointer: coarse)").matches,
    );
    const backingWidth = Math.max(1, Math.floor(logicalWidth * dpr));
    const backingHeight = Math.max(1, Math.floor(logicalHeight * dpr));
    // Assigning width or height clears the entire bitmap. During a pinch this
    // effect runs many times, so only resize when the project dimensions
    // actually require a different backing store.
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    canvas.style.width = `${logicalWidth}px`;
    canvas.style.height = `${logicalHeight}px`;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, logicalWidth, logicalHeight);
    context.fillStyle = "#f8f5f0";
    context.fillRect(0, 0, logicalWidth, logicalHeight);

    const activeSet = new Set(activeRegion?.cells.map((cell) => cell.index) ?? []);
    const screenCell = CELL_SIZE * renderScale;
    project.cells.forEach((cell, index) => {
      const x = (index % project.optimize.width) * CELL_SIZE;
      const y = Math.floor(index / project.optimize.width) * CELL_SIZE;
      const entry = paletteEntryById(cell.colorId);
      const originalFill = cell.sourceHex ?? entry?.hex ?? "#f8f5f0";
      let fill = originalFill;
      if ((project.stage === "optimize" || project.stage === "preview") && entry && highlightColorId) {
        fill = cell.colorId === highlightColorId ? originalFill : paleGray(originalFill, 0.78);
      }
      if (project.stage === "bead" && entry) {
        if (cell.completed) fill = originalFill;
        else if (cell.colorId !== project.bead.selectedColorId) fill = paleGray(originalFill, 0.88);
        else if (activeSet.has(index)) fill = rgba(originalFill, Math.max(35, project.bead.unfinishedOpacity + 7) / 100);
        else fill = rgba(originalFill, project.bead.unfinishedOpacity / 100);
      }
      context.fillStyle = fill;
      context.fillRect(x, y, CELL_SIZE, CELL_SIZE);

      const showCode = project.stage === "preview" && project.preview.showColorCodes && entry && screenCell >= 14;
      if (showCode) {
        context.fillStyle = contrast(originalFill);
        context.font = `600 ${Math.max(6, Math.min(9, CELL_SIZE * 0.38))}px system-ui, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(paletteCode(entry, project.colorSystem), x + CELL_SIZE / 2, y + CELL_SIZE / 2);
      }
      if (project.stage === "bead" && cell.completed && screenCell >= 18) {
        context.strokeStyle = contrast(originalFill);
        context.lineWidth = 1.6 / renderScale;
        context.beginPath();
        context.moveTo(x + CELL_SIZE * 0.28, y + CELL_SIZE * 0.52);
        context.lineTo(x + CELL_SIZE * 0.43, y + CELL_SIZE * 0.68);
        context.lineTo(x + CELL_SIZE * 0.73, y + CELL_SIZE * 0.34);
        context.stroke();
      }
    });

    const showGrid = project.stage === "preview" ? project.preview.showGrid : true;
    if (showGrid && screenCell >= 4) {
      context.strokeStyle = project.stage === "bead" ? "rgba(70,64,59,.20)" : "rgba(70,64,59,.28)";
      context.lineWidth = Math.max(0.35, 0.72 / renderScale);
      context.beginPath();
      for (let x = 0; x <= project.optimize.width; x += 1) {
        context.moveTo(x * CELL_SIZE, 0);
        context.lineTo(x * CELL_SIZE, logicalHeight);
      }
      for (let y = 0; y <= project.optimize.height; y += 1) {
        context.moveTo(0, y * CELL_SIZE);
        context.lineTo(logicalWidth, y * CELL_SIZE);
      }
      context.stroke();
    }

    const showSections = project.stage === "bead"
      ? project.bead.showSectionLines
      : project.stage === "preview" && project.preview.showSectionLines;
    const interval = project.stage === "bead" ? project.bead.sectionInterval : project.preview.sectionInterval;
    if (showSections && interval > 0) {
      context.strokeStyle = "rgba(43,129,205,.72)";
      context.lineWidth = 1.3 / renderScale;
      context.beginPath();
      for (let x = interval; x < project.optimize.width; x += interval) {
        context.moveTo(x * CELL_SIZE, 0);
        context.lineTo(x * CELL_SIZE, logicalHeight);
      }
      for (let y = interval; y < project.optimize.height; y += interval) {
        context.moveTo(0, y * CELL_SIZE);
        context.lineTo(logicalWidth, y * CELL_SIZE);
      }
      context.stroke();
    }

    if (project.stage === "preview" && project.preview.showCoordinates && screenCell >= 7) {
      const step = Math.max(1, project.preview.sectionInterval);
      context.save();
      context.font = `700 ${10 / renderScale}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      for (let x = 0; x < project.optimize.width; x += step) {
        const label = String(x + 1);
        const centerX = (x + 0.5) * CELL_SIZE;
        const centerY = 7 / renderScale;
        const metrics = context.measureText(label);
        context.fillStyle = "rgba(255,255,255,.82)";
        context.fillRect(centerX - metrics.width / 2 - 2 / renderScale, 0, metrics.width + 4 / renderScale, 14 / renderScale);
        context.fillStyle = "#266ca6";
        context.fillText(label, centerX, centerY);
      }
      context.textAlign = "left";
      for (let y = 0; y < project.optimize.height; y += step) {
        const label = String(y + 1);
        const centerY = (y + 0.5) * CELL_SIZE;
        context.fillStyle = "rgba(255,255,255,.82)";
        context.fillRect(0, centerY - 7 / renderScale, 18 / renderScale, 14 / renderScale);
        context.fillStyle = "#266ca6";
        context.fillText(label, 2 / renderScale, centerY);
      }
      context.restore();
    }

    if (project.stage === "bead" && activeRegion) {
      const lineWidth = 1.15 / renderScale;
      context.save();
      context.strokeStyle = "#ff3f70";
      context.lineWidth = lineWidth;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.shadowColor = "rgba(255,34,100,.62)";
      context.shadowBlur = 2.2 / renderScale;
      context.beginPath();
      regionBoundary(activeRegion).forEach((edge) => {
        context.moveTo(edge.x1 * CELL_SIZE, edge.y1 * CELL_SIZE);
        context.lineTo(edge.x2 * CELL_SIZE, edge.y2 * CELL_SIZE);
      });
      context.stroke();
      context.restore();

      if (project.bead.showCountHints && screenCell >= 9) {
        const key = `${activeRegion.colorId}:${activeRegion.cells[0]?.index}`;
        let direction = project.bead.countDirection;
        if (direction === "auto") direction = autoDirection.current.get(key) ?? "auto";
        const result = countHints(activeRegion, direction);
        if (project.bead.countDirection === "auto") autoDirection.current.set(key, result.direction);
        const visibleHints = screenCell < 15 ? result.hints.filter((hint) => hint.count > 1) : result.hints;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.font = `700 ${12 / renderScale}px system-ui, sans-serif`;
        visibleHints.forEach((hint) => {
          const x = hint.x * CELL_SIZE;
          const y = hint.y * CELL_SIZE;
          const label = String(hint.count);
          const metrics = context.measureText(label);
          const paddingX = 4 / renderScale;
          const height = 17 / renderScale;
          context.fillStyle = "rgba(42,34,31,.84)";
          context.beginPath();
          context.roundRect(x - metrics.width / 2 - paddingX, y - height / 2, metrics.width + paddingX * 2, height, 4 / renderScale);
          context.fill();
          context.fillStyle = "#ffd459";
          context.fillText(label, x, y + 0.3 / renderScale);
        });
      } else if (project.bead.showCountHints) {
        const bounds = activeRegion.cells.reduce((result, cell) => ({
          minX: Math.min(result.minX, cell.x),
          maxX: Math.max(result.maxX, cell.x),
          minY: Math.min(result.minY, cell.y),
          maxY: Math.max(result.maxY, cell.y),
        }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
        const x = ((bounds.minX + bounds.maxX + 1) / 2) * CELL_SIZE;
        const y = ((bounds.minY + bounds.maxY + 1) / 2) * CELL_SIZE;
        const label = "放大后显示数量";
        context.font = `600 ${11 / renderScale}px system-ui, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        const metrics = context.measureText(label);
        context.fillStyle = "rgba(46,40,37,.82)";
        context.beginPath();
        context.roundRect(x - metrics.width / 2 - 6 / renderScale, y - 11 / renderScale, metrics.width + 12 / renderScale, 22 / renderScale, 6 / renderScale);
        context.fill();
        context.fillStyle = "white";
        context.fillText(label, x, y);
      }
    }
  }, [project, activeRegion, renderScale, highlightColorId, logicalHeight, logicalWidth]);

  const cellAt = useCallback((clientX: number, clientY: number): number | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const x = Math.floor(((clientX - rect.left) / rect.width) * project.optimize.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * project.optimize.height);
    if (x < 0 || y < 0 || x >= project.optimize.width || y >= project.optimize.height) return null;
    return y * project.optimize.width + x;
  }, [project.optimize.height, project.optimize.width]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setGestureActive(true);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = { ...gesture.current, moved: false, lastX: event.clientX, lastY: event.clientY };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.pinchX = (a.x + b.x) / 2;
      gesture.current.pinchY = (a.y + b.y) / 2;
    }
    if (project.stage === "edit" && event.pointerType !== "touch" && event.button === 0 && !event.altKey) {
      const index = cellAt(event.clientX, event.clientY);
      if (index !== null) {
        onCellAction(index, tool, false);
        lastStrokeIndex.current = index;
        gesture.current.moved = true;
      }
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current.pinchDistance > 0) {
        const ratio = distance / gesture.current.pinchDistance;
        const rect = viewportRef.current?.getBoundingClientRect();
        const midpointX = (a.x + b.x) / 2;
        const midpointY = (a.y + b.y) / 2;
        if (rect) {
          const localX = midpointX - rect.left - rect.width / 2;
          const localY = midpointY - rect.top - rect.height / 2;
          updateView((current) => {
            const zoom = Math.max(0.55, Math.min(8, current.zoom * ratio));
            const appliedRatio = zoom / current.zoom;
            return {
              zoom,
              x: localX - (localX - current.x) * appliedRatio,
              y: localY - (localY - current.y) * appliedRatio,
            };
          });
        } else {
          updateView((current) => ({ ...current, zoom: Math.max(0.55, Math.min(8, current.zoom * ratio)) }));
        }
      }
      gesture.current.pinchDistance = distance;
      gesture.current.pinchX = (a.x + b.x) / 2;
      gesture.current.pinchY = (a.y + b.y) / 2;
      gesture.current.moved = true;
      return;
    }
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (project.stage === "edit" && event.pointerType !== "touch" && event.buttons === 1 && !event.altKey) {
      const index = cellAt(event.clientX, event.clientY);
      if (index !== null && index !== lastStrokeIndex.current) {
        onCellAction(index, tool, true);
        lastStrokeIndex.current = index;
      }
      gesture.current.moved = true;
      return;
    }
    if (Math.abs(event.clientX - gesture.current.lastX) + Math.abs(event.clientY - gesture.current.lastY) > 4) {
      gesture.current.moved = true;
    }
    if (gesture.current.moved && (event.pointerType === "touch" || event.altKey || event.button === 1 || event.buttons === 4)) {
      updateView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const shouldTap = !gesture.current.moved && pointers.current.size === 1;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) setGestureActive(false);
    lastStrokeIndex.current = null;
    if (!shouldTap) return;
    const index = cellAt(event.clientX, event.clientY);
    if (index === null) return;
    if (project.stage === "bead") onBeadCell(index);
    else if (project.stage === "edit") onCellAction(index, tool);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    updateView((current) => ({
      ...current,
      zoom: Math.max(0.55, Math.min(8, current.zoom * (event.deltaY > 0 ? 0.9 : 1.1))),
    }));
  };

  const resetView = () => {
    updateView(() => ({ zoom: 1, x: 0, y: 0 }), true);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) setGestureActive(false);
  };

  const transform = `translate3d(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px), 0) scale(${displayScale})`;

  return (
    <div
      ref={viewportRef}
      className="wb-canvas-viewport"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      aria-label="拼豆图纸画布"
    >
      {compareOriginal && project.sourceImage && project.stage === "optimize" && (
        <img
          className="wb-original-overlay"
          src={project.sourceImage.dataUrl}
          alt="原图对比"
          draggable={false}
          style={{ width: logicalWidth, height: logicalHeight, transform }}
        />
      )}
      <canvas
        ref={canvasRef}
        className={`wb-canvas${compareOriginal && project.sourceImage ? " wb-canvas-half" : ""}`}
        style={{ transform }}
      />
      <div className="wb-zoom-tools" aria-label="画布缩放">
        <button type="button" onClick={() => updateView((current) => ({ ...current, zoom: Math.min(8, current.zoom * 1.2) }))} aria-label="放大">＋</button>
        <button type="button" onClick={resetView} aria-label="适应画布">⌖</button>
        <button type="button" onClick={() => updateView((current) => ({ ...current, zoom: Math.max(0.55, current.zoom / 1.2) }))} aria-label="缩小">−</button>
      </div>
      <div className="wb-zoom-label">{Math.round(displayScale * 100)}%</div>
    </div>
  );
}
