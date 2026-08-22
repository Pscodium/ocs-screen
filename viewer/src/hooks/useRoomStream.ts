import { useCallback, useEffect, useRef, useState } from "react";
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

// Teto baixo de propósito: 2s de atraso destruiria a experiência de baixa latência que é o
// objetivo do produto (CLAUDE.md §Latência) — isso aqui é só um "colchão" pra jitter, não buffer
// de streaming tradicional.
export const PLAYOUT_DELAY_MAX_MS = 1000;
export const PLAYOUT_DELAY_DEFAULT_MS = 0;

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
  const [playoutDelayMs, setPlayoutDelayMsState] = useState(PLAYOUT_DELAY_DEFAULT_MS);

  // Recebedores das tracks já inscritas — pra poder reaplicar o hint ao vivo quando o usuário
  // mexe no slider, sem precisar reconectar. Áudio e vídeo ficam com o mesmo valor pra não
  // dessincronizar lip-sync.
  const receiversRef = useRef<Set<RTCRtpReceiver>>(new Set());

  const applyPlayoutDelay = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(PLAYOUT_DELAY_MAX_MS, ms));
    setPlayoutDelayMsState(clamped);
    for (const receiver of receiversRef.current) {
      receiver.playoutDelayHint = clamped / 1000;
    }
  }, []);

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

      if (track.receiver) {
        receiversRef.current.add(track.receiver);
        track.receiver.playoutDelayHint = playoutDelayMs / 1000;
      }

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
      if (track.receiver) receiversRef.current.delete(track.receiver);
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
      receiversRef.current.clear();
      room.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return { videoRef, phase, connectionState, error, stats, hasAudio, playoutDelayMs, setPlayoutDelayMs: applyPlayoutDelay };
}
