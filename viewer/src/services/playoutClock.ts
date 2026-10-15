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
// `offset` = percentil alto do trânsito numa janela deslizante (+ margem): cobre o jitter real sem
// deixar um outlier raro (keyframe grande, soluço de Wi-Fi) subir a latência pra sempre. Sobe na
// hora quando precisa (senão tudo chegaria atrasado), desce devagar quando a rede melhora (descida
// brusca aceleraria o vídeo visivelmente).
//
// Bug real que isso substitui: a versão anterior ancorava no PRIMEIRO pacote e tratava o desvio
// ABSOLUTO em relação a ele como "jitter" (EWMA de |desvio| × 4). Qualquer aumento permanente do
// trânsito (fila que cresceu, deriva de relógio entre host e espectador — acumula sem parar numa
// transmissão longa) virava "jitter" e era multiplicado por 4 no atraso aplicado: a latência
// crescia sozinha com o tempo. Além disso o piso padrão era 150ms fixos em cima de tudo.

export interface PlayoutClockOptions {
  windowMs: number;
  percentile: number;
  marginMs: number;
  maxExtraMs: number;
  decayMsPerSecond: number;
  recomputeEveryMs: number;
}

const DEFAULT_OPTIONS: PlayoutClockOptions = {
  windowMs: 3000,
  percentile: 0.98,
  marginMs: 4,
  maxExtraMs: 1000,
  decayMsPerSecond: 10,
  recomputeEveryMs: 100,
};

export class PlayoutClock {
  // Atraso mínimo EXTRA (ms) acima do trânsito mais rápido observado — o slider de "suavização".
  floorMs = 0;

  private readonly options: PlayoutClockOptions;
  private samples: { atMs: number; transitMs: number }[] = [];
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
  schedule(timestampUs: number, nowMs: number): number {
    const timestampMs = timestampUs / 1000;
    const transitMs = nowMs - timestampMs;
    this.samples.push({ atMs: nowMs, transitMs });
    const cutoff = nowMs - this.options.windowMs;
    let expired = 0;
    while (expired < this.samples.length && this.samples[expired].atMs < cutoff) expired++;
    if (expired > 0) this.samples.splice(0, expired);

    if (this.offsetMs === null || nowMs - this.lastRecomputeMs >= this.options.recomputeEveryMs) {
      this.recompute(nowMs);
    }
    return timestampMs + (this.offsetMs ?? transitMs) - nowMs;
  }

  // Atraso extra (ms) aplicado acima do caminho mais rápido observado — mostrado como "buffer".
  get bufferMs(): number {
    return this.offsetMs === null ? 0 : Math.max(0, Math.round(this.offsetMs - this.minTransitMs));
  }

  private recompute(nowMs: number): void {
    const sorted = this.samples.map((s) => s.transitMs).sort((a, b) => a - b);
    const minTransit = sorted[0];
    const high = sorted[Math.floor(this.options.percentile * (sorted.length - 1))];
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
