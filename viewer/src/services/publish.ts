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

// Espelha desktop/src/services/livekit.ts — mesma lógica de publish, cliente web em vez de Tauri.
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
  const room = new Room({ dynacast: true });

  room.on(RoomEvent.ParticipantConnected, () => onParticipantCountChange(room.remoteParticipants.size));
  room.on(RoomEvent.ParticipantDisconnected, () => onParticipantCountChange(room.remoteParticipants.size));
  room.on(RoomEvent.ConnectionStateChanged, onConnectionStateChange);

  await room.connect(livekitUrl, token);

  const [track] = stream.getVideoTracks();
  const { height } = track.getSettings();
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
    // (movimento precisa de FPS estável). "balanced" deixa o encoder decidir dinamicamente.
    degradationPreference: "balanced",
    screenShareEncoding: {
      maxBitrate: getMaxBitrate(settings),
      maxFramerate: settings.fps === "auto" ? undefined : settings.fps,
    },
    screenShareSimulcastLayers: pickSimulcastLayers(height ?? 1080),
  });

  const [audioTrack] = stream.getAudioTracks();
  if (audioTrack) {
    await room.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
  }

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
