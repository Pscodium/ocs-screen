export type Resolution = "auto" | "720p" | "1080p" | "1440p" | "2160p";
export type Fps = "auto" | 30 | 60;
export type Quality = "auto" | "low" | "medium" | "high" | "max";

export interface StreamSettings {
  resolution: Resolution;
  fps: Fps;
  quality: Quality;
  // Equivalente ao "melhorar texto"/nitidez do Discord — liga `contentHint: "text"` na track de
  // vídeo (ver capture.ts), que faz o encoder priorizar nitidez de borda sobre fluidez de
  // movimento. Ótimo pra código/documento parado, ativamente ruim pra jogo — não é padrão.
  sharpText: boolean;
}

export interface ResolutionConstraint {
  width: number;
  height: number;
}

// Perfis centralizados — nunca espalhar valores rígidos pelo código (CLAUDE.md §Bitrate).
// Espelha desktop/src/types/stream.ts — os dois clientes publicam, então compartilham os mesmos perfis.
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
  resolution: "1080p",
  fps: 60,
  quality: "high",
  sharpText: false,
};

const QUALITY_MULTIPLIER: Record<Quality, number> = {
  auto: 1,
  low: 0.5,
  medium: 0.75,
  high: 1,
  max: 1.4,
};

// Bits por pixel por frame — alvo pra conteúdo de tela (texto/UI tem bordas duras, precisa de
// mais bits por pixel que vídeo de câmera pra não borrar). CLAUDE.md §Bitrate: nunca espalhar
// valores rígidos pelo código — tudo passa por getMaxBitrate() abaixo.
// 0.1 → 0.15: testado em produção com encoder de hardware confirmado rodando 1080p60 "alta" — QP
// médio ficava 30-40 em jogo de movimento rápido mesmo com hardware de sobra, sinal de que o teto
// de bitrate era baixo demais, não que o encoder tava no limite.
const BITS_PER_PIXEL = 0.15;
const MIN_BITRATE_BPS = 1_000_000;
const MAX_BITRATE_BPS = 50_000_000;
const FALLBACK_FPS: Exclude<Fps, "auto"> = 30;

// Calcula pelo tamanho REAL capturado (width/height de `track.getSettings()`), não pelo enum de
// resolução escolhido — o navegador pode entregar resolução diferente da pedida.
export function getMaxBitrate(width: number, height: number, settings: Pick<StreamSettings, "fps" | "quality">): number {
  const fps = settings.fps === "auto" ? FALLBACK_FPS : settings.fps;
  const qualityMultiplier = QUALITY_MULTIPLIER[settings.quality];

  const raw = width * height * fps * BITS_PER_PIXEL * qualityMultiplier;
  return Math.round(Math.min(MAX_BITRATE_BPS, Math.max(MIN_BITRATE_BPS, raw)));
}
