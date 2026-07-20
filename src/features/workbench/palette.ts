import colorSystemMapping from "@/app/colorSystemMapping.json";
import type { ColorSystem, PaletteEntry } from "./model";

type MappingRow = Partial<Record<ColorSystem, string>>;

export const COLOR_SYSTEMS: ColorSystem[] = ["MARD", "COCO", "漫漫", "盼盼", "咪小窝"];

export const FULL_PALETTE: PaletteEntry[] = Object.entries(colorSystemMapping as Record<string, MappingRow>)
  .map(([hex, codes]) => {
    const normalized = hex.toUpperCase();
    return {
      id: normalized,
      hex: normalized,
      codes,
    };
  })
  .sort((a, b) => (a.codes.MARD ?? a.id).localeCompare(b.codes.MARD ?? b.id, "zh-CN", { numeric: true }));

export const PALETTE_BY_ID = new Map(FULL_PALETTE.map((entry) => [entry.id, entry]));

export function paletteCode(entry: PaletteEntry, system: ColorSystem): string {
  return entry.codes[system] || entry.codes.MARD || entry.id;
}

export function paletteEntryById(id: string | null | undefined): PaletteEntry | undefined {
  if (!id) return undefined;
  return PALETTE_BY_ID.get(id) ?? FULL_PALETTE.find((entry) => entry.id === id || entry.hex === id);
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

export function nearestPaletteEntry(hex: string, palette = FULL_PALETTE): PaletteEntry {
  const [r, g, b] = hexToRgb(hex);
  let best = palette[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of palette) {
    const [pr, pg, pb] = hexToRgb(entry.hex);
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best;
}

