// Toca o áudio do caminho nativo (Opus decodificado pelo `AudioDecoder`) via Web Audio, alinhado a
// um instante EXATO do relógio de apresentação (`PlayoutClock`) — o mesmo que decide quando cada
// frame de vídeo aparece. Antes ia por `MediaStreamTrackGenerator<AudioData>` dentro do `<video>`:
// o renderizador de áudio de MediaStream do Chrome tem a própria fila/ajuste de relógio, então o
// momento em que a gente ESCREVIA o AudioData não era o momento em que ele tocava — não tinha como
// alinhar com o vídeo de verdade, nem controlar a latência do áudio.
//
// Saída por AudioWorklet com fila CONTÍNUA de amostras (não um AudioBufferSourceNode por pacote).
// Bug que isso substitui (medido gravando a saída do Chrome do espectador por loopback, seno puro):
// com um BufferSource de 10ms por pacote e `playbackRate` ≠ 1 pra corrigir deriva, as emendas entre
// pacotes sobrepunham/abriam fração de ms (~32 amostras somadas em dobro a cada ~40ms) — estalo
// constante, pior quanto mais o relógio de apresentação oscila (captura de janela, cujo vídeo chega
// mais irregular que o de monitor). No worklet a correção de deriva é reamostragem linear sobre a
// fila inteira — não existe emenda.
//
// Volume/mudo continuam controlados pelo `<video>` (VideoPlayer mexe em `video.volume/muted`) —
// este player só espelha esses valores num GainNode, a UI não muda.

const PROCESSOR_NAME = "native-audio-playout";

// Roda na thread de áudio. Cada chunk chega com `target` = instante (segundos de contexto) em que a
// 1ª amostra deve tocar. Erro = target − (agora + o que ainda está na fila antes dele):
// - pequeno (< HARD_S): corrige aos poucos reamostrando até ±1% (inaudível), suavizado;
// - grande: atrasado demais → descarta o excesso da fila; adiantado demais → insere silêncio. Os dois
//   com fade curto (sem degrau na forma de onda).
// Fila vazia (pacote atrasado/rede) → silêncio com fade-out, e o próximo chunk entra com fade-in.
const PROCESSOR_SOURCE = `
const HARD_S = 0.03;
const MIN_LEAD_S = 0.015;
const MAX_RATE_DEV = 0.01;
const FADE = 96;
class NativeAudioPlayout extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 48000 * 4;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.head = 0;      // posição de leitura (fracionária) relativa a 'base'
    this.base = 0;      // índice absoluto da amostra 0 do anel
    this.length = 0;    // amostras inteiras escritas a partir de 'base'
    this.errS = 0;
    this.started = false;
    this.fadeIn = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.lagSum = 0;
    this.lagMax = -Infinity;
    this.lagCount = 0;
    this.port.onmessage = (e) => this.push(e.data);
  }
  queued() { return this.length - this.head; }
  at(arr, i) { return arr[(this.base + i) % this.capacity]; }
  write(l, r) {
    const n = l.length;
    if (this.length + n > this.capacity) return;
    for (let i = 0; i < n; i++) {
      const idx = (this.base + this.length + i) % this.capacity;
      this.left[idx] = l[i];
      this.right[idx] = r[i];
    }
    this.length += n;
  }
  writeSilence(n) {
    n = Math.min(n, this.capacity - this.length);
    for (let i = 0; i < n; i++) {
      const idx = (this.base + this.length + i) % this.capacity;
      this.left[idx] = 0;
      this.right[idx] = 0;
    }
    this.length += n;
  }
  compact() {
    const drop = Math.floor(this.head);
    if (drop <= 0) return;
    this.base = (this.base + drop) % this.capacity;
    this.length -= drop;
    this.head -= drop;
  }
  // Diagnóstico de sincronia: quanto o chunk vai tocar DEPOIS do alvo pedido (o alvo é o mesmo
  // relógio do vídeo, então isso é o atraso do áudio em relação à imagem). Média/máximo a cada
  // ~0.5s pra thread principal.
  push(chunk) {
    this.place(chunk);
    const startQueued = this.length - chunk.left.length - this.head;
    const lag = currentTime + startQueued / sampleRate - chunk.target;
    this.lagSum += lag; this.lagCount++; if (lag > this.lagMax) this.lagMax = lag;
    if (this.lagCount >= 50) {
      this.port.postMessage({ lagMs: (this.lagSum / this.lagCount) * 1000, lagMaxMs: this.lagMax * 1000 });
      this.lagSum = 0; this.lagCount = 0; this.lagMax = -Infinity;
    }
  }
  place({ left, right, target }) {
    const now = currentTime;
    // Alvo no passado/encostado no agora = não dá mais pra tocar no horário (ver MIN_LEAD na
    // classe principal) — mira o mais cedo possível COM folga de fila, senão cada pacote encostaria
    // no fim do anterior sem margem e qualquer variação de chegada viraria buraco.
    target = Math.max(target, now + MIN_LEAD_S);
    if (!this.started || this.queued() <= 0) {
      // Começo / depois de esvaziar: encaixa no horário com silêncio na frente (se adiantado).
      this.length = 0; this.head = 0;
      const lead = Math.round((target - now) * sampleRate);
      if (lead > 0) this.writeSilence(lead);
      this.write(left, right);
      this.started = true;
      this.fadeIn = FADE;
      this.errS = 0;
      return;
    }
    const err = target - (now + this.queued() / sampleRate);
    if (err > HARD_S) {
      // Relógio de apresentação subiu de uma vez (buffer maior): abre o espaço com silêncio.
      this.fadeTail();
      this.writeSilence(Math.round(err * sampleRate));
      this.write(left, right);
      this.fadeHeadOf(left.length);
      this.errS = 0;
      return;
    }
    if (err < -HARD_S) {
      // Atrasado demais: pula o excesso do que está na fila, com crossfade entre o trecho que ia
      // tocar agora e o trecho depois do pulo (sem degrau). Se a fila não tem o bastante, o chunk
      // novo entra junto e o pulo cai dentro dele.
      this.write(left, right);
      const drop = Math.min(Math.round(-err * sampleRate), Math.floor(this.queued()) - FADE - 2);
      if (drop > 0) {
        const h = Math.ceil(this.head);
        for (let i = 0; i < FADE; i++) {
          const g = i / FADE;
          const a = (this.base + h + i) % this.capacity;
          const b = (this.base + h + drop + i) % this.capacity;
          this.left[b] = this.left[b] * g + this.left[a] * (1 - g);
          this.right[b] = this.right[b] * g + this.right[a] * (1 - g);
        }
        this.head = h + drop;
      }
      this.errS = 0;
      return;
    }
    this.write(left, right);
    this.errS += (err - this.errS) * 0.1;
  }
  // Fade-out nas últimas FADE amostras já escritas.
  fadeTail() {
    const n = Math.min(FADE, this.length - Math.ceil(this.head));
    for (let i = 0; i < n; i++) {
      const g = i / n;
      const idx = (this.base + this.length - 1 - i) % this.capacity;
      this.left[idx] *= g; this.right[idx] *= g;
    }
  }
  // Fade-in nas primeiras amostras do chunk recém-escrito (tamanho 'size', no fim da fila).
  fadeHeadOf(size) {
    const n = Math.min(FADE, size);
    for (let i = 0; i < n; i++) {
      const g = i / n;
      const idx = (this.base + this.length - size + i) % this.capacity;
      this.left[idx] *= g; this.right[idx] *= g;
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const frames = oL.length;
    // errS < 0 = tocando atrasado → acelera; > 0 = adiantado → desacelera.
    const rate = 1 + Math.max(-MAX_RATE_DEV, Math.min(MAX_RATE_DEV, -this.errS * 0.5));
    for (let i = 0; i < frames; i++) {
      if (this.started && this.head + 1 < this.length) {
        const i0 = Math.floor(this.head);
        const f = this.head - i0;
        let l = this.at(this.left, i0) * (1 - f) + this.at(this.left, i0 + 1) * f;
        let r = this.at(this.right, i0) * (1 - f) + this.at(this.right, i0 + 1) * f;
        if (this.fadeIn > 0) { const g = 1 - this.fadeIn / FADE; l *= g; r *= g; this.fadeIn--; }
        oL[i] = l; oR[i] = r;
        this.lastL = l; this.lastR = r;
        this.head += rate;
        // A correção aplicada consome o erro (o que foi acelerado/desacelerado já foi ajustado).
        this.errS += (rate - 1) / sampleRate;
      } else {
        // Fila vazia: decai a partir da última amostra (sem degrau pra zero).
        this.lastL *= 0.97; this.lastR *= 0.97;
        oL[i] = this.lastL; oR[i] = this.lastR;
        if (this.started) { this.started = this.head + 1 < this.length; }
      }
    }
    this.compact();
    return true;
  }
}
registerProcessor("${PROCESSOR_NAME}", NativeAudioPlayout);
`;

interface PendingChunk {
  left: Float32Array;
  right: Float32Array;
  target: number;
}

export class NativeAudioPlayer {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private node: AudioWorkletNode | null = null;
  private pending: PendingChunk[] = [];
  private detachVideo: (() => void) | null = null;
  // Atraso médio (ms) do áudio em relação ao alvo do relógio de apresentação — o mesmo alvo do
  // vídeo, ou seja, quanto o som está atrás da imagem (do ponto de vista do agendamento; a latência
  // de saída do dispositivo já está descontada pelo `getOutputTimestamp`).
  syncLagMs = 0;
  onSyncStats: ((stats: { lagMs: number; lagMaxMs: number }) => void) | null = null;

  constructor() {
    this.context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    this.gain = this.context.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.context.destination);
    const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "application/javascript" }));
    this.context.audioWorklet
      .addModule(url)
      .then(() => {
        const node = new AudioWorkletNode(this.context, PROCESSOR_NAME, { numberOfInputs: 0, outputChannelCount: [2] });
        node.connect(this.gain);
        node.port.onmessage = (e: MessageEvent<{ lagMs: number; lagMaxMs: number }>) => {
          this.syncLagMs = e.data.lagMs;
          this.onSyncStats?.(e.data);
        };
        this.node = node;
        for (const chunk of this.pending) this.post(chunk);
        this.pending = [];
      })
      .catch((err: unknown) => console.error("[native-audio] falha ao carregar o AudioWorklet", err))
      .finally(() => URL.revokeObjectURL(url));
  }

  // Espelha volume/mudo do `<video>` e retoma o AudioContext quando o usuário desmuta — o Chrome só
  // deixa um AudioContext rodar depois de interação do usuário com a página (autoplay policy); o
  // clique em "desmutar" é essa interação.
  attachVideoElement(video: HTMLVideoElement): void {
    this.detachVideo?.();
    const sync = () => {
      this.gain.gain.value = video.muted ? 0 : video.volume;
      if (!video.muted && this.context.state === "suspended") this.context.resume().catch(() => {});
    };
    video.addEventListener("volumechange", sync);
    sync();
    this.detachVideo = () => video.removeEventListener("volumechange", sync);
  }

  // `presentAtPerfMs` = instante (`performance.now()`) em que o primeiro sample deve SAIR no
  // alto-falante. Consome (fecha) o `audioData`.
  play(audioData: AudioData, presentAtPerfMs: number): void {
    try {
      if (this.context.state !== "running") return; // mudo/sem interação ainda — nada a tocar
      const frames = audioData.numberOfFrames;
      const channels = Math.min(2, audioData.numberOfChannels);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      audioData.copyTo(left, { planeIndex: 0, format: "f32-planar" });
      audioData.copyTo(right, { planeIndex: Math.min(1, channels - 1), format: "f32-planar" });
      const chunk = { left, right, target: this.contextTimeFor(presentAtPerfMs) };
      if (this.node) this.post(chunk);
      else if (this.pending.length < 50) this.pending.push(chunk);
    } finally {
      audioData.close();
    }
  }

  close(): void {
    this.detachVideo?.();
    this.detachVideo = null;
    this.node?.disconnect();
    this.node = null;
    this.context.close().catch(() => {});
  }

  private post(chunk: PendingChunk): void {
    this.node?.port.postMessage(chunk, [chunk.left.buffer, chunk.right.buffer]);
  }

  // `getOutputTimestamp()` relaciona o instante de contexto que está SAINDO no alto-falante agora
  // com `performance.now()` — já inclui a latência de saída do dispositivo, então mirar por ele faz
  // o som ser OUVIDO no instante pedido (não só "entregue ao driver").
  private contextTimeFor(perfMs: number): number {
    const stamp = this.context.getOutputTimestamp?.();
    if (stamp && stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
      return stamp.contextTime + (perfMs - stamp.performanceTime) / 1000;
    }
    const outputLatency = this.context.outputLatency || this.context.baseLatency || 0;
    return this.context.currentTime + (perfMs - performance.now()) / 1000 - outputLatency;
  }
}
