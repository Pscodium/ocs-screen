import { useEffect, useRef, useState } from "react";
import { ConnectionState, Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { fetchViewerToken } from "../services/api";

export type ConnectionPhase = "connecting" | "connected" | "ended" | "error";

export interface StreamStats {
  resolution: string;
  fps: number;
  bitrateKbps: number;
  latencyMs: number;
  packetLossPercent: number;
}

const STATS_POLL_MS = 2000;

let lastBytesReceived = 0;
let lastTimestamp = 0;

async function readSubscribeStats(track: RemoteTrack): Promise<Partial<StreamStats> | null> {
  const receiver = track.receiver;
  if (!receiver) return null;

  const report = await receiver.getStats();
  for (const stat of report.values()) {
    if (stat.type !== "inbound-rtp" || stat.kind !== "video") continue;

    const bytesReceived: number = stat.bytesReceived ?? 0;
    const timestamp: number = stat.timestamp ?? 0;
    const packetsReceived: number = stat.packetsReceived ?? 0;
    const packetsLost: number = stat.packetsLost ?? 0;
    const jitterBufferDelay: number = stat.jitterBufferDelay ?? 0;
    const jitterBufferEmittedCount: number = stat.jitterBufferEmittedCount ?? 0;

    let bitrateKbps = 0;
    if (lastTimestamp > 0 && timestamp > lastTimestamp) {
      const bytesDelta = bytesReceived - lastBytesReceived;
      const secondsDelta = (timestamp - lastTimestamp) / 1000;
      bitrateKbps = Math.max(0, Math.round((bytesDelta * 8) / secondsDelta / 1000));
    }
    lastBytesReceived = bytesReceived;
    lastTimestamp = timestamp;

    const totalPackets = packetsReceived + packetsLost;
    const packetLossPercent = totalPackets > 0 ? Math.round((packetsLost / totalPackets) * 1000) / 10 : 0;
    const latencyMs =
      jitterBufferEmittedCount > 0 ? Math.round((jitterBufferDelay / jitterBufferEmittedCount) * 1000) : 0;

    return { bitrateKbps, packetLossPercent, latencyMs };
  }

  return null;
}

export function useRoomStream(roomId: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Connecting);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [hasAudio, setHasAudio] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let statsInterval: ReturnType<typeof setInterval> | null = null;
    const room = new Room({
      // adaptiveStream: pede ao host a camada simulcast adequada ao tamanho real do player
      // (CLAUDE.md §Simulcast/SVC — adaptação sem exigir stream independente por espectador).
      adaptiveStream: true,
      dynacast: true,
    });

    room.on(RoomEvent.ConnectionStateChanged, setConnectionState);

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (!videoRef.current) return;

      // Anexar áudio e vídeo no mesmo elemento combina as duas tracks num único MediaStream
      // (attachToElement do livekit-client) — o <video> toca o som junto, sem <audio> separado.
      track.attach(videoRef.current);

      if (track.kind === Track.Kind.Audio) {
        setHasAudio(true);
        return;
      }
      if (track.kind !== Track.Kind.Video) return;

      const settings = track.mediaStreamTrack.getSettings();
      setStats({
        resolution: settings.width && settings.height ? `${settings.width} × ${settings.height}` : "—",
        fps: settings.frameRate ? Math.round(settings.frameRate) : 0,
        bitrateKbps: 0,
        latencyMs: 0,
        packetLossPercent: 0,
      });

      statsInterval = setInterval(async () => {
        const partial = await readSubscribeStats(track);
        if (partial) setStats((prev) => (prev ? { ...prev, ...partial } : prev));
      }, STATS_POLL_MS);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) setHasAudio(false);
    });

    room.on(RoomEvent.Disconnected, () => {
      if (!cancelled) setPhase("ended");
    });

    (async () => {
      try {
        const { token, livekitUrl } = await fetchViewerToken(roomId);
        if (cancelled) return;
        await room.connect(livekitUrl, token);
        if (cancelled) return;
        setPhase("connected");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Erro desconhecido.");
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      if (statsInterval) clearInterval(statsInterval);
      room.disconnect();
    };
  }, [roomId]);

  return { videoRef, phase, connectionState, error, stats, hasAudio };
}
