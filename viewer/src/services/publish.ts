import {
  AudioPresets,
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrackPublication,
  type VideoPreset,
} from "livekit-client";
import { getMaxBitrate, type StreamSettings } from "../types/stream";
import { detectBestVideoCodec, isSoftwareEncoder, resetCodecCache } from "./codecs";

export interface BroadcastSession {
  room: Room;
  publication: LocalTrackPublication;
  disconnect: () => Promise<void>;
}

// Espelha desktop/src/services/livekit.ts — mesma lógica de publish, cliente web em vez de Tauri.
// SÓ 1 camada extra (2 encodes no total, não 3) — testado em produção: 3 encodes simultâneos
// competindo pelo motor de mídia da GPU (que também renderiza o jogo) causava FPS caindo com o
// tempo mesmo com hardware confirmado. Ver docs/INSIGHTS-ENCODER.md #4.
function pickSimulcastLayers(actualHeight: number): VideoPreset[] {
  if (actualHeight >= 1440) return [VideoPresets.h720];
  return [VideoPresets.h360];
}

// Contra STUN público (Google/Twilio) quando o LiveKit é local — o servidor local não precisa de
// travessia de NAT nenhuma, mas ainda tenta gatherar candidatos STUN públicos por padrão. Em
// máquinas com várias interfaces de rede virtuais (VPN, WSL, Hyper-V), cada uma tenta
// resolver/bindar STUN e falha (timeout), só atrasando a conexão e poluindo o log sem benefício
// real — não afeta deploy real (LIVEKIT_URL apontando pra fora continua usando STUN/TURN normalmente).
function isLocalLivekitUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url.replace(/^ws/, "http"));
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export async function startBroadcast(
  livekitUrl: string,
  token: string,
  stream: MediaStream,
  settings: StreamSettings,
  onParticipantCountChange: (count: number) => void,
  onConnectionStateChange: (state: ConnectionState) => void,
): Promise<BroadcastSession> {
  const room = new Room({ dynacast: true });

  room.on(RoomEvent.ParticipantConnected, () => onParticipantCountChange(room.remoteParticipants.size));
  room.on(RoomEvent.ParticipantDisconnected, () => onParticipantCountChange(room.remoteParticipants.size));
  room.on(RoomEvent.ConnectionStateChanged, onConnectionStateChange);

  await room.connect(
    livekitUrl,
    token,
    isLocalLivekitUrl(livekitUrl) ? { rtcConfig: { iceServers: [] } } : undefined,
  );

  const [track] = stream.getVideoTracks();
  const { width, height } = track.getSettings();
  const videoCodec = detectBestVideoCodec();
  const isSvcCodec = videoCodec === "vp9" || videoCodec === "av1";

  const publication = await room.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShare,
    simulcast: true,
    videoCodec,
    scalabilityMode: isSvcCodec ? "L3T3_KEY" : undefined,
    backupCodec: true,
    // "maintain-resolution" (default do LiveKit p/ screen share) prioriza nitidez de texto e
    // derruba frames sob pressão de banda — ótimo pra apresentação/código, péssimo pra jogos
    // (movimento precisa de FPS estável). "balanced" foi tentado antes e ainda deixava o encoder
    // cair frame quando quisesse — testado em produção com jogo de movimento rápido (Rocket
    // League) e mostrou stutter real. "maintain-framerate" nunca cai de FPS, reduz resolução
    // primeiro — CLAUDE.md prioriza baixa latência/fluidez pra jogos igual ou mais que nitidez.
    degradationPreference: "maintain-framerate",
    screenShareEncoding: {
      maxBitrate: getMaxBitrate(width ?? 1920, height ?? 1080, settings),
      maxFramerate: settings.fps === "auto" ? undefined : settings.fps,
    },
    screenShareSimulcastLayers: pickSimulcastLayers(height ?? 1080),
  });

  const [audioTrack] = stream.getAudioTracks();
  if (audioTrack) {
    await room.localParticipant.publishTrack(audioTrack, {
      source: Track.Source.ScreenShareAudio,
      // Áudio de tela é normalmente sistema/jogo/música, não voz — subir pro preset de maior
      // qualidade e desligar dtx (que corta trechos "silenciosos" pensando em pausa de fala)
      // evita perder nuance de trilha/efeitos. red (redundância) segura perda de pacote sem
      // depender de retransmissão.
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: true,
      forceStereo: true,
    });
  }

  return {
    room,
    publication,
    disconnect: async () => {
      await room.disconnect();
      // Ver docs/INSIGHTS-ENCODER.md #15 — evita que uma escolha ruim de codec (caiu em software
      // por motivo passageiro) contamine as próximas transmissões nessa mesma sessão do app.
      resetCodecCache();
    },
  };
}

// Ação explícita (nunca automática) pra quando o codec preferencial caiu em software pesado
// (AV1/VP9 via libaom/libvpx) — despublica e republica a MESMA track já forçando H.264. Causa um
// soluço visual curto pros espectadores (é republicação, não replaceTrack), por isso é sempre o
// usuário quem aciona (docs/INSIGHTS-ENCODER.md #13).
export async function switchToH264(session: BroadcastSession, settings: StreamSettings): Promise<void> {
  const track = session.publication.track?.mediaStreamTrack;
  if (!track) throw new Error("Nenhuma track de vídeo ativa pra trocar de codec.");

  const { width, height } = track.getSettings();

  await session.room.localParticipant.unpublishTrack(session.publication.track!);

  session.publication = await session.room.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShare,
    simulcast: true,
    videoCodec: "h264",
    backupCodec: true,
    degradationPreference: "maintain-framerate",
    screenShareEncoding: {
      maxBitrate: getMaxBitrate(width ?? 1920, height ?? 1080, settings),
      maxFramerate: settings.fps === "auto" ? undefined : settings.fps,
    },
    screenShareSimulcastLayers: pickSimulcastLayers(height ?? 1080),
  });
}

export interface PublishStats {
  bitrateKbps: number;
  packetLossPercent: number;
  codec: string;
  encoderImplementation: string | null;
  // QP médio (quantization parameter) desde a última leitura — QP alto = mesmo bitrate saindo
  // com blocking visível. `null` quando o browser não expõe `qpSum`.
  avgQp: number | null;
  // Resolução/FPS REAIS sendo codificados agora (camada base do simulcast), atualizado a cada
  // poll — não confundir com o preset escolhido nas configurações, que é só teto/alvo.
  actualResolution: string;
  actualFps: number;
  // "none" | "cpu" | "bandwidth" | "other" — o Chromium já sabe dizer por que tá reduzindo
  // qualidade (docs/INSIGHTS-ENCODER.md #14).
  qualityLimitationReason: string | null;
  // Tempo médio de encode por frame (ms) — indicador antecedente de sobrecarga, antes de frames
  // começarem a cair de verdade.
  avgEncodeMs: number | null;
  // true quando qualquer camada do simulcast (não só a base) está em software.
  hasSoftwareLayer: boolean;
}

// Simulcast publica 3 camadas simultâneas — cada uma vira seu próprio outbound-rtp no mesmo
// getStats(), sem ordem garantida entre elas.
const lastBytesSentByLayer = new Map<string, number>();
let lastTimestamp = 0;
let lastQpSum = 0;
let lastFramesEncoded = 0;
let lastTotalEncodeTime = 0;

export async function readPublishStats(publication: LocalTrackPublication): Promise<PublishStats | null> {
  const sender = publication.track?.sender;
  if (!sender) return null;

  const report = await sender.getStats();

  // Com simulcast há um outbound-rtp por camada (rid q/h/f) — sem isso, pegar "o primeiro que
  // aparecer no Map" arriscava mostrar QP/bitrate/resolução da camada de qualidade MAIS BAIXA
  // (360p) em vez da camada base real que a maioria dos espectadores enxerga.
  const videoStats = Array.from(report.values()).filter(
    (stat) => stat.type === "outbound-rtp" && stat.kind === "video",
  );
  if (videoStats.length === 0) return null;

  const primary = videoStats.reduce((best, stat) => {
    const area = (stat.frameWidth ?? 0) * (stat.frameHeight ?? 0);
    const bestArea = (best.frameWidth ?? 0) * (best.frameHeight ?? 0);
    return area > bestArea ? stat : best;
  }, videoStats[0]);

  const timestamp: number = primary.timestamp ?? 0;

  let bitrateKbps = 0;
  if (lastTimestamp > 0 && timestamp > lastTimestamp) {
    const secondsDelta = (timestamp - lastTimestamp) / 1000;
    let totalBytesDelta = 0;
    for (const stat of videoStats) {
      const ssrc = String(stat.ssrc ?? stat.id);
      const bytesSent: number = stat.bytesSent ?? 0;
      const previous = lastBytesSentByLayer.get(ssrc) ?? bytesSent;
      totalBytesDelta += Math.max(0, bytesSent - previous);
      lastBytesSentByLayer.set(ssrc, bytesSent);
    }
    bitrateKbps = Math.max(0, Math.round((totalBytesDelta * 8) / secondsDelta / 1000));
  } else {
    for (const stat of videoStats) {
      lastBytesSentByLayer.set(String(stat.ssrc ?? stat.id), stat.bytesSent ?? 0);
    }
  }
  lastTimestamp = timestamp;

  const packetsSent: number = primary.packetsSent ?? 0;
  const retransmitted: number = primary.retransmittedPacketsSent ?? 0;
  const packetLossPercent = packetsSent > 0 ? Math.round((retransmitted / packetsSent) * 1000) / 10 : 0;

  const encoderImplementation: string | null = primary.encoderImplementation ?? null;
  const qpSum: number | undefined = primary.qpSum;
  const framesEncoded: number | undefined = primary.framesEncoded;
  const totalEncodeTime: number | undefined = primary.totalEncodeTime;
  const qualityLimitationReason: string | null = primary.qualityLimitationReason ?? null;

  let avgQp: number | null = null;
  let avgEncodeMs: number | null = null;
  if (typeof qpSum === "number" && typeof framesEncoded === "number") {
    const framesDelta = framesEncoded - lastFramesEncoded;
    if (framesDelta > 0) {
      avgQp = Math.round(((qpSum - lastQpSum) / framesDelta) * 10) / 10;
      if (typeof totalEncodeTime === "number") {
        const encodeTimeDelta = totalEncodeTime - lastTotalEncodeTime;
        avgEncodeMs = Math.round((encodeTimeDelta / framesDelta) * 1000 * 10) / 10;
      }
    }
    lastQpSum = qpSum;
    lastFramesEncoded = framesEncoded;
    if (typeof totalEncodeTime === "number") lastTotalEncodeTime = totalEncodeTime;
  }

  const hasSoftwareLayer = videoStats.some((stat) => isSoftwareEncoder(stat.encoderImplementation ?? null));

  let codec = "?";
  const codecId: string | undefined = primary.codecId;
  if (codecId && report.has(codecId)) {
    const mimeType: string | undefined = report.get(codecId)?.mimeType;
    if (mimeType) codec = mimeType.replace("video/", "");
  }

  const actualResolution =
    primary.frameWidth && primary.frameHeight ? `${primary.frameWidth} × ${primary.frameHeight}` : "—";
  const actualFps = primary.framesPerSecond ? Math.round(primary.framesPerSecond) : 0;

  return {
    bitrateKbps,
    packetLossPercent,
    codec,
    encoderImplementation,
    avgQp,
    actualResolution,
    actualFps,
    qualityLimitationReason,
    avgEncodeMs,
    hasSoftwareLayer,
  };
}
