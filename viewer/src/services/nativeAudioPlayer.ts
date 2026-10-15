// Toca o áudio do caminho nativo (Opus decodificado pelo `AudioDecoder`) via Web Audio, agendado
// num instante EXATO do relógio de apresentação (`PlayoutClock`) — o mesmo que decide quando cada
// frame de vídeo aparece. Antes ia por `MediaStreamTrackGenerator<AudioData>` dentro do `<video>`:
// o renderizador de áudio de MediaStream do Chrome tem a própria fila/ajuste de relógio, então o
// momento em que a gente ESCREVIA o AudioData não era o momento em que ele tocava — não tinha como
// alinhar com o vídeo de verdade, nem controlar a latência do áudio.
//
// Volume/mudo continuam controlados pelo `<video>` (VideoPlayer mexe em `video.volume/muted`) —
// este player só espelha esses valores num GainNode, a UI não muda.

const CONTIGUOUS_TOLERANCE_S = 0.03;

export class NativeAudioPlayer {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  // Fim do último buffer agendado — pacotes consecutivos encostam um no outro (sem estalo de
  // micro-buraco/sobreposição por arredondamento do relógio).
  private nextStartTime = 0;
  private detachVideo: (() => void) | null = null;

  constructor() {
    this.context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    this.gain = this.context.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.context.destination);
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
      const buffer = this.context.createBuffer(2, frames, audioData.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const plane = new Float32Array(frames);
        audioData.copyTo(plane, { planeIndex: Math.min(ch, channels - 1), format: "f32-planar" });
        buffer.copyToChannel(plane, ch);
      }

      const target = this.contextTimeFor(presentAtPerfMs);
      let when = target;
      let rate = 1;
      const drift = this.nextStartTime - target; // > 0 = áudio tocando atrasado em relação ao alvo
      if (Math.abs(drift) < CONTIGUOUS_TOLERANCE_S) {
        // Encosta no buffer anterior e corrige o desvio aos poucos acelerando/desacelerando até 1%
        // (inaudível) — o relógio de apresentação desce devagar quando a rede melhora, e os
        // relógios do áudio e do `performance.now()` derivam um do outro; pular direto pro alvo
        // daria um estalo a cada correção.
        when = this.nextStartTime;
        rate = 1 + Math.max(-0.01, Math.min(0.01, drift * 0.5));
      }
      const now = this.context.currentTime;
      if (when < now) {
        // Chegou atrasado (o relógio de apresentação subiu, ou o pacote demorou) — toca já em vez
        // de descartar, o próximo volta a encostar nesse.
        when = now;
      }
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(this.gain);
      source.start(when);
      this.nextStartTime = when + buffer.duration / rate;
    } finally {
      audioData.close();
    }
  }

  close(): void {
    this.detachVideo?.();
    this.detachVideo = null;
    this.context.close().catch(() => {});
  }

  // `getOutputTimestamp()` relaciona o instante de contexto que está SAINDO no alto-falante agora
  // com `performance.now()` — já inclui a latência de saída do dispositivo, então agendar por ele
  // faz o som ser OUVIDO no instante pedido (não só "entregue ao driver").
  private contextTimeFor(perfMs: number): number {
    const stamp = this.context.getOutputTimestamp?.();
    if (stamp && stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
      return stamp.contextTime + (perfMs - stamp.performanceTime) / 1000;
    }
    const outputLatency = this.context.outputLatency || this.context.baseLatency || 0;
    return this.context.currentTime + (perfMs - performance.now()) / 1000 - outputLatency;
  }
}
