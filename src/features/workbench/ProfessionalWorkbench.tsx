"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import ImagePreprocessEditor, {
  type ImagePreprocessCompleteResult,
  type ImagePreprocessDraft,
} from "./ImagePreprocessEditor";
import WorkbenchCanvas from "./WorkbenchCanvas";
import { applyEditAction, type EditTool } from "./editing";
import {
  createProject,
  projectProgress,
  type ColorSystem,
  type PixelCell,
  type WorkbenchProject,
  type WorkbenchStage,
} from "./model";
import { COLOR_SYSTEMS, FULL_PALETTE, nearestPaletteEntry, paletteCode, paletteEntryById } from "./palette";
import { allRegions, chooseGuidedRegion } from "./regions";
import {
  colorStatistics,
  downloadBlob,
  downloadCsv,
  downloadProject,
  importProjectFile,
  mergeSimilarColors,
  projectFromImage,
  projectFromPatternImage,
  readFileAsDataUrl,
  loadImage,
  remapExcludedColors,
  renderProjectPng,
  renderProjectThumbnail,
  saveImageToPhotos,
  validateImportFile,
} from "./import-export";
import {
  deleteProject,
  listProjects,
  loadPreferences,
  loadProject,
  migrateLegacyProjectOnce,
  savePreferences,
  saveProject,
  type WorkbenchPreferences,
} from "./storage";
import { formatElapsed, pauseTimer, startTimer, timerElapsed } from "./timer";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    __pwaInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

type PreprocessDraft = ImagePreprocessDraft & { mode: "photo" | "pattern" };

const STAGES: Array<{ id: WorkbenchStage; label: string }> = [
  { id: "optimize", label: "优化" },
  { id: "edit", label: "编辑" },
  { id: "preview", label: "预览" },
  { id: "bead", label: "拼豆" },
];

const TOOL_LABELS: Array<{ id: EditTool; label: string; icon: string }> = [
  { id: "paint", label: "画笔", icon: "✎" },
  { id: "erase", label: "橡皮", icon: "⌫" },
  { id: "fill-erase", label: "区域擦除", icon: "◫" },
  { id: "picker", label: "吸色", icon: "⌁" },
  { id: "replace", label: "替换同色", icon: "⇄" },
];

function resizeCells(cells: PixelCell[], oldWidth: number, oldHeight: number, width: number, height: number): PixelCell[] {
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const oldX = Math.min(oldWidth - 1, Math.floor((x / width) * oldWidth));
    const oldY = Math.min(oldHeight - 1, Math.floor((y / height) * oldHeight));
    return { ...(cells[oldY * oldWidth + oldX] ?? { colorId: null, completed: false }), completed: false };
  });
}

function gridSizeForAspect(imageWidth: number, imageHeight: number, detail: number): { width: number; height: number } {
  const longEdge = Math.max(1, Math.min(200, Math.round(detail)));
  const aspect = imageWidth / Math.max(1, imageHeight);
  return aspect >= 1
    ? { width: longEdge, height: Math.max(1, Math.round(longEdge / aspect)) }
    : { width: Math.max(1, Math.round(longEdge * aspect)), height: longEdge };
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export default function ProfessionalWorkbench() {
  const [project, setProject] = useState<WorkbenchProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tool, setTool] = useState<EditTool>("paint");
  const [selectedColorId, setSelectedColorId] = useState(FULL_PALETTE[0]?.id ?? null);
  const [compareOriginal, setCompareOriginal] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [installTab, setInstallTab] = useState<"android" | "ios">("android");
  const [gallery, setGallery] = useState<Awaited<ReturnType<typeof listProjects>>>([]);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [locateRequest, setLocateRequest] = useState(0);
  const [toast, setToast] = useState("");
  const [now, setNow] = useState(Date.now());
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(() => loadPreferences());
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [paletteManagerOpen, setPaletteManagerOpen] = useState(false);
  const [showExclusions, setShowExclusions] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightColorId, setHighlightColorId] = useState<string | null>(null);
  const [includeExportStats, setIncludeExportStats] = useState(true);
  const [includeBackupSource, setIncludeBackupSource] = useState(true);
  const [preparedPhoto, setPreparedPhoto] = useState<{ key: string; blob: Blob; filename: string; title: string } | null>(null);
  const [preparingPhoto, setPreparingPhoto] = useState<"plain" | "codes" | null>(null);
  const [preprocessDraft, setPreprocessDraft] = useState<PreprocessDraft | null>(null);
  const [patternImporting, setPatternImporting] = useState(false);
  const [patternImportStatus, setPatternImportStatus] = useState("正在识别…");
  const imageInputRef = useRef<HTMLInputElement>(null);
  const patternInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const history = useRef<WorkbenchProject[]>([]);
  const future = useRef<WorkbenchProject[]>([]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const refreshGallery = useCallback(async () => {
    try {
      setGallery(await listProjects());
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const migrated = await migrateLegacyProjectOnce();
        const summaries = await listProjects();
        if (!cancelled) {
          // Opening the site or installed app always starts at the home page.
          // Saved projects stay available from the local gallery, but are no
          // longer opened implicitly just because they were used last time.
          setProject(null);
          setGallery(summaries);
          if (migrated) notify("已把旧版图纸迁移到专业工作台");
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) notify("本地项目库初始化失败，请检查浏览器存储权限");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [notify]);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const handler = (event: Event) => {
      event.preventDefault();
      const promptEvent = event as BeforeInstallPromptEvent;
      window.__pwaInstallPrompt = promptEvent;
      setInstallPrompt(promptEvent);
    };
    const promptReady = () => setInstallPrompt(window.__pwaInstallPrompt ?? null);
    const updateStandalone = () => setStandalone(isStandalone());
    const installed = () => {
      window.__pwaInstallPrompt = null;
      setInstallPrompt(null);
      updateStandalone();
      notify("安装完成，请关闭当前网页并从桌面新图标打开");
    };
    updateStandalone();
    promptReady();
    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("pwa-install-ready", promptReady);
    window.addEventListener("appinstalled", installed);
    displayMode.addEventListener?.("change", updateStandalone);
    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      window.removeEventListener("pwa-install-ready", promptReady);
      window.removeEventListener("appinstalled", installed);
      displayMode.removeEventListener?.("change", updateStandalone);
    };
  }, [notify]);

  useEffect(() => {
    if (!project) return;
    const id = window.setTimeout(async () => {
      setSaving(true);
      try {
        await saveProject(project, renderProjectThumbnail(project));
        await refreshGallery();
      } catch (error) {
        console.error(error);
        notify("自动保存失败，本次修改仍保留在页面中");
      } finally {
        setSaving(false);
      }
    }, 650);
    return () => window.clearTimeout(id);
  }, [project, notify, refreshGallery]);

  useEffect(() => {
    if (project?.timer.runningSince === null || project?.timer.runningSince === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [project?.timer.runningSince]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  const updateProject = useCallback((updater: (current: WorkbenchProject) => WorkbenchProject, undoable = false) => {
    setProject((current) => {
      if (!current) return current;
      if (undoable) {
        const historyLimit = current.cells.length > 10_000 ? 12 : current.cells.length > 4_000 ? 30 : 60;
        history.current = [...history.current.slice(-(historyLimit - 1)), current];
        future.current = [];
      }
      const next = updater(current);
      return next === current ? current : { ...next, updatedAt: Date.now() };
    });
  }, []);

  const activateProject = useCallback((next: WorkbenchProject) => {
    const firstUsed = colorStatistics(next)[0]?.id ?? next.palette[0]?.id ?? FULL_PALETTE[0]?.id ?? null;
    setSelectedColorId(firstUsed);
    setProject({
      ...next,
      palette: next.palette.length ? next.palette : FULL_PALETTE,
      bead: { ...next.bead, selectedColorId: next.bead.selectedColorId ?? firstUsed },
    });
    history.current = [];
    future.current = [];
  }, []);

  const returnHome = async () => {
    setSettingsOpen(false);
    if (project) {
      try {
        await saveProject(project, renderProjectThumbnail(project));
        await refreshGallery();
      } catch (error) {
        console.error(error);
        notify("返回主页前保存失败，项目仍保留在当前页面");
        return;
      }
    }
    setProject(null);
  };

  const openImageEditor = async (file: File, mode: "photo" | "pattern") => {
    if (validateImportFile(file) !== "image") throw new Error("请选择 JPEG、PNG、WebP 或 GIF 图片");
    if (file.size > 40 * 1024 * 1024) throw new Error("图片不能超过 40 MB");
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImage(dataUrl);
    setPreprocessDraft({
      file,
      dataUrl,
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      mode,
    });
  };

  const handleFiles = async (files: FileList | File[]) => {
    const file = files[0];
    if (!file) return;
    try {
      const kind = validateImportFile(file);
      if (kind === "image") {
        await openImageEditor(file, "photo");
        return;
      }
      const imported = await importProjectFile(file);
      const next = kind === "project" ? imported : {
        ...imported,
        colorSystem: preferences.colorSystem,
        bead: { ...imported.bead, unfinishedOpacity: preferences.unfinishedOpacity },
      };
      activateProject(next);
      notify("项目导入成功");
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入失败");
    }
  };

  const handleFileInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = input.files ? [...input.files] : [];
    input.value = "";
    if (files.length) await handleFiles(files);
  };

  const handlePatternFileInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      await openImageEditor(file, "pattern");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法读取成品图纸");
    }
  };

  const completeImagePreprocess = async (result: ImagePreprocessCompleteResult) => {
    if (!preprocessDraft || patternImporting) return;
    setPatternImporting(true);
    try {
      const activePalette = project?.palette.length ? project.palette : FULL_PALETTE;
      let next: WorkbenchProject;
      if (preprocessDraft.mode === "pattern") {
        if (!result.grid) throw new Error("尚未识别到稳定网格，请调整裁剪框后点“自动对齐拼豆网格”");
        setPatternImportStatus(`已对齐 ${result.grid.columns}×${result.grid.rows} 格，正在读取色号…`);
        next = await projectFromPatternImage(
          result.processed.file,
          {
            width: result.grid.columns,
            height: result.grid.rows,
            colorSystem: preferences.colorSystem,
            onStatus: setPatternImportStatus,
          },
          activePalette,
        );
      } else {
        setPatternImportStatus("正在按原图比例生成图纸…");
        next = await projectFromImage(
          result.processed.file,
          result.detail,
          result.detail,
          project?.optimize.mode ?? "dominant",
          activePalette,
        );
      }
      const originalName = preprocessDraft.file.name.replace(/\.[^.]+$/, "") || "未命名图纸";
      next = {
        ...next,
        name: preprocessDraft.mode === "pattern" ? `${originalName}·拼豆` : originalName,
        colorSystem: preferences.colorSystem,
        bead: { ...next.bead, unfinishedOpacity: preferences.unfinishedOpacity },
      };
      activateProject(next);
      setPreprocessDraft(null);
      notify(preprocessDraft.mode === "pattern"
        ? `已保留 ${next.optimize.width}×${next.optimize.height} 格布局并进入拼豆辅助`
        : `已按原图比例生成 ${next.optimize.width}×${next.optimize.height} 格图纸`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "图片处理失败");
      throw error;
    } finally {
      setPatternImporting(false);
    }
  };

  const stats = useMemo(() => project ? colorStatistics(project) : [], [project]);
  const usedPalette = useMemo(() => stats.map((item) => ({ ...item, entry: paletteEntryById(item.id) })).filter((item) => item.entry), [stats]);
  const progress = project ? projectProgress(project) : 0;
  const selectedEntry = paletteEntryById(project?.bead.selectedColorId ?? selectedColorId);
  const selectedStats = stats.find((item) => item.id === selectedEntry?.id);

  const changeStage = (stage: WorkbenchStage) => {
    setSettingsOpen(false);
    if (stage === "edit" || stage === "bead") setHighlightColorId(null);
    updateProject((current) => ({
      ...current,
      stage,
      timer: stage === "bead" ? startTimer(current.timer) : pauseTimer(current.timer),
      bead: stage === "bead" ? {
        ...current.bead,
        selectedColorId: current.bead.selectedColorId ?? selectedColorId ?? stats[0]?.id ?? null,
      } : current.bead,
    }));
  };

  const handleCellAction = (index: number, activeTool: EditTool, continuingStroke = false) => {
    updateProject((current) => {
      const result = applyEditAction(current, index, activeTool, selectedColorId);
      if (result.pickedColorId) setSelectedColorId(result.pickedColorId);
      return result.project;
    }, activeTool !== "picker" && !continuingStroke);
  };

  const handleBeadCell = (index: number) => {
    updateProject((current) => {
      const cell = current.cells[index];
      if (!cell?.colorId) return current;
      if (cell.colorId !== current.bead.selectedColorId) {
        setSelectedColorId(cell.colorId);
        return { ...current, bead: { ...current.bead, selectedColorId: cell.colorId, activeCellIndex: index } };
      }
      const cells = current.cells.map((item) => ({ ...item }));
      cells[index].completed = !cells[index].completed;
      const completedAll = cells.every((item) => !item.colorId || item.completed);
      return { ...current, cells, timer: completedAll ? pauseTimer(current.timer) : current.timer, bead: { ...current.bead, activeCellIndex: index } };
    }, true);
  };

  const completeActiveRegion = () => {
    if (!project?.bead.selectedColorId) return;
    updateProject((current) => {
      const regions = allRegions(current.cells, current.optimize.width, current.optimize.height, current.bead.selectedColorId ?? undefined);
      const region = chooseGuidedRegion(
        regions,
        current.bead.guidanceMode,
        current.bead.activeCellIndex,
        current.optimize.width,
        current.optimize.height,
      );
      if (!region) return current;
      const cells = current.cells.map((cell) => ({ ...cell }));
      region.cells.forEach((point) => { cells[point.index].completed = true; });
      const completedAll = cells.every((item) => !item.colorId || item.completed);
      return { ...current, cells, timer: completedAll ? pauseTimer(current.timer) : current.timer, bead: { ...current.bead, activeCellIndex: region.cells[region.cells.length - 1]?.index ?? null } };
    }, true);
  };

  const undo = () => {
    setProject((current) => {
      const previous = history.current.pop();
      if (!current || !previous) return current;
      future.current.push(current);
      return { ...previous, updatedAt: Date.now() };
    });
  };

  const redo = () => {
    setProject((current) => {
      const next = future.current.pop();
      if (!current || !next) return current;
      history.current.push(current);
      return { ...next, updatedAt: Date.now() };
    });
  };

  const exportPng = async (codes = false) => {
    if (!project) return;
    const blob = await renderProjectPng(project, codes, includeExportStats);
    if (blob) downloadBlob(blob, `${project.name}${codes ? "-色号" : ""}.png`);
  };

  const savePngToPhotos = async (codes = false) => {
    if (!project || preparingPhoto) return;
    const kind = codes ? "codes" : "plain";
    const key = `${project.id}:${project.updatedAt}:${includeExportStats}:${kind}`;
    let prepared = preparedPhoto?.key === key ? preparedPhoto : null;
    if (!prepared) {
      setPreparingPhoto(kind);
      let blob: Blob | null = null;
      try {
        blob = await renderProjectPng(project, codes, includeExportStats);
      } catch (error) {
        console.error(error);
      } finally {
        setPreparingPhoto(null);
      }
      if (!blob) {
        notify("图纸图片生成失败");
        return;
      }
      prepared = {
        key,
        blob,
        filename: `${project.name}${codes ? "-色号" : ""}.png`,
        title: `${project.name}${codes ? "（格内色号）" : ""}`,
      };
      setPreparedPhoto(prepared);
    }
    try {
      const result = await saveImageToPhotos(prepared.blob, prepared.filename, prepared.title);
      notify(result === "shared" ? "系统操作已完成" : "当前浏览器不支持相册面板，已下载 PNG");
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return;
      if ((error as DOMException)?.name === "NotAllowedError") {
        notify("图片已生成，请再点一次“打开系统保存面板”");
        return;
      }
      notify("系统保存面板未能打开，可使用下方 PNG 下载");
    }
  };

  const openProjectFromGallery = async (id: string) => {
    const next = await loadProject(id);
    if (next) {
      activateProject(next);
      setGalleryOpen(false);
    }
  };

  const duplicateGalleryProject = async (id: string) => {
    const source = await loadProject(id);
    if (!source) return;
    const copy = createProject({
      ...source,
      id: undefined,
      name: `${source.name} 副本`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cells: source.cells.map((cell) => ({ ...cell })),
      palette: source.palette.map((entry) => ({ ...entry, codes: { ...entry.codes } })),
    });
    await saveProject(copy, renderProjectThumbnail(copy));
    await refreshGallery();
    notify("已创建项目副本");
  };

  const exportGalleryProject = async (id: string) => {
    const source = await loadProject(id);
    if (source) downloadProject(source, true);
  };

  const installApp = async () => {
    const promptEvent = installPrompt ?? window.__pwaInstallPrompt ?? null;
    if (!promptEvent) {
      setInstallOpen(true);
      return;
    }
    try {
      await promptEvent.prompt();
      const result = await promptEvent.userChoice;
      window.__pwaInstallPrompt = null;
      setInstallPrompt(null);
      if (result.outcome === "accepted") {
        notify("安装完成后，请从桌面新图标打开独立 App");
      } else {
        setInstallOpen(true);
      }
    } catch (error) {
      console.error(error);
      window.__pwaInstallPrompt = null;
      setInstallPrompt(null);
      setInstallOpen(true);
    }
  };

  const openInChromeForInstall = () => {
    const fallbackUrl = encodeURIComponent("https://xugcc.github.io/PIN-Design/?source=install");
    window.location.href = `intent://xugcc.github.io/PIN-Design/?source=install#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallbackUrl};end`;
  };

  if (loading) {
    return <main className="wb-loading"><div className="wb-loader" /><p>正在载入主页…</p></main>;
  }

  return (
    <main className="wb-app">
      <input
        ref={imageInputRef}
        type="file"
        hidden
        accept="image/*"
        onChange={handleFileInput}
      />
      <input
        ref={patternInputRef}
        data-testid="pattern-image-input"
        type="file"
        hidden
        accept="image/*"
        onChange={handlePatternFileInput}
      />
      <input
        ref={projectInputRef}
        type="file"
        hidden
        accept=".csv,text/csv,.json,application/json,.perler"
        onChange={handleFileInput}
      />

      {!project ? (
        <section className="wb-start">
          <div className="wb-start-brand">
            <div className="wb-logo-grid"><i /><i /><i /><i /></div>
            <span>七卡瓦</span>
          </div>
          <div className="wb-home-actions">
            <button
              className="wb-home-gallery"
              type="button"
              onClick={() => {
                refreshGallery();
                setGalleryOpen(true);
              }}
            >我的画廊</button>
            {!standalone && (
              <button
                className="wb-home-install"
                type="button"
                onClick={() => installPrompt ? installApp() : setInstallOpen(true)}
              >安装应用</button>
            )}
          </div>
          <div className="wb-start-hero">
            <span className="wb-eyebrow">本地 · 私密 · 可安装</span>
            <h1>拼豆专业工作台</h1>
            <p>选择照片生成新图纸，或导入现有成品图纸继续拼豆。</p>
          </div>
          <div
            className="wb-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); handleFiles(event.dataTransfer.files); }}
          >
            <div className="wb-upload-icon">⇧</div>
            <h2>选择你的图片</h2>
            <p>上传后可先裁剪、旋转和翻转，再生成准确比例的拼豆图纸</p>
            <div className="wb-import-actions">
              <button className="wb-primary" type="button" onClick={() => imageInputRef.current?.click()}>从相册选图</button>
              <button type="button" onClick={() => patternInputRef.current?.click()}>导入成品图纸</button>
            </div>
          </div>
          <p className="wb-privacy">🔒 图片处理与项目保存都在你的设备上完成，不上传服务器。</p>
        </section>
      ) : (
        <>
          <header className="wb-header">
            <nav className="wb-stage-nav" aria-label="工作阶段">
              <button type="button" onClick={returnHome}>主页</button>
              {STAGES.map((stage) => (
                <button
                  type="button"
                  key={stage.id}
                  className={project.stage === stage.id ? "active" : ""}
                  onClick={() => changeStage(stage.id)}
                >{stage.label}</button>
              ))}
              <button
                type="button"
                className={settingsOpen ? "active settings-active" : ""}
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen(true)}
              >设置</button>
            </nav>
            <span className="wb-save-state" aria-live="polite">{saving ? "保存中…" : "已保存"}</span>
          </header>

          <section className="wb-workspace">
            <div className="wb-canvas-shell">
              {project.stage === "bead" && (
                <div className="wb-bead-cards">
                  <div className="wb-color-card">
                    <span className="wb-card-swatch" style={{ background: selectedEntry?.hex ?? "#ddd" }} />
                    <div><strong>{selectedEntry ? paletteCode(selectedEntry, project.colorSystem) : "未选颜色"}</strong><small>{selectedStats ? `${selectedStats.completed}/${selectedStats.count} · ${Math.round(selectedStats.completed / selectedStats.count * 100)}%` : "0/0 · 0%"}</small></div>
                  </div>
                  <button
                    type="button"
                    className="wb-timer-card"
                    onClick={() => updateProject((current) => ({
                      ...current,
                      timer: current.timer.runningSince === null ? startTimer(current.timer) : pauseTimer(current.timer),
                    }))}
                  >
                    <span>{formatElapsed(timerElapsed(project.timer, now))}</span>
                    <b>{project.timer.runningSince === null ? "▶" : "Ⅱ"}</b>
                  </button>
                </div>
              )}
              <WorkbenchCanvas
                project={project}
                tool={tool}
                compareOriginal={compareOriginal}
                highlightColorId={highlightColorId}
                onCellAction={handleCellAction}
                onBeadCell={handleBeadCell}
                locateRequest={locateRequest}
              />
              <div className="wb-floating-actions">
                {project.stage === "edit" && (
                  <>
                    <button type="button" onClick={undo} disabled={!history.current.length} title="撤销">↶</button>
                    <button type="button" onClick={redo} disabled={!future.current.length} title="重做">↷</button>
                  </>
                )}
                {project.stage === "bead" && (
                  <>
                    <button type="button" onClick={() => setLocateRequest((value) => value + 1)} title="定位当前区域">⌖</button>
                    <button className="complete" type="button" onClick={completeActiveRegion} title="完成当前区域">✓</button>
                    <button type="button" onClick={undo} disabled={!history.current.length} title="撤销">↶</button>
                  </>
                )}
              </div>
            </div>

            {settingsOpen && (
            <Modal
              title={`${project.stage === "optimize" ? "图纸优化" : project.stage === "edit" ? "像素编辑" : project.stage === "preview" ? "图纸预览" : "拼豆引导"}设置 · ${project.optimize.width}×${project.optimize.height}`}
              onClose={() => setSettingsOpen(false)}
            >
              <div className="wb-settings-content">
              <label className="wb-project-name"><span>项目名</span><input value={project.name} maxLength={60} onChange={(event) => updateProject((current) => ({ ...current, name: event.target.value }))} onBlur={() => updateProject((current) => ({ ...current, name: current.name.trim() || "未命名拼豆项目" }))} /></label>

              {project.stage === "optimize" && (
                <>
                  <Panel title="网格与算法">
                    {project.sourceImage ? (
                      <label className="wb-range">
                        <span>图纸清晰度 <b>{Math.max(project.optimize.width, project.optimize.height)} 级 · {project.optimize.width}×{project.optimize.height} 格</b></span>
                        <input type="range" min="10" max="200" value={Math.max(project.optimize.width, project.optimize.height)} onChange={(event) => {
                          const size = gridSizeForAspect(project.sourceImage!.width, project.sourceImage!.height, Number(event.target.value));
                          updateProject((current) => ({
                            ...current,
                            cells: resizeCells(current.cells, current.optimize.width, current.optimize.height, size.width, size.height),
                            optimize: { ...current.optimize, ...size },
                          }), true);
                        }} />
                      </label>
                    ) : (
                    <div className="wb-field-row">
                      <label>宽<input type="number" min="1" max="200" value={project.optimize.width} onChange={(e) => {
                        const width = Math.max(1, Math.min(200, Number(e.target.value) || 1));
                        updateProject((current) => ({ ...current, cells: resizeCells(current.cells, current.optimize.width, current.optimize.height, width, current.optimize.height), optimize: { ...current.optimize, width } }), true);
                      }} /></label>
                      <label>高<input type="number" min="1" max="200" value={project.optimize.height} onChange={(e) => {
                        const height = Math.max(1, Math.min(200, Number(e.target.value) || 1));
                        updateProject((current) => ({ ...current, cells: resizeCells(current.cells, current.optimize.width, current.optimize.height, current.optimize.width, height), optimize: { ...current.optimize, height } }), true);
                      }} /></label>
                    </div>
                    )}
                    <Segmented options={[{ id: "dominant", label: "主色" }, { id: "average", label: "平均色" }]} value={project.optimize.mode} onChange={(mode) => updateProject((current) => ({ ...current, optimize: { ...current.optimize, mode: mode as "dominant" | "average" } }))} />
                    {project.sourceImage && <button className="wb-block-button" type="button" onClick={async () => {
                      if (!window.confirm("重新生成会覆盖当前手动编辑和拼豆完成进度，是否继续？")) return;
                      const response = await fetch(project.sourceImage!.dataUrl);
                      const blob = await response.blob();
                      const file = new File([blob], project.sourceImage!.name, { type: project.sourceImage!.mimeType });
                      const regenerated = await projectFromImage(file, project.optimize.width, project.optimize.height, project.optimize.mode, project.palette);
                      updateProject((current) => ({ ...regenerated, id: current.id, name: current.name, createdAt: current.createdAt }), true);
                    }}>按当前设置重新生成</button>}
                    {project.sourceImage && <Toggle label="显示原图对比" checked={compareOriginal} onChange={setCompareOriginal} />}
                  </Panel>
                  <Panel title="颜色优化">
                    <label className="wb-range"><span>相似色合并阈值 <b>{project.optimize.mergeTolerance}</b></span><input type="range" min="0" max="30" value={project.optimize.mergeTolerance} onChange={(e) => updateProject((current) => ({ ...current, optimize: { ...current.optimize, mergeTolerance: Number(e.target.value) } }))} /></label>
                    <button className="wb-block-button" type="button" onClick={() => updateProject((current) => mergeSimilarColors(current, current.optimize.mergeTolerance), true)}>合并相似颜色</button>
                    <label className="wb-select-label">色号体系<select value={project.colorSystem} onChange={(e) => { const colorSystem = e.target.value as ColorSystem; updateProject((current) => ({ ...current, colorSystem })); setPreferences((current) => ({ ...current, colorSystem })); }}>{COLOR_SYSTEMS.map((system) => <option key={system}>{system}</option>)}</select></label>
                    <Toggle label="移除背景色" checked={project.optimize.removeBackground} onChange={(checked) => updateProject((current) => ({ ...current, optimize: { ...current.optimize, removeBackground: checked } }))} />
                    {project.optimize.removeBackground && (
                      <div className="wb-background-row"><input type="color" value={project.optimize.backgroundColor} onChange={(e) => updateProject((current) => ({ ...current, optimize: { ...current.optimize, backgroundColor: e.target.value.toUpperCase() } }))} /><button type="button" onClick={() => {
                        const target = nearestPaletteEntry(project.optimize.backgroundColor, project.palette);
                        updateProject((current) => ({ ...current, cells: current.cells.map((cell) => cell.colorId === target.id ? { colorId: null, completed: false } : cell) }), true);
                      }}>应用</button></div>
                    )}
                  </Panel>
                  <Panel title={`颜色清单 · ${stats.length} 色`}>
                    {highlightColorId && <button className="wb-text-button" type="button" onClick={() => setHighlightColorId(null)}>清除颜色高亮</button>}
                    <button className="wb-block-button" type="button" onClick={() => setPaletteManagerOpen(true)}>自定义可用色板 · {project.palette.length} 色</button>
                    <button className="wb-text-button" type="button" onClick={() => setShowExclusions((value) => !value)}>{showExclusions ? "收起颜色排除" : "展开颜色排除与重映射"}</button>
                    {showExclusions && <div className="wb-color-exclusions">{usedPalette.map(({ id, count, entry }) => <label key={id}><input type="checkbox" checked={!project.optimize.excludedColorIds.includes(id)} onChange={(e) => updateProject((current) => ({ ...current, optimize: { ...current.optimize, excludedColorIds: e.target.checked ? current.optimize.excludedColorIds.filter((item) => item !== id) : [...current.optimize.excludedColorIds, id] } }))} /><i style={{ background: entry!.hex }} /><span>{paletteCode(entry!, project.colorSystem)}</span><small>{count}</small></label>)}<button className="wb-block-button" type="button" onClick={() => updateProject(remapExcludedColors, true)}>重映射已排除颜色</button></div>}
                  </Panel>
                </>
              )}

              {project.stage === "edit" && (
                <>
                  <Panel title="编辑工具"><div className="wb-tool-grid">{TOOL_LABELS.map((item) => <button type="button" key={item.id} className={tool === item.id ? "active" : ""} onClick={() => setTool(item.id)}><b>{item.icon}</b><span>{item.label}</span></button>)}</div></Panel>
                  <Panel title="当前颜色"><button type="button" className="wb-current-color" onClick={() => setColorPickerOpen(true)}><i style={{ background: paletteEntryById(selectedColorId)?.hex }} /><div><strong>{paletteEntryById(selectedColorId) ? paletteCode(paletteEntryById(selectedColorId)!, project.colorSystem) : "请选择"}</strong><small>{paletteEntryById(selectedColorId)?.hex} · 点击打开完整色板</small></div><b>›</b></button><p className="wb-help">可在上方选择吸色或替换同色；单指拖动画布，双指缩放。</p></Panel>
                  <Panel title="历史"><div className="wb-two-buttons"><button type="button" disabled={!history.current.length} onClick={undo}>↶ 撤销</button><button type="button" disabled={!future.current.length} onClick={redo}>↷ 重做</button></div></Panel>
                </>
              )}

              {project.stage === "preview" && (
                <>
                  <Panel title="显示"><Toggle label="细网格" checked={project.preview.showGrid} onChange={(checked) => updateProject((current) => ({ ...current, preview: { ...current.preview, showGrid: checked } }))} /><Toggle label="网格分割线" checked={project.preview.showSectionLines} onChange={(checked) => updateProject((current) => ({ ...current, preview: { ...current.preview, showSectionLines: checked } }))} /><label className="wb-range"><span>分割间隔 <b>{project.preview.sectionInterval} 格</b></span><input type="range" min="5" max="20" value={project.preview.sectionInterval} onChange={(e) => updateProject((current) => ({ ...current, preview: { ...current.preview, sectionInterval: Number(e.target.value) } }))} /></label><Toggle label="格内显示色号" checked={project.preview.showColorCodes} onChange={(checked) => updateProject((current) => ({ ...current, preview: { ...current.preview, showColorCodes: checked } }))} /><Toggle label="坐标刻度（导出）" checked={project.preview.showCoordinates} onChange={(checked) => updateProject((current) => ({ ...current, preview: { ...current.preview, showCoordinates: checked } }))} /></Panel>
                  <Panel title="统计">{highlightColorId && <button className="wb-text-button" type="button" onClick={() => setHighlightColorId(null)}>显示全部颜色</button>}<div className="wb-stats-list">{usedPalette.slice(0, 30).map(({ id, count, entry }) => <button key={id} type="button" onClick={() => { setSelectedColorId(id); setHighlightColorId(id); }}><i style={{ background: entry!.hex }} /><span>{paletteCode(entry!, project.colorSystem)}</span><small>{count} 颗</small></button>)}</div></Panel>
                  <button className="wb-primary wb-wide" type="button" onClick={() => setExportOpen(true)}>下载图纸</button>
                </>
              )}

              {project.stage === "bead" && (
                <>
                  <Panel title="进度"><div className="wb-progress-head"><strong>{progress}%</strong><span>{project.cells.filter((cell) => cell.completed).length}/{project.cells.filter((cell) => cell.colorId).length} 颗</span></div><div className="wb-progress"><i style={{ width: `${progress}%` }} /></div></Panel>
                  <Panel title="引导"><Segmented options={[{ id: "nearest", label: "最近优先" }, { id: "largest", label: "大块优先" }, { id: "edge", label: "边缘优先" }]} value={project.bead.guidanceMode} onChange={(value) => updateProject((current) => ({ ...current, bead: { ...current.bead, guidanceMode: value as "nearest" | "largest" | "edge", activeCellIndex: null } }))} /></Panel>
                  <Panel title="未完成状态"><label className="wb-range"><span>淡化程度 <b>{project.bead.unfinishedOpacity}%</b></span><input type="range" min="10" max="50" value={project.bead.unfinishedOpacity} onChange={(e) => {
                    const unfinishedOpacity = Number(e.target.value);
                    updateProject((current) => ({ ...current, bead: { ...current.bead, unfinishedOpacity } }));
                    setPreferences((current) => ({ ...current, unfinishedOpacity }));
                  }} /></label><p className="wb-help">非当前色转为浅灰；当前色与正在拼的区域保留淡色，完成后恢复原色。</p></Panel>
                  <Panel title="数量提示"><Toggle label="显示当前区域数量" checked={project.bead.showCountHints} onChange={(checked) => updateProject((current) => ({ ...current, bead: { ...current.bead, showCountHints: checked } }))} /><Segmented options={[{ id: "auto", label: "自动" }, { id: "horizontal", label: "横向" }, { id: "vertical", label: "竖向" }]} value={project.bead.countDirection} onChange={(value) => updateProject((current) => ({ ...current, bead: { ...current.bead, countDirection: value as "auto" | "horizontal" | "vertical" } }))} /><p className="wb-help">只统计当前粉色轮廓内尚未完成的连续段。自动模式选择标签较少的方向，并在当前区域内保持不变。</p></Panel>
                  <Panel title="分割线"><Toggle label="网格分割线" checked={project.bead.showSectionLines} onChange={(checked) => updateProject((current) => ({ ...current, bead: { ...current.bead, showSectionLines: checked } }))} /><label className="wb-range"><span>间隔 <b>{project.bead.sectionInterval} 格</b></span><input type="range" min="5" max="20" value={project.bead.sectionInterval} onChange={(e) => updateProject((current) => ({ ...current, bead: { ...current.bead, sectionInterval: Number(e.target.value) } }))} /></label></Panel>
                  {progress === 100 && <div className="wb-complete-card"><span>🎉</span><strong>这张图纸已经拼完了！</strong><button type="button" onClick={() => setExportOpen(true)}>保存成品图纸</button></div>}
                </>
              )}

              <Panel title="项目与应用">
                <div className="wb-settings-actions">
                  <button type="button" onClick={() => projectInputRef.current?.click()}>导入项目备份</button>
                  <button type="button" onClick={() => { setSettingsOpen(false); setExportOpen(true); }}>下载与备份</button>
                  <button type="button" onClick={() => { refreshGallery(); setSettingsOpen(false); setGalleryOpen(true); }}>本地画廊</button>
                  {!standalone && <button type="button" onClick={() => { setSettingsOpen(false); setInstallOpen(true); }}>安装到手机</button>}
                </div>
              </Panel>
              </div>
            </Modal>
            )}
          </section>

          <div className="wb-palette-bar" aria-label="颜色色板">
            <div className="wb-palette-title"><strong>{usedPalette.length}</strong><span>种颜色</span></div>
            <div className="wb-palette-scroll">
              {(usedPalette.length ? usedPalette : FULL_PALETTE.slice(0, 40).map((entry) => ({ id: entry.id, count: 0, completed: 0, entry }))).map(({ id, count, completed, entry }) => (
                <button
                  type="button"
                  key={id}
                  className={[
                    (project.stage === "bead" ? project.bead.selectedColorId : selectedColorId) === id ? "active" : "",
                    project.stage === "bead" && count > 0 && completed === count ? "completed" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => {
                    setSelectedColorId(id);
                    if (project.stage === "optimize" || project.stage === "preview") setHighlightColorId(id);
                    if (project.stage === "bead") updateProject((current) => ({ ...current, bead: { ...current.bead, selectedColorId: id, activeCellIndex: null } }));
                  }}
                  title={`${paletteCode(entry!, project.colorSystem)} · ${count} 颗`}
                >
                  <i style={{ background: entry!.hex }} />
                  <span>{paletteCode(entry!, project.colorSystem)}</span>
                  {project.stage === "bead" && (completed === count && count > 0 ? <small className="wb-color-complete">✓ 完成</small> : <small>{completed}/{count}</small>)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {preprocessDraft && (
        <Modal
          title={preprocessDraft.mode === "pattern" ? "对齐并识别成品图纸" : "裁剪并生成图纸"}
          onClose={() => { if (!patternImporting) setPreprocessDraft(null); }}
        >
          {patternImporting && (
            <p className="wb-pattern-status" role="status">{patternImportStatus}</p>
          )}
          <ImagePreprocessEditor
            draft={preprocessDraft}
            mode={preprocessDraft.mode}
            initialDetail={project ? Math.max(project.optimize.width, project.optimize.height) : 40}
            onCancel={() => setPreprocessDraft(null)}
            onComplete={completeImagePreprocess}
          />
          <p className="wb-modal-note">
            {preprocessDraft.mode === "pattern"
              ? "色号图纸以格内文字为准，没有文字的格子按空白处理；整张图都没有色号文字时才改用颜色匹配。"
              : "裁剪后的长宽比例会被锁定，只用“图纸清晰度”控制格子多少，不会拉伸图片。"}
          </p>
        </Modal>
      )}

      {galleryOpen && (
        <Modal title="本地画廊" onClose={() => setGalleryOpen(false)}>
          <div className="wb-gallery-grid">
            {gallery.length ? gallery.map((item) => (
              <article key={item.id} className="wb-project-card">
                <button type="button" className="wb-project-open" onClick={() => openProjectFromGallery(item.id)}>
                  {item.thumbnail ? <img src={item.thumbnail} alt="" /> : <div className="wb-project-placeholder">▦</div>}
                  <strong>{item.name}</strong><span>{item.width} × {item.height} · {item.progress}%</span><small>{new Date(item.updatedAt).toLocaleString("zh-CN")}</small>
                </button>
                <div className="wb-project-card-actions"><button type="button" onClick={() => duplicateGalleryProject(item.id)}>复制</button><button type="button" onClick={() => exportGalleryProject(item.id)}>导出</button><button className="danger" type="button" onClick={async () => { if (!window.confirm(`确定删除“${item.name}”吗？删除后无法恢复。建议先导出项目备份。`)) return; await deleteProject(item.id); await refreshGallery(); if (project?.id === item.id) setProject(null); }}>删除</button></div>
              </article>
            )) : <div className="wb-empty">还没有保存的项目</div>}
          </div>
        </Modal>
      )}

      {exportOpen && project && (
        <Modal title="下载与备份" onClose={() => setExportOpen(false)}>
          <div className="wb-export-grid">
            <button type="button" disabled={Boolean(preparingPhoto)} onClick={() => savePngToPhotos(false)}><b>相册</b><span>彩色图纸</span><small>{preparingPhoto === "plain" ? "正在生成图片…" : preparedPhoto?.key === `${project.id}:${project.updatedAt}:${includeExportStats}:plain` ? "打开系统保存面板" : "保存到相册或分享"}</small></button>
            <button type="button" disabled={Boolean(preparingPhoto)} onClick={() => savePngToPhotos(true)}><b>相册</b><span>格内色号</span><small>{preparingPhoto === "codes" ? "正在生成图片…" : preparedPhoto?.key === `${project.id}:${project.updatedAt}:${includeExportStats}:codes` ? "打开系统保存面板" : "保存到相册或分享"}</small></button>
            <button type="button" onClick={() => exportPng(false)}><b>PNG</b><span>下载彩色图纸</span><small>保存到“下载”文件夹</small></button>
            <button type="button" onClick={() => exportPng(true)}><b>PNG</b><span>下载色号图纸</span><small>保存到“下载”文件夹</small></button>
            <button type="button" onClick={() => downloadCsv(project)}><b>CSV</b><span>像素数据</span><small>可再次导入</small></button>
            <button type="button" onClick={() => downloadProject(project, includeBackupSource)}><b>项目</b><span>完整备份</span><small>包含设置与进度</small></button>
          </div>
          <div className="wb-export-options"><Toggle label="PNG 包含用色统计" checked={includeExportStats} onChange={setIncludeExportStats} /><Toggle label="项目备份包含原图" checked={includeBackupSource} onChange={setIncludeBackupSource} /></div>
          <p className="wb-modal-note">手机点“相册”后，请在系统面板选择“保存图片 / 存储图像 / 相册”。若系统不支持，会自动下载 PNG。建议定期下载“完整备份”。</p>
        </Modal>
      )}

      {installOpen && (
        <Modal title="安装到手机主屏幕" onClose={() => setInstallOpen(false)}>
          {standalone ? <div className="wb-installed">✓ 已在独立应用模式中运行</div> : <>
            <Segmented options={[{ id: "android", label: "Android / 小米" }, { id: "ios", label: "iPhone / iPad" }]} value={installTab} onChange={(value) => { setInstallTab(value as "android" | "ios"); setPreferences((current) => ({ ...current, lastInstallPlatform: value as "android" | "ios" })); }} />
            {installTab === "android" ? <div className="wb-install-guide"><div className="wb-device-badge">{installPrompt ? "当前浏览器支持独立 PWA 安装" : "当前浏览器未提供系统安装入口"}</div><ol><li>先删除桌面上会出现浏览器栏的旧网页快捷方式。</li><li>{installPrompt ? <>点击下方“<strong>立即安装应用</strong>”。</> : <>点击下方“<strong>用 Chrome 打开并安装</strong>”。</>}</li><li>在浏览器安装提示中确认“<strong>安装</strong>”，不要只选“添加网页快捷方式”。</li><li>安装完成后关闭当前网页，从桌面新图标打开；此时不会显示浏览器地址栏和底部菜单。</li></ol>{installPrompt ? <button className="wb-primary wb-wide" type="button" onClick={installApp}>立即安装应用</button> : <button className="wb-primary wb-wide" type="button" onClick={openInChromeForInstall}>用 Chrome 打开并安装</button>}<details open={!installPrompt}><summary>为什么当前浏览器不能直接安装？</summary><p>网页已经使用 standalone 独立显示模式，但是否提供真正的 PWA 安装仍由浏览器决定。小米 AI 浏览器若只创建网页快捷方式，打开后仍会有地址栏；请改用 Chrome 安装，并从新生成的桌面图标启动。</p></details></div> : <div className="wb-install-guide"><div className="wb-device-badge">iOS 使用 Safari 添加到主屏幕</div><ol><li>用 <strong>Safari</strong> 打开工作台的 HTTPS 地址。</li><li>点底部工具栏的“<strong>分享</strong>”按钮（方框向上箭头）。</li><li>向下滑并点“<strong>添加到主屏幕</strong>”。</li><li>确认名称后点右上角“添加”。</li></ol><p>如果看不到该选项，请确认不是在微信或其他 App 的内置浏览器中打开。</p></div>}
          </>}
        </Modal>
      )}

      {colorPickerOpen && project && (
        <Modal title="选择颜色" onClose={() => setColorPickerOpen(false)}>
          <input className="wb-palette-search" value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)} placeholder="搜索色号或 HEX" autoFocus />
          <div className="wb-full-palette">{FULL_PALETTE.filter((entry) => `${entry.hex} ${Object.values(entry.codes).join(" ")}`.toLowerCase().includes(paletteSearch.toLowerCase())).map((entry) => <button type="button" key={entry.id} className={selectedColorId === entry.id ? "active" : ""} onClick={() => { setSelectedColorId(entry.id); setColorPickerOpen(false); }}><i style={{ background: entry.hex }} /><span>{paletteCode(entry, project.colorSystem)}</span><small>{entry.hex}</small></button>)}</div>
        </Modal>
      )}

      {paletteManagerOpen && project && (
        <Modal title="自定义可用色板" onClose={() => setPaletteManagerOpen(false)}>
          <div className="wb-palette-presets"><button type="button" onClick={() => updateProject((current) => ({ ...current, palette: FULL_PALETTE }))}>全选 {FULL_PALETTE.length} 色</button><button type="button" onClick={() => updateProject((current) => ({ ...current, palette: FULL_PALETTE.filter((entry) => stats.some((item) => item.id === entry.id)) }))}>仅保留当前已用色</button></div>
          <input className="wb-palette-search" value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)} placeholder="搜索色号或 HEX" />
          <p className="wb-modal-note">重新生成图片时只会匹配勾选的颜色；至少保留一种颜色。</p>
          <div className="wb-full-palette wb-palette-manager">{FULL_PALETTE.filter((entry) => `${entry.hex} ${Object.values(entry.codes).join(" ")}`.toLowerCase().includes(paletteSearch.toLowerCase())).map((entry) => {
            const checked = project.palette.some((item) => item.id === entry.id);
            return <button type="button" key={entry.id} className={checked ? "active" : ""} onClick={() => updateProject((current) => {
              const exists = current.palette.some((item) => item.id === entry.id);
              if (exists && current.palette.length === 1) { notify("至少需要保留一种颜色"); return current; }
              return { ...current, palette: exists ? current.palette.filter((item) => item.id !== entry.id) : [...current.palette, entry] };
            })}><i style={{ background: entry.hex }} /><span>{paletteCode(entry, project.colorSystem)}</span><small>{checked ? "✓ 已选" : entry.hex}</small></button>;
          })}</div>
        </Modal>
      )}

      {toast && <div className="wb-toast" role="status">{toast}</div>}
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="wb-panel"><h3>{title}</h3>{children}</section>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="wb-toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><i /></label>;
}

function Segmented({ options, value, onChange }: { options: Array<{ id: string; label: string }>; value: string; onChange: (value: string) => void }) {
  return <div className="wb-segmented">{options.map((option) => <button type="button" key={option.id} className={value === option.id ? "active" : ""} onClick={() => onChange(option.id)}>{option.label}</button>)}</div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="wb-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="wb-modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></header><div className="wb-modal-body">{children}</div></section></div>;
}
