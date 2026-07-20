export const WORKBENCH_SCHEMA_VERSION = 2;

export type WorkbenchStage = "optimize" | "edit" | "preview" | "bead";
export type ColorSystem = "MARD" | "COCO" | "漫漫" | "盼盼" | "咪小窝";
export type PixelationMode = "dominant" | "average";
export type GuidanceMode = "nearest" | "largest" | "edge";
export type CountDirection = "auto" | "horizontal" | "vertical";

export interface PixelCell {
  colorId: string | null;
  completed: boolean;
  /** Original sampled color for imported finished patterns. */
  sourceHex?: string;
}

export interface PaletteEntry {
  id: string;
  hex: string;
  codes: Partial<Record<ColorSystem, string>>;
  isExternal?: boolean;
}

export interface SourceImageData {
  name: string;
  mimeType: string;
  width: number;
  height: number;
  dataUrl: string;
}

export interface OptimizeSettings {
  width: number;
  height: number;
  mode: PixelationMode;
  mergeTolerance: number;
  removeBackground: boolean;
  backgroundColor: string;
  excludedColorIds: string[];
}

export interface PreviewSettings {
  showGrid: boolean;
  showSectionLines: boolean;
  sectionInterval: number;
  showCoordinates: boolean;
  showColorCodes: boolean;
}

export interface BeadSettings {
  guidanceMode: GuidanceMode;
  unfinishedOpacity: number;
  showSectionLines: boolean;
  sectionInterval: number;
  showCountHints: boolean;
  countDirection: CountDirection;
  selectedColorId: string | null;
  activeCellIndex: number | null;
}

export interface WorkTimer {
  accumulatedMs: number;
  runningSince: number | null;
}

export interface WorkbenchProject {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  stage: WorkbenchStage;
  colorSystem: ColorSystem;
  sourceImage: SourceImageData | null;
  palette: PaletteEntry[];
  cells: PixelCell[];
  optimize: OptimizeSettings;
  preview: PreviewSettings;
  bead: BeadSettings;
  timer: WorkTimer;
}

export interface ProjectSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  updatedAt: number;
  thumbnail?: string;
  progress: number;
}

export interface WorkbenchExportFile {
  kind: "zippland-perler-project";
  exportedAt: number;
  project: WorkbenchProject;
}

const createId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `project-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export function createBlankCells(width: number, height: number): PixelCell[] {
  return Array.from({ length: Math.max(1, width) * Math.max(1, height) }, () => ({
    colorId: null,
    completed: false,
  }));
}

export function createProject(
  overrides: Partial<WorkbenchProject> & { name?: string } = {},
): WorkbenchProject {
  const now = Date.now();
  const width = clampDimension(overrides.optimize?.width ?? 40);
  const height = clampDimension(overrides.optimize?.height ?? 40);
  return {
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    id: overrides.id ?? createId(),
    name: overrides.name?.trim() || "未命名拼豆项目",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    stage: overrides.stage ?? "optimize",
    colorSystem: overrides.colorSystem ?? "MARD",
    sourceImage: overrides.sourceImage ?? null,
    palette: overrides.palette ?? [],
    cells: overrides.cells ?? createBlankCells(width, height),
    optimize: {
      width,
      height,
      mode: overrides.optimize?.mode ?? "dominant",
      mergeTolerance: overrides.optimize?.mergeTolerance ?? 8,
      removeBackground: overrides.optimize?.removeBackground ?? false,
      backgroundColor: overrides.optimize?.backgroundColor ?? "#FFFFFF",
      excludedColorIds: overrides.optimize?.excludedColorIds ?? [],
    },
    preview: {
      showGrid: overrides.preview?.showGrid ?? true,
      showSectionLines: overrides.preview?.showSectionLines ?? true,
      sectionInterval: overrides.preview?.sectionInterval ?? 10,
      showCoordinates: overrides.preview?.showCoordinates ?? false,
      showColorCodes: overrides.preview?.showColorCodes ?? false,
    },
    bead: {
      guidanceMode: overrides.bead?.guidanceMode ?? "nearest",
      unfinishedOpacity: overrides.bead?.unfinishedOpacity ?? 28,
      showSectionLines: overrides.bead?.showSectionLines ?? true,
      sectionInterval: overrides.bead?.sectionInterval ?? 10,
      showCountHints: overrides.bead?.showCountHints ?? false,
      countDirection: overrides.bead?.countDirection ?? "auto",
      selectedColorId: overrides.bead?.selectedColorId ?? null,
      activeCellIndex: overrides.bead?.activeCellIndex ?? null,
    },
    timer: {
      accumulatedMs: overrides.timer?.accumulatedMs ?? 0,
      runningSince: overrides.timer?.runningSince ?? null,
    },
  };
}

export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 40;
  return Math.max(1, Math.min(200, Math.round(value)));
}

export function normalizeHex(value: string): string {
  const raw = value.trim().toUpperCase();
  const short = /^#([0-9A-F]{3})$/.exec(raw);
  if (short) return `#${short[1].split("").map((c) => c + c).join("")}`;
  return /^#[0-9A-F]{6}$/.test(raw) ? raw : "#FFFFFF";
}

export function sanitizeProject(input: unknown): WorkbenchProject {
  if (!input || typeof input !== "object") throw new Error("项目文件内容无效");
  const raw = input as Partial<WorkbenchProject>;
  const width = clampDimension(raw.optimize?.width ?? 40);
  const height = clampDimension(raw.optimize?.height ?? 40);
  const expected = width * height;
  const cells = Array.isArray(raw.cells)
    ? raw.cells.slice(0, expected).map((cell) => ({
        colorId: typeof cell?.colorId === "string" ? cell.colorId : null,
        completed: Boolean(cell?.completed),
        ...(typeof cell?.sourceHex === "string" && /^#[0-9A-F]{6}$/i.test(cell.sourceHex)
          ? { sourceHex: cell.sourceHex.toUpperCase() }
          : {}),
      }))
    : [];
  while (cells.length < expected) cells.push({ colorId: null, completed: false });
  const palette = Array.isArray(raw.palette)
    ? raw.palette
        .filter((entry): entry is PaletteEntry => Boolean(entry && typeof entry.id === "string"))
        .map((entry) => ({
          ...entry,
          hex: normalizeHex(entry.hex),
          codes: entry.codes ?? {},
        }))
    : [];

  return createProject({
    ...raw,
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    id: typeof raw.id === "string" && raw.id ? raw.id : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    optimize: { ...raw.optimize, width, height } as OptimizeSettings,
    cells,
    palette,
  });
}

export function serializeProject(project: WorkbenchProject): string {
  const payload: WorkbenchExportFile = {
    kind: "zippland-perler-project",
    exportedAt: Date.now(),
    project: { ...project, updatedAt: Date.now() },
  };
  return JSON.stringify(payload, null, 2);
}

export function parseProjectFile(text: string): WorkbenchProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("项目文件不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("项目文件内容无效");
  const wrapper = parsed as Partial<WorkbenchExportFile>;
  if (wrapper.kind === "zippland-perler-project" && wrapper.project) {
    return sanitizeProject(wrapper.project);
  }
  return sanitizeProject(parsed);
}

export function projectProgress(project: WorkbenchProject): number {
  const beadCells = project.cells.filter((cell) => cell.colorId);
  if (!beadCells.length) return 0;
  const completed = beadCells.filter((cell) => cell.completed).length;
  return Math.round((completed / beadCells.length) * 100);
}
