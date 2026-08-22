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
import { detectBestVideoCodec } from "./codecs";

export interface BroadcastSession {
  room: Room;
  publication: LocalTrackPublication;
  audioPublication: LocalTrackPublication | null;
  disconnect: () => Promise<void>;
}

// Camadas simulcast por resolução alvo — permite que espectadores com banda menor recebam
// qualidade menor sem exigir um encode independente do host (CLAUDE.md §Simulcast/SVC).
function pickSimulcastLayers(actualHeight: number): VideoPreset[] {
  if (actualHeight >= 2160) return [VideoPresets.h360, VideoPresets.h720, VideoPresets.h1440];
  if (actualHeight >= 1440) return [VideoPresets.h360, VideoPresets.h720];
  if (actualHeight >= 1080) return [VideoPresets.h360, VideoPresets.h720];
  return [VideoPresets.h180, VideoPresets.h360];
}

export async function startBroadcast(
  livekitUrl: string,
  token: string,
  stream: MediaStream,
  settings: StreamSettings,
  onParticipantCountChange: (count: number) => void,
  onConnectionStateChange: (state: ConnectionState) => void,
): Promise<BroadcastSession> {
  const room = new Room({
    // dynacast pausa camadas simulcast que nenhum espectador está consumindo — reduz CPU/banda do host.
    dynacast: true,
  });

  room.on(RoomEvent.ParticipantConnected, () => onParticipantCountChange(room.remoteParticipants.size));
  room.on(RoomEvent.ParticipantDisconnected, () => onParticipantCountChange(room.remoteParticipants.size));
  room.on(RoomEvent.ConnectionStateChanged, onConnectionStateChange);

  await room.connect(livekitUrl, token);

  const [track] = stream.getVideoTracks();
  const { width, height } = track.getSettings();
  const videoCodec = detectBestVideoCodec();
  // VP9/AV1 são SVC — LiveKit desativa simulcast automaticamente pra eles e usa camadas
  // temporais/espaciais dentro do próprio stream (CLAUDE.md §Simulcast/SVC). L3T3_KEY = 3
  // camadas espaciais x 3 temporais, o equilíbrio recomendado pelo LiveKit pra screen share.
  const isSvcCodec = videoCodec === "vp9" || videoCodec === "av1";

  const publication = await room.localParticipant.publishTrack(track, {
    source: Track.Source.ScreenShare,
    simulcast: true,
    videoCodec,
    scalabilityMode: isSvcCodec ? "L3T3_KEY" : undefined,
    // Fallback automático: se o espectador não suportar o codec preferencial, LiveKit publica
    // uma track secundária no codec de backup (CLAUDE.md §Codecs).
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
  let audioPublication: LocalTrackPublication | null = null;
  if (audioTrack) {
    audioPublication = await room.localParticipant.publishTrack(audioTrack, {
      source: Track.Source.ScreenShareAudio,
      // Áudio de tela é normalmente sistema/jogo/música, não voz — o preset padrão do LiveKit
      // pouca gente nota que já é "music", mas subir pra "musicHighQualityStereo" + desligar
      // dtx (que corta trechos "silenciosos" pensando em pausas de fala) evita perder nuance em
      // trilha sonora/efeitos. red (redundância) ajuda a segurar perda de pacote sem precisar de
      // retransmissão, útil já que esse áudio não tem tolerância a "engasgo" como fala tem.
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: true,
      forceStereo: true,
    });
  }

  return {
    room,
    publication,
    audioPublication,
    disconnect: async () => {
      await room.disconnect();
    },
  };
}

// Troca a fonte da transmissão sem derrubar a conexão dos espectadores — `replaceTrack` troca só
// o MediaStreamTrack por trás do RTCRtpSender já existente, sem renegociar SDP/ICE. Espectadores
// não veem reconexão nenhuma, só o vídeo mudando.
export async function swapVideoTrack(session: BroadcastSession, newTrack: MediaStreamTrack): Promise<void> {
  await session.publication.track?.replaceTrack(newTrack);
}

// Áudio é mais delicado: se a fonte antiga tinha áudio e a nova não (ou vice-versa), não dá só
// pra trocar a track — precisa publicar/despublicar. Só troca "no lugar" quando os dois lados têm.
export async function swapAudioTrack(
  session: BroadcastSession,
  newAudioTrack: MediaStreamTrack | undefined,
): Promise<LocalTrackPublication | null> {
  if (session.audioPublication?.track && newAudioTrack) {
    await session.audioPublication.track.replaceTrack(newAudioTrack);
    return session.audioPublication;
  }

  if (session.audioPublication && !newAudioTrack) {
    await session.room.localParticipant.unpublishTrack(session.audioPublication.track!);
    return null;
  }

  if (!session.audioPublication && newAudioTrack) {
    return session.room.localParticipant.publishTrack(newAudioTrack, {
      source: Track.Source.ScreenShareAudio,
    });
  }

  return session.audioPublication;
}

export interface PublishStats {
  bitrateKbps: number;
  packetLossPercent: number;
  codec: string;
  // Chrome expõe isso em outbound-rtp (nem todo browser/versão manda) — "ExternalEncoder" é
  // hardware; nomes tipo "libvpx"/"libaom"/"openh264" são software. É a única forma de
  // confirmar se o codec escolhido tá realmente usando GPU sem sair do JS.
  encoderImplementation: string | null;
  // QP médio (quantization parameter) desde a última leitura — indica o quanto o encoder está
  // "sofrendo" pra caber no bitrate configurado. QP baixo = comprimindo limpo; QP alto = mesmo
  // bitrate saindo com blocking visível. `null` quando o browser não expõe `qpSum` (nem todo
  // browser/codec reporta).
  avgQp: number | null;
  // Resolução/FPS REAIS sendo codificados agora (camada base do simulcast) — não confundir com
  // o preset escolhido nas configurações, que é só um teto/alvo, não garantia (CLAUDE.md §Captura
  // de tela). Vem do outbound-rtp, atualizado a cada poll — nunca fica "congelado" num valor
  // antigo como um snapshot único de `getSettings()` no início da transmissão ficaria.
  actualResolution: string;
  actualFps: number;
}

// Simulcast publica 3 camadas simultâneas — cada uma vira seu próprio outbound-rtp no mesmo
// getStats(), sem ordem garantida entre elas. `lastBytesSentByLayer` evita que a camada errada
// "contamine" o delta de bitrate de outra entre leituras (cada ssrc tem sua própria contagem
// cumulativa de bytes).
const lastBytesSentByLayer = new Map<string, number>();
let lastTimestamp = 0;
let lastQpSum = 0;
let lastFramesEncoded = 0;

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

  // Bitrate total é a SOMA de todas as camadas (é o upload real gasto pelo host), não só da
  // camada base — mas QP/resolução/fps/codec exibidos são só da camada base (`primary`), que é o
  // que representa a qualidade "cheia" da transmissão.
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

  let avgQp: number | null = null;
  if (typeof qpSum === "number" && typeof framesEncoded === "number") {
    const framesDelta = framesEncoded - lastFramesEncoded;
    if (framesDelta > 0) avgQp = Math.round(((qpSum - lastQpSum) / framesDelta) * 10) / 10;
    lastQpSum = qpSum;
    lastFramesEncoded = framesEncoded;
  }

  let codec = "?";
  const codecId: string | undefined = primary.codecId;
  if (codecId && report.has(codecId)) {
    const codecStat = report.get(codecId);
    const mimeType: string | undefined = codecStat?.mimeType;
    if (mimeType) codec = mimeType.replace("video/", "");
  }

  const actualResolution =
    primary.frameWidth && primary.frameHeight ? `${primary.frameWidth} × ${primary.frameHeight}` : "—";
  const actualFps = primary.framesPerSecond ? Math.round(primary.framesPerSecond) : 0;

  return { bitrateKbps, packetLossPercent, codec, encoderImplementation, avgQp, actualResolution, actualFps };
}
