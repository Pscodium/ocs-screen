import { fetchIceServers, type IceServerDescriptor } from "./backend";

// Host WEB falando o MESMO protocolo do transporte nativo do app desktop (ver
// desktop/native/transport-core/src/TransportCore.cpp e desktop/src/main/index.ts) — o espectador
// não sabe a diferença: mesmo `useNativeStream.ts`, mesmo relay de sinalização
// (backend/src/services/nativeWsRelay.ts). Substitui o LiveKit/WebRTC padrão no host do navegador:
// encode próprio via WebCodecs (hardware preferido, `latencyMode: "realtime"`), 1 encode só com
// fan-out pra N `RTCPeerConnection` (uma por espectador), vídeo/áudio por DataChannel.
//
// Formato no canal "video": [1 byte: 0=key/1=delta | 0x80 = continua no próximo pedaço]
// [8 bytes: timestamp µs LE][payload: H.264 Annex-B]. Canal "audio": [8 bytes: timestamp µs LE]
// [pacote Opus cru]. Canal de volta (video): 8 bytes = ack do frame com esse timestamp, `'K'` =
// pedido de keyframe.

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

// Mesmos limiares do TransportCore.cpp — descarta frame em vez de deixar a fila (latência) crescer.
const DROP_EXTRA_DELAY_MS = 150;
const RESUME_EXTRA_DELAY_MS = 40;
const DROP_BUFFERED_BYTES = 1024 * 1024;
const RESUME_BUFFERED_BYTES = 256 * 1024;
const KEYFRAME_REQUEST_INTERVAL_MS = 500;
const MIN_RTT_WINDOW_MS = 5000;
const MAX_INFLIGHT = 1024;
// Fila do encoder acima disso = encoder não dá conta (software, GPU ocupada) — descarta o frame
// capturado em vez de acumular latência.
const MAX_ENCODE_QUEUE = 2;
const FRAME_HEADER_BYTES = 9;
// Chrome anuncia 256KB de max-message-size; antes de conectar `sctp` ainda é null.
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
// Adaptação de bitrate (AIMD) sobre o encoder único — piora todo mundo quando 1 espectador tá
// ruim (sem simulcast ainda no host web).
const ADAPT_INTERVAL_MS = 1000;
const BITRATE_DECREASE = 0.75;
const BITRATE_INCREASE = 1.05;
const MIN_BITRATE_FRACTION = 0.2;
const WS_RECONNECT_MAX_MS = 10_000;

export interface WebNativeHostStats {
  bitrateKbps: number;
  fps: number;
  width: number;
  height: number;
  avgEncodeMs: number | null;
  targetBitrateKbps: number;
  hardwareAccelerated: boolean;
}

export interface WebNativeHostOptions {
  roomId: string;
  stream: MediaStream;
  bitrateBps: number;
  fps: number;
  onViewerCount: (count: number) => void;
}

interface ViewerSession {
  pc: RTCPeerConnection;
  video: RTCDataChannel;
  audio: RTCDataChannel | null;
  waitingKeyframe: boolean;
  inflight: { timestampUs: number; sentAt: number }[];
  feedbackSeen: boolean;
  minRttCurMs: number;
  minRttPrevMs: number;
  minRttWindowStart: number;
  dropped: number;
}

export function isWebNativeHostSupported(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof MediaStreamTrackProcessor !== "undefined"
  );
}

// Codec string H.264 High com level suficiente pra resolução/FPS — o espectador usa o SPS embutido
// no bitstream (Annex-B), então isso só precisa ser aceito pelo encoder.
function h264CodecFor(width: number, height: number, fps: number): string {
  const macroblocksPerSec = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  if (macroblocksPerSec <= 522_240) return "avc1.64002a"; // 4.2 (1080p60)
  if (macroblocksPerSec <= 983_040) return "avc1.640033"; // 5.1 (4K30)
  return "avc1.640034"; // 5.2 (4K60)
}

export class WebNativeHost {
  private readonly opts: WebNativeHostOptions;
  private readonly sessions = new Map<string, ViewerSession>();
  private iceServers: IceServerDescriptor[] = [];
  private ws: WebSocket | null = null;
  private wsReconnectAttempt = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private encoderConfig: VideoEncoderConfig | null = null;
  private hardwareAccelerated = false;
  private forceKeyframe = true;
  private lastKeyframeAt = -Infinity;
  private targetBitrate: number;
  private currentBitrate: number;
  private adaptTimer: ReturnType<typeof setInterval> | null = null;
  private readers: ReadableStreamDefaultReader<VideoFrame | AudioData>[] = [];

  // Timestamps de vídeo e áudio no MESMO relógio (`performance.now()`), como o host desktop faz com
  // `nowUs()` — o espectador sincroniza A/V por eles (playoutClock.ts).
  private videoTsOffsetUs: number | null = null;
  private audioTsOffsetUs: number | null = null;
  private readonly encodeStartedAt = new Map<number, number>();

  private statBytes = 0;
  private statFrames = 0;
  private statEncodeMsSum = 0;
  private statEncodeCount = 0;
  private statSince = performance.now();

  constructor(opts: WebNativeHostOptions) {
    this.opts = opts;
    this.targetBitrate = opts.bitrateBps;
    this.currentBitrate = opts.bitrateBps;
  }

  async start(): Promise<void> {
    this.iceServers = await fetchIceServers();
    const [videoTrack] = this.opts.stream.getVideoTracks();
    const [audioTrack] = this.opts.stream.getAudioTracks();
    this.runVideo(videoTrack);
    if (audioTrack) this.runAudio(audioTrack);
    this.connectWs();
    this.adaptTimer = setInterval(() => this.adaptBitrate(), ADAPT_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.adaptTimer) clearInterval(this.adaptTimer);
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    for (const reader of this.readers) reader.cancel().catch(() => {});
    for (const viewerId of [...this.sessions.keys()]) this.closeSession(viewerId);
    this.ws?.close();
    if (this.videoEncoder?.state !== "closed") this.videoEncoder?.close();
    if (this.audioEncoder?.state !== "closed") this.audioEncoder?.close();
  }

  takeStats(): WebNativeHostStats {
    const now = performance.now();
    const elapsedSec = Math.max(0.001, (now - this.statSince) / 1000);
    const stats: WebNativeHostStats = {
      bitrateKbps: Math.round((this.statBytes * 8) / elapsedSec / 1000),
      fps: Math.round(this.statFrames / elapsedSec),
      width: this.encoderConfig?.width ?? 0,
      height: this.encoderConfig?.height ?? 0,
      avgEncodeMs: this.statEncodeCount > 0 ? this.statEncodeMsSum / this.statEncodeCount : null,
      targetBitrateKbps: Math.round(this.currentBitrate / 1000),
      hardwareAccelerated: this.hardwareAccelerated,
    };
    this.statBytes = 0;
    this.statFrames = 0;
    this.statEncodeMsSum = 0;
    this.statEncodeCount = 0;
    this.statSince = now;
    return stats;
  }

  // ---------- Vídeo ----------

  private async runVideo(track: MediaStreamTrack): Promise<void> {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    this.readers.push(reader);
    while (!this.stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        await this.encodeVideoFrame(frame);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[web-native-host] falha ao codificar frame:", err);
      } finally {
        frame.close();
      }
    }
  }

  private async encodeVideoFrame(frame: VideoFrame): Promise<void> {
    // Dimensão par (exigência do H.264 4:2:0); janela redimensionada = reconfigura o encoder.
    const width = frame.displayWidth & ~1;
    const height = frame.displayHeight & ~1;
    if (!this.encoderConfig || this.encoderConfig.width !== width || this.encoderConfig.height !== height) {
      await this.configureVideoEncoder(width, height);
    }
    const encoder = this.videoEncoder;
    if (!encoder || encoder.state !== "configured") return;
    if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return;
    // Ninguém assistindo — não gasta GPU, mas o próximo espectador vai precisar de keyframe.
    if (this.sessions.size === 0) {
      this.forceKeyframe = true;
      return;
    }

    if (this.videoTsOffsetUs === null) this.videoTsOffsetUs = Math.round(performance.now() * 1000) - frame.timestamp;
    const keyFrame = this.forceKeyframe;
    this.forceKeyframe = false;
    // Encoder em modo realtime pode descartar frame sem output — não deixa o mapa crescer.
    if (this.encodeStartedAt.size > 120) this.encodeStartedAt.clear();
    this.encodeStartedAt.set(frame.timestamp, performance.now());
    encoder.encode(frame, { keyFrame });
  }

  private async configureVideoEncoder(width: number, height: number): Promise<void> {
    const base: VideoEncoderConfig = {
      codec: h264CodecFor(width, height, this.opts.fps),
      width,
      height,
      bitrate: this.currentBitrate,
      framerate: this.opts.fps,
      latencyMode: "realtime",
      bitrateMode: "variable",
      avc: { format: "annexb" },
    };
    let config: VideoEncoderConfig = { ...base, hardwareAcceleration: "prefer-hardware" };
    const hw = await VideoEncoder.isConfigSupported(config);
    this.hardwareAccelerated = hw.supported === true;
    if (!hw.supported) {
      config = { ...base, hardwareAcceleration: "no-preference" };
      const sw = await VideoEncoder.isConfigSupported(config);
      if (!sw.supported) throw new Error(`Encoder H.264 indisponível para ${width}×${height}.`);
    }

    if (!this.videoEncoder || this.videoEncoder.state === "closed") {
      this.videoEncoder = new VideoEncoder({
        output: (chunk) => this.onVideoChunk(chunk),
        error: (err) => {
          // eslint-disable-next-line no-console
          console.error("[web-native-host] erro no VideoEncoder:", err);
          // Recria na próxima frame (encoderConfig nulo força `configureVideoEncoder`).
          this.encoderConfig = null;
          this.videoEncoder = null;
        },
      });
    }
    this.videoEncoder.configure(config);
    this.encoderConfig = config;
    this.forceKeyframe = true;
  }

  private onVideoChunk(chunk: EncodedVideoChunk): void {
    const startedAt = this.encodeStartedAt.get(chunk.timestamp);
    if (startedAt !== undefined) {
      this.encodeStartedAt.delete(chunk.timestamp);
      this.statEncodeMsSum += performance.now() - startedAt;
      this.statEncodeCount++;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.statBytes += data.byteLength;
    this.statFrames++;

    const timestampUs = chunk.timestamp + (this.videoTsOffsetUs ?? 0);
    const isKey = chunk.type === "key";
    if (isKey) this.lastKeyframeAt = performance.now();
    for (const session of this.sessions.values()) this.sendVideo(session, data, timestampUs, isKey);
  }

  private sendVideo(session: ViewerSession, data: Uint8Array, timestampUs: number, isKey: boolean): void {
    const channel = session.video;
    if (channel.readyState !== "open") return;
    const now = performance.now();

    let congested: boolean;
    let drained: boolean;
    if (session.feedbackSeen) {
      const extra = this.extraDelayMs(session, now);
      congested = extra > DROP_EXTRA_DELAY_MS;
      drained = extra < RESUME_EXTRA_DELAY_MS;
    } else {
      congested = channel.bufferedAmount > DROP_BUFFERED_BYTES;
      drained = channel.bufferedAmount < RESUME_BUFFERED_BYTES;
    }

    if (congested || (session.waitingKeyframe && !isKey)) {
      // P-frame seguinte referencia o que foi jogado fora — essa sessão só volta num keyframe.
      session.waitingKeyframe = true;
      if (congested) session.dropped++;
      if (drained) this.requestKeyframe();
      return;
    }
    session.waitingKeyframe = false;

    const maxMessage = Math.max(1024, session.pc.sctp?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_BYTES);
    const chunkPayload = maxMessage - FRAME_HEADER_BYTES;
    try {
      let offset = 0;
      do {
        const part = Math.min(chunkPayload, data.byteLength - offset);
        const more = offset + part < data.byteLength;
        const message = new Uint8Array(FRAME_HEADER_BYTES + part);
        const view = new DataView(message.buffer);
        view.setUint8(0, (isKey ? 0 : 1) | (more ? 0x80 : 0));
        view.setBigUint64(1, BigInt(timestampUs), true);
        message.set(data.subarray(offset, offset + part), FRAME_HEADER_BYTES);
        channel.send(message);
        offset += part;
      } while (offset < data.byteLength);
    } catch {
      return; // canal fechando — a sessão vai ser derrubada pelo estado da conexão
    }
    session.inflight.push({ timestampUs, sentAt: now });
    if (session.inflight.length > MAX_INFLIGHT) session.inflight.shift();
  }

  private requestKeyframe(): void {
    if (performance.now() - this.lastKeyframeAt < KEYFRAME_REQUEST_INTERVAL_MS) return;
    this.forceKeyframe = true;
  }

  private extraDelayMs(session: ViewerSession, now: number): number {
    if (session.inflight.length === 0) return 0;
    const ageMs = now - session.inflight[0].sentAt;
    const minRtt = Math.min(session.minRttCurMs, session.minRttPrevMs);
    return Math.max(0, ageMs - (Number.isFinite(minRtt) ? minRtt : 0));
  }

  private handleVideoFeedback(session: ViewerSession, data: ArrayBuffer): void {
    if (data.byteLength === 1 && new Uint8Array(data)[0] === 0x4b) {
      session.waitingKeyframe = true;
      this.requestKeyframe();
      return;
    }
    if (data.byteLength !== 8) return;
    const ackedTs = Number(new DataView(data).getBigUint64(0, true));
    const now = performance.now();
    session.feedbackSeen = true;
    let sentAt: number | null = null;
    while (session.inflight.length > 0 && session.inflight[0].timestampUs <= ackedTs) {
      const entry = session.inflight.shift()!;
      if (entry.timestampUs === ackedTs) sentAt = entry.sentAt;
    }
    if (sentAt === null) return;
    const rttMs = now - sentAt;
    if (now - session.minRttWindowStart > MIN_RTT_WINDOW_MS) {
      session.minRttPrevMs = session.minRttCurMs;
      session.minRttCurMs = Infinity;
      session.minRttWindowStart = now;
    }
    session.minRttCurMs = Math.min(session.minRttCurMs, rttMs);
  }

  // AIMD: qualquer espectador descartando frame por congestionamento derruba o bitrate do encoder
  // (compartilhado); sem descarte, sobe devagar de volta até o alvo do perfil.
  private adaptBitrate(): void {
    if (!this.videoEncoder || this.videoEncoder.state !== "configured" || !this.encoderConfig) return;
    let dropped = 0;
    for (const session of this.sessions.values()) {
      dropped += session.dropped;
      session.dropped = 0;
    }
    const floor = this.targetBitrate * MIN_BITRATE_FRACTION;
    const next =
      dropped > 0
        ? Math.max(floor, this.currentBitrate * BITRATE_DECREASE)
        : Math.min(this.targetBitrate, this.currentBitrate * BITRATE_INCREASE);
    if (Math.abs(next - this.currentBitrate) < this.targetBitrate * 0.01) return;
    this.currentBitrate = Math.round(next);
    this.encoderConfig = { ...this.encoderConfig, bitrate: this.currentBitrate };
    this.videoEncoder.configure(this.encoderConfig);
  }

  // ---------- Áudio ----------

  private async runAudio(track: MediaStreamTrack): Promise<void> {
    const reader = new MediaStreamTrackProcessor<AudioData>({ track }).readable.getReader();
    this.readers.push(reader);
    while (!this.stopped) {
      const { value: data, done } = await reader.read();
      if (done || !data) break;
      try {
        this.encodeAudio(data);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[web-native-host] falha ao codificar áudio:", err);
      } finally {
        data.close();
      }
    }
  }

  private encodeAudio(data: AudioData): void {
    if (!this.audioEncoder) {
      this.audioEncoder = new AudioEncoder({
        output: (chunk) => this.onAudioChunk(chunk),
        error: (err) => {
          // eslint-disable-next-line no-console
          console.error("[web-native-host] erro no AudioEncoder:", err);
        },
      });
      // Config pela entrada real (AudioEncoder exige casar) — o decoder Opus do espectador sempre
      // decodifica em 48kHz/estéreo independente disso.
      this.audioEncoder.configure({
        codec: "opus",
        sampleRate: data.sampleRate,
        numberOfChannels: data.numberOfChannels,
        bitrate: 128_000,
      });
    }
    if (this.audioEncoder.state !== "configured" || this.sessions.size === 0) return;
    if (this.audioTsOffsetUs === null) this.audioTsOffsetUs = Math.round(performance.now() * 1000) - data.timestamp;
    this.audioEncoder.encode(data);
  }

  private onAudioChunk(chunk: EncodedAudioChunk): void {
    const message = new Uint8Array(8 + chunk.byteLength);
    new DataView(message.buffer).setBigUint64(0, BigInt(chunk.timestamp + (this.audioTsOffsetUs ?? 0)), true);
    chunk.copyTo(message.subarray(8));
    for (const session of this.sessions.values()) {
      if (session.audio?.readyState !== "open" || session.waitingKeyframe) continue;
      try {
        session.audio.send(message);
      } catch {
        // canal fechando
      }
    }
  }

  // ---------- Sinalização / sessões ----------

  private connectWs(): void {
    const ws = new WebSocket(
      `${backendUrl.replace(/^http/, "ws")}/rooms/${this.opts.roomId}/native/ws?role=host`,
    );
    this.ws = ws;
    ws.onopen = () => {
      this.wsReconnectAttempt = 0;
    };
    ws.onmessage = (event) => this.handleWsMessage(event);
    // Mesma resiliência do host desktop: backend reenvia `viewer-joined` de quem ainda estiver na
    // sala quando o host reconecta.
    ws.onclose = () => {
      if (this.stopped || this.wsReconnectTimer) return;
      const delayMs = Math.min(WS_RECONNECT_MAX_MS, 1000 * 2 ** this.wsReconnectAttempt);
      this.wsReconnectAttempt++;
      this.wsReconnectTimer = setTimeout(() => {
        this.wsReconnectTimer = null;
        if (!this.stopped) this.connectWs();
      }, delayMs);
    };
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private handleWsMessage(event: MessageEvent): void {
    let msg: { type?: string; viewerId?: string; sdp?: string; candidate?: string; mid?: string };
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    const { viewerId } = msg;
    if (!viewerId) return;

    if (msg.type === "viewer-joined") {
      this.closeSession(viewerId);
      this.createSession(viewerId).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[web-native-host] falha ao criar sessão pro espectador ${viewerId}:`, err);
        this.closeSession(viewerId);
      });
    } else if (msg.type === "viewer-left") {
      this.closeSession(viewerId);
    } else if (msg.type === "answer" && msg.sdp) {
      // `decoderOk` só importa pra HEVC/AV1 — host web só manda H.264.
      this.sessions.get(viewerId)?.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => {});
    } else if (msg.type === "ice" && msg.candidate) {
      this.sessions
        .get(viewerId)
        ?.pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid ?? "0" })
        .catch(() => {});
    }
    // "set-quality": sem simulcast no host web — ignorado.
  }

  private async createSession(viewerId: string): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const video = pc.createDataChannel("video");
    video.binaryType = "arraybuffer";
    const audio = this.opts.stream.getAudioTracks().length > 0 ? pc.createDataChannel("audio") : null;

    const session: ViewerSession = {
      pc,
      video,
      audio,
      waitingKeyframe: true,
      inflight: [],
      feedbackSeen: false,
      minRttCurMs: Infinity,
      minRttPrevMs: Infinity,
      minRttWindowStart: performance.now(),
      dropped: 0,
    };
    this.sessions.set(viewerId, session);

    video.onopen = () => this.requestKeyframe();
    video.onmessage = (event) => this.handleVideoFeedback(session, event.data as ArrayBuffer);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({ type: "ice", viewerId, candidate: event.candidate.candidate, mid: event.candidate.sdpMid ?? "0" });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.closeSession(viewerId);
      this.emitViewerCount();
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: "offer", viewerId, sdp: pc.localDescription?.sdp, codec: "h264" });
  }

  private closeSession(viewerId: string): void {
    const session = this.sessions.get(viewerId);
    if (!session) return;
    this.sessions.delete(viewerId);
    session.pc.onconnectionstatechange = null;
    session.pc.close();
    this.emitViewerCount();
  }

  private emitViewerCount(): void {
    let connected = 0;
    for (const session of this.sessions.values()) if (session.pc.connectionState === "connected") connected++;
    this.opts.onViewerCount(connected);
  }
}
