export type Resolution = "auto" | "720p" | "1080p" | "1440p" | "2160p";
export type Fps = "auto" | 30 | 60 | 120;
export type Quality = "auto" | "low" | "medium" | "high" | "max";

export interface StreamSettings {
  resolution: Resolution;
  fps: Fps;
  quality: Quality;
  // Equivalente ao "melhorar texto"/nitidez do Discord — liga `contentHint: "text"` na track de
  // vídeo (ver capture.ts), que faz o encoder priorizar nitidez de borda sobre fluidez de
  // movimento. Ótimo pra código/documento parado, ativamente ruim pra jogo (movimento constante
  // sofre estouro de QP/frame drop com bitrate fixo — testado em produção, ver
  // docs/INSIGHTS-ENCODER.md #1). Por isso não é padrão — o usuário escolhe por sessão.
  sharpText: boolean;
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

// 120 só faz sentido com monitor de alto refresh (144Hz+) e GPU/encoder de sobra — sem garantia
// nenhuma, igual todo o resto de captura (CLAUDE.md §Captura de tela): o pedido é best-effort.
export const FPS_OPTIONS: Fps[] = ["auto", 30, 60, 120];
export const RESOLUTION_OPTIONS: Resolution[] = ["auto", "720p", "1080p", "1440p", "2160p"];
export const QUALITY_OPTIONS: Quality[] = ["auto", "low", "medium", "high", "max"];

export const defaultStreamSettings: StreamSettings = {
  resolution: "1080p",
  fps: 60,
  quality: "high",
  sharpText: false,
};

// Multiplicador aplicado ao bitrate base conforme o nível de qualidade escolhido.
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
// 0.1 → 0.15: testado em produção com encoder de hardware confirmado (NVENC/etc, sem aviso de
// software) rodando 1080p60 "alta" — QP médio ficava 30-40 (moderado/alto) em jogo de movimento
// rápido mesmo com hardware de sobra, sinal de que o teto de bitrate era baixo demais pro
// conteúdo, não que o encoder tava no limite. 1080p60 "alta" sobe de ~12.4 Mbps pra ~18.7 Mbps.
const BITS_PER_PIXEL = 0.15;
const MIN_BITRATE_BPS = 1_000_000;
const MAX_BITRATE_BPS = 50_000_000;
// Também usado por capture.ts como alvo REAL de captura quando fps="auto" — sem pedir nada, o
// WGC não necessariamente escolhe algo razoável sozinho (testado em produção: ficou em ~20fps sem
// hint nenhum, pior que pedir 30 explicitamente). "Automático" deve significar "um bom padrão",
// não "sem controle nenhum".
export const AUTO_FPS_TARGET: Exclude<Fps, "auto"> = 30;

// Calcula pelo tamanho REAL capturado (width/height de `track.getSettings()`), não pelo enum de
// resolução escolhido — a captura roda na resolução nativa do monitor (não temos mais controle
// de constraint na captura, ver capture.ts), então o bitrate precisa acompanhar isso ou a imagem
// sai borrada/blocada em texto quando o monitor é maior que o perfil selecionado.
export function getMaxBitrate(width: number, height: number, settings: Pick<StreamSettings, "fps" | "quality">): number {
  const fps = settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps;
  const qualityMultiplier = QUALITY_MULTIPLIER[settings.quality];

  const raw = width * height * fps * BITS_PER_PIXEL * qualityMultiplier;
  return Math.round(Math.min(MAX_BITRATE_BPS, Math.max(MIN_BITRATE_BPS, raw)));
}
