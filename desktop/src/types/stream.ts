export type Resolution = "auto" | "720p" | "1080p" | "1440p" | "2160p";
export type Fps = "auto" | 30 | 60;
export type Quality = "auto" | "low" | "medium" | "high" | "max";

export interface StreamSettings {
  resolution: Resolution;
  fps: Fps;
  quality: Quality;
}

export interface ResolutionConstraint {
  width: number;
  height: number;
}

// Perfis centralizados — nunca espalhar valores rígidos pelo código (CLAUDE.md §Bitrate).
export const RESOLUTION_CONSTRAINTS: Record<Exclude<Resolution, "auto">, ResolutionConstraint> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "2160p": { width: 3840, height: 2160 },
};

export const FPS_OPTIONS: Fps[] = ["auto", 30, 60];
export const RESOLUTION_OPTIONS: Resolution[] = ["auto", "720p", "1080p", "1440p", "2160p"];
export const QUALITY_OPTIONS: Quality[] = ["auto", "low", "medium", "high", "max"];

export const defaultStreamSettings: StreamSettings = {
  resolution: "auto",
  fps: 60,
  quality: "auto",
};

// Bitrate máximo (bps) por resolução, em 30fps. CLAUDE.md §Bitrate: nunca espalhar valores rígidos —
// tudo passa por getMaxBitrate() abaixo.
const BASE_BITRATE_BPS: Record<Exclude<Resolution, "auto">, number> = {
  "720p": 2_500_000,
  "1080p": 4_500_000,
  "1440p": 8_000_000,
  "2160p": 16_000_000,
};

// Multiplicador aplicado ao bitrate base conforme o nível de qualidade escolhido.
const QUALITY_MULTIPLIER: Record<Quality, number> = {
  auto: 1,
  low: 0.5,
  medium: 0.75,
  high: 1,
  max: 1.4,
};

const FALLBACK_RESOLUTION: Exclude<Resolution, "auto"> = "1080p";
const FALLBACK_FPS: Exclude<Fps, "auto"> = 30;

export function getMaxBitrate(settings: StreamSettings): number {
  const resolution = settings.resolution === "auto" ? FALLBACK_RESOLUTION : settings.resolution;
  const fps = settings.fps === "auto" ? FALLBACK_FPS : settings.fps;

  const base = BASE_BITRATE_BPS[resolution];
  const fpsMultiplier = fps === 60 ? 1.5 : 1;
  const qualityMultiplier = QUALITY_MULTIPLIER[settings.quality];

  return Math.round(base * fpsMultiplier * qualityMultiplier);
}
