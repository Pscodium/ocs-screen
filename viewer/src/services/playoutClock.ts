// Relógio de apresentação COMPARTILHADO entre vídeo e áudio do caminho nativo (DataChannel +
// WebCodecs — sem RTP, não tem jitter buffer nem sincronia A/V do navegador pra reaproveitar).
//
// O host carimba vídeo e áudio no MESMO relógio (QPC do Windows, instante real de captura — ver
// desktop/native/capture-core/src/QpcClock.h). Aqui cada item decodificado vira uma amostra de
// "trânsito" = instante local em que ficou pronto − timestamp de origem. Esse valor mistura
// diferença de relógio entre as máquinas (constante + deriva lenta), latência de rede, fila e
// tempo de decode — não importa separar: o que interessa é que todo item apresentado em
// `timestamp + offset` mantém vídeo e áudio alinhados entre si e com o ritmo original.
//
// `offset` cobre o trânsito de forma DIFERENTE por mídia, porque atraso dói diferente:
// - vídeo: percentil 98 numa janela de 3s — um frame atrasado de vez em quando (keyframe grande,
//   soluço) só aparece um pouco tarde, quase imperceptível; não vale subir a latência por ele.
// - áudio: MÁXIMO numa janela de 10s, e um pacote que chega atrasado sobe o offset NA HORA — cada
//   pacote de áudio atrasado é um buraco/estalo audível (bug relatado: com o percentil 98, qualquer
//   oscilação de latência virava "ruído de travamento" no áudio até o espectador subir o buffer à
//   mão). A janela longa segura o offset alto enquanto a rede continua oscilando.
// Sobe na hora quando precisa, desce devagar quando a rede melhora (descida brusca aceleraria o
// vídeo visivelmente; o player de áudio corrige no máximo ~10ms/s sem estalo).
//
// Bug anterior que isso substitui: ancorava no PRIMEIRO pacote e tratava o desvio ABSOLUTO em
// relação a ele como "jitter" (EWMA × 4) + piso fixo de 150ms — deriva de relógio e fila que cresceu
// viravam latência permanente.

export type MediaKind = "video" | "audio";

export interface PlayoutClockOptions {
  videoWindowMs: number;
  audioWindowMs: number;
  videoPercentile: number;
  marginMs: number;
  maxExtraMs: number;
  decayMsPerSecond: number;
  recomputeEveryMs: number;
}

const DEFAULT_OPTIONS: PlayoutClockOptions = {
  videoWindowMs: 3000,
  audioWindowMs: 10000,
  videoPercentile: 0.98,
  marginMs: 8,
  maxExtraMs: 1000,
  decayMsPerSecond: 10,
  recomputeEveryMs: 100,
};

interface Sample {
  atMs: number;
  transitMs: number;
  kind: MediaKind;
}

export class PlayoutClock {
  // Atraso mínimo EXTRA (ms) acima do trânsito mais rápido observado — o slider de "suavização".
  floorMs = 0;

  private readonly options: PlayoutClockOptions;
  private samples: Sample[] = [];
  private offsetMs: number | null = null;
  private minTransitMs = 0;
  private lastRecomputeMs = 0;

  constructor(options: Partial<PlayoutClockOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset(): void {
    this.samples = [];
    this.offsetMs = null;
    this.minTransitMs = 0;
  }

  // Registra um item pronto (decodificado) agora e devolve quantos ms esperar até apresentá-lo
  // (≤ 0 = apresentar já). `timestampUs` = timestamp de origem (µs) que o host mandou.
  schedule(timestampUs: number, nowMs: number, kind: MediaKind = "video"): number {
    const timestampMs = timestampUs / 1000;
    const transitMs = nowMs - timestampMs;
    this.samples.push({ atMs: nowMs, transitMs, kind });
    const cutoff = nowMs - Math.max(this.options.videoWindowMs, this.options.audioWindowMs);
    let expired = 0;
    while (expired < this.samples.length && this.samples[expired].atMs < cutoff) expired++;
    if (expired > 0) this.samples.splice(0, expired);

    if (this.offsetMs === null || nowMs - this.lastRecomputeMs >= this.options.recomputeEveryMs) {
      this.recompute(nowMs);
    }
    if (kind === "audio" && this.offsetMs !== null && transitMs + this.options.marginMs > this.offsetMs) {
      // Áudio atrasado: sobe já (o próximo pacote já sai no horário novo), sem esperar o recompute.
      this.offsetMs = Math.min(transitMs + this.options.marginMs, this.minTransitMs + this.options.maxExtraMs);
    }
    return timestampMs + (this.offsetMs ?? transitMs) - nowMs;
  }

  // Atraso extra (ms) aplicado acima do caminho mais rápido observado — mostrado como "buffer".
  get bufferMs(): number {
    return this.offsetMs === null ? 0 : Math.max(0, Math.round(this.offsetMs - this.minTransitMs));
  }

  private recompute(nowMs: number): void {
    const videoCutoff = nowMs - this.options.videoWindowMs;
    const audioCutoff = nowMs - this.options.audioWindowMs;
    const video: number[] = [];
    let audioMax = -Infinity;
    let minTransit = Infinity;
    for (const s of this.samples) {
      if (s.kind === "video") {
        if (s.atMs < videoCutoff) continue;
        video.push(s.transitMs);
      } else {
        if (s.atMs < audioCutoff) continue;
        audioMax = Math.max(audioMax, s.transitMs);
      }
      minTransit = Math.min(minTransit, s.transitMs);
    }
    if (minTransit === Infinity) return;
    let high = audioMax;
    if (video.length > 0) {
      video.sort((a, b) => a - b);
      high = Math.max(high, video[Math.floor(this.options.videoPercentile * (video.length - 1))]);
    }
    let desired = Math.max(high + this.options.marginMs, minTransit + this.floorMs);
    desired = Math.min(desired, minTransit + this.options.maxExtraMs);

    if (this.offsetMs === null || desired > this.offsetMs) {
      this.offsetMs = desired;
    } else {
      const elapsedS = (nowMs - this.lastRecomputeMs) / 1000;
      this.offsetMs = Math.max(desired, this.offsetMs - this.options.decayMsPerSecond * elapsedS);
    }
    this.minTransitMs = minTransit;
    this.lastRecomputeMs = nowMs;
  }
}
