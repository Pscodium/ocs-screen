import {
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
  const { height } = track.getSettings();
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
    degradationPreference: "maintain-resolution",
    screenShareEncoding: {
      maxBitrate: getMaxBitrate(settings),
      maxFramerate: settings.fps === "auto" ? undefined : settings.fps,
    },
    screenShareSimulcastLayers: pickSimulcastLayers(height ?? 1080),
  });

  return {
    room,
    publication,
    disconnect: async () => {
      await room.disconnect();
    },
  };
}

export interface PublishStats {
  bitrateKbps: number;
  packetLossPercent: number;
}

let lastBytesSent = 0;
let lastTimestamp = 0;

export async function readPublishStats(publication: LocalTrackPublication): Promise<PublishStats | null> {
  const sender = publication.track?.sender;
  if (!sender) return null;

  const report = await sender.getStats();
  for (const stat of report.values()) {
    if (stat.type !== "outbound-rtp" || stat.kind !== "video") continue;

    const bytesSent: number = stat.bytesSent ?? 0;
    const timestamp: number = stat.timestamp ?? 0;
    const packetsSent: number = stat.packetsSent ?? 0;
    const retransmitted: number = stat.retransmittedPacketsSent ?? 0;

    let bitrateKbps = 0;
    if (lastTimestamp > 0 && timestamp > lastTimestamp) {
      const bytesDelta = bytesSent - lastBytesSent;
      const secondsDelta = (timestamp - lastTimestamp) / 1000;
      bitrateKbps = Math.max(0, Math.round((bytesDelta * 8) / secondsDelta / 1000));
    }
    lastBytesSent = bytesSent;
    lastTimestamp = timestamp;

    const packetLossPercent = packetsSent > 0 ? Math.round((retransmitted / packetsSent) * 1000) / 10 : 0;

    return { bitrateKbps, packetLossPercent };
  }

  return null;
}
