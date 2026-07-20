import {
  createProject,
  projectProgress,
  sanitizeProject,
  type ColorSystem,
  type ProjectSummary,
  type WorkbenchProject,
} from "./model";
import { FULL_PALETTE, nearestPaletteEntry } from "./palette";

const DB_NAME = "zippland-perler-workbench";
const DB_VERSION = 1;
const PROJECT_STORE = "projects";
const THUMBNAIL_STORE = "thumbnails";
const ACTIVE_PROJECT_KEY = "workbench.activeProjectId";
const PREFERENCES_KEY = "workbench.preferences.v1";
const LEGACY_MIGRATION_KEY = "workbench.legacyMigration.v1";

export interface WorkbenchPreferences {
  unfinishedOpacity: number;
  colorSystem: ColorSystem;
  installGuideDismissed: boolean;
  lastInstallPlatform: "android" | "ios" | null;
}

export const DEFAULT_PREFERENCES: WorkbenchPreferences = {
  unfinishedOpacity: 28,
  colorSystem: "MARD",
  installGuideDismissed: false,
  lastInstallPlatform: null,
};

function browserOnly(): void {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    throw new Error("本地项目库只能在浏览器中使用");
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地数据库操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地数据库事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地数据库事务已取消"));
  });
}

export async function openWorkbenchDatabase(): Promise<IDBDatabase> {
  browserOnly();
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(PROJECT_STORE)) {
      const projects = db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      projects.createIndex("updatedAt", "updatedAt");
    }
    if (!db.objectStoreNames.contains(THUMBNAIL_STORE)) {
      db.createObjectStore(THUMBNAIL_STORE, { keyPath: "id" });
    }
  };
  return requestResult(request);
}

export async function saveProject(project: WorkbenchProject, thumbnail?: string): Promise<WorkbenchProject> {
  const db = await openWorkbenchDatabase();
  const saved = sanitizeProject({ ...project, updatedAt: Date.now() });
  const stores = thumbnail ? [PROJECT_STORE, THUMBNAIL_STORE] : [PROJECT_STORE];
  const transaction = db.transaction(stores, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(PROJECT_STORE).put(saved);
  if (thumbnail) transaction.objectStore(THUMBNAIL_STORE).put({ id: saved.id, thumbnail });
  await done;
  db.close();
  setActiveProjectId(saved.id);
  return saved;
}

export async function loadProject(id: string): Promise<WorkbenchProject | null> {
  const db = await openWorkbenchDatabase();
  const transaction = db.transaction(PROJECT_STORE, "readonly");
  const done = transactionDone(transaction);
  const raw = await requestResult(transaction.objectStore(PROJECT_STORE).get(id));
  await done;
  db.close();
  return raw ? sanitizeProject(raw) : null;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openWorkbenchDatabase();
  const transaction = db.transaction([PROJECT_STORE, THUMBNAIL_STORE], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(PROJECT_STORE).delete(id);
  transaction.objectStore(THUMBNAIL_STORE).delete(id);
  await done;
  db.close();
  if (getActiveProjectId() === id) setActiveProjectId(null);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await openWorkbenchDatabase();
  const transaction = db.transaction([PROJECT_STORE, THUMBNAIL_STORE], "readonly");
  const done = transactionDone(transaction);
  const projectsRequest = requestResult(transaction.objectStore(PROJECT_STORE).getAll()) as Promise<WorkbenchProject[]>;
  const thumbnailsRequest = requestResult(transaction.objectStore(THUMBNAIL_STORE).getAll()) as Promise<Array<{
    id: string;
    thumbnail: string;
  }>>;
  const [projects, thumbnails] = await Promise.all([projectsRequest, thumbnailsRequest]);
  await done;
  db.close();
  const thumbnailById = new Map(thumbnails.map((item) => [item.id, item.thumbnail]));
  return projects
    .map((raw) => {
      const project = sanitizeProject(raw);
      return {
        id: project.id,
        name: project.name,
        width: project.optimize.width,
        height: project.optimize.height,
        updatedAt: project.updatedAt,
        thumbnail: thumbnailById.get(project.id),
        progress: projectProgress(project),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActiveProjectId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(ACTIVE_PROJECT_KEY);
}

export function setActiveProjectId(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  else localStorage.removeItem(ACTIVE_PROJECT_KEY);
}

export function loadPreferences(): WorkbenchPreferences {
  if (typeof localStorage === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as Partial<WorkbenchPreferences> | null;
    if (!raw) return DEFAULT_PREFERENCES;
    return {
      unfinishedOpacity: Math.max(10, Math.min(50, Number(raw.unfinishedOpacity) || 28)),
      colorSystem: ["MARD", "COCO", "漫漫", "盼盼", "咪小窝"].includes(raw.colorSystem ?? "")
        ? raw.colorSystem!
        : "MARD",
      installGuideDismissed: Boolean(raw.installGuideDismissed),
      lastInstallPlatform: raw.lastInstallPlatform === "android" || raw.lastInstallPlatform === "ios"
        ? raw.lastInstallPlatform
        : null,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: WorkbenchPreferences): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

type LegacyPixel = { key?: string; color?: string; isExternal?: boolean };

export function migrateLegacyPayload(payload: {
  pixelData: unknown;
  dimensions: unknown;
  selectedColorSystem?: string | null;
  paletteSelections?: unknown;
}): WorkbenchProject | null {
  if (!Array.isArray(payload.pixelData) || !payload.dimensions || typeof payload.dimensions !== "object") return null;
  const dimensions = payload.dimensions as { N?: number; M?: number };
  const width = Math.round(Number(dimensions.N));
  const height = Math.round(Number(dimensions.M));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 200 || height > 200) {
    return null;
  }
  const rows = payload.pixelData as LegacyPixel[][];
  const selected = payload.paletteSelections && typeof payload.paletteSelections === "object"
    ? payload.paletteSelections as Record<string, boolean>
    : null;
  const selectedPalette = selected
    ? FULL_PALETTE.filter((entry) => selected[entry.hex.toUpperCase()] === true)
    : [];
  const palette = selectedPalette.length ? selectedPalette : FULL_PALETTE;
  const cells = Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const legacy = rows[y]?.[x];
    if (!legacy || legacy.isExternal || !legacy.color || legacy.color.toLowerCase() === "transparent") {
      return { colorId: null, completed: false };
    }
    const exact = FULL_PALETTE.find((entry) => entry.hex.toUpperCase() === legacy.color!.toUpperCase());
    const entry = exact ?? nearestPaletteEntry(legacy.color, palette.length ? palette : FULL_PALETTE);
    return { colorId: entry.id, completed: false };
  });
  const rawSystem = payload.selectedColorSystem;
  const colorSystem: ColorSystem = rawSystem && ["MARD", "COCO", "漫漫", "盼盼", "咪小窝"].includes(rawSystem)
    ? rawSystem as ColorSystem
    : "MARD";
  return createProject({
    name: `旧版项目 ${new Date().toLocaleDateString("zh-CN")}`,
    stage: "bead",
    colorSystem,
    palette,
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

export async function migrateLegacyProjectOnce(): Promise<WorkbenchProject | null> {
  if (typeof localStorage === "undefined" || localStorage.getItem(LEGACY_MIGRATION_KEY)) return null;
  const pixelData = localStorage.getItem("focusMode_pixelData");
  const dimensions = localStorage.getItem("focusMode_gridDimensions");
  if (!pixelData || !dimensions) {
    localStorage.setItem(LEGACY_MIGRATION_KEY, "none");
    return null;
  }
  try {
    const project = migrateLegacyPayload({
      pixelData: JSON.parse(pixelData),
      dimensions: JSON.parse(dimensions),
      selectedColorSystem: localStorage.getItem("focusMode_selectedColorSystem"),
      paletteSelections: JSON.parse(localStorage.getItem("customPerlerPaletteSelections") ?? "null"),
    });
    if (!project) {
      localStorage.setItem(LEGACY_MIGRATION_KEY, "invalid");
      return null;
    }
    const saved = await saveProject(project);
    localStorage.setItem(LEGACY_MIGRATION_KEY, saved.id);
    return saved;
  } catch {
    localStorage.setItem(LEGACY_MIGRATION_KEY, "invalid");
    return null;
  }
}
