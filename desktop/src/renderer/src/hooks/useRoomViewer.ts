import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState, Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { fetchViewerToken } from "../services/backend";

export type ViewerPhase = "connecting" | "connected" | "ended" | "error";

export interface ViewerStats {
  resolution: string;
  fps: number;
  bitrateKbps: number;
  latencyMs: number;
  packetLossPercent: number;
}

const STATS_POLL_MS = 2000;

export const PLAYOUT_DELAY_MAX_MS = 1000;
export const PLAYOUT_DELAY_DEFAULT_MS = 150;

// Ver nota em services/livekit.ts — LiveKit local não precisa de STUN público, e tentar gatherar
// candidatos contra Google/Twilio só atrasa a conexão e polui o log em máquinas com várias
// interfaces de rede virtuais.
function isLocalLivekitUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url.replace(/^ws/, "http"));
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

let lastBytesReceived = 0;
let lastTimestamp = 0;

async function readSubscribeStats(track: RemoteTrack): Promise<Partial<ViewerStats> | null> {
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
    const frameWidth: number | undefined = stat.frameWidth;
    const frameHeight: number | undefined = stat.frameHeight;
    const framesPerSecond: number | undefined = stat.framesPerSecond;

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

    // Resolução/FPS REAIS decodificados agora — vem do inbound-rtp, atualizado a cada poll (não
    // fica congelado no valor único de `getSettings()` lido na hora do subscribe, que às vezes
    // reporta placeholder tipo "2x2"/"Infinity FPS" antes do primeiro frame real chegar).
    return {
      bitrateKbps,
      packetLossPercent,
      latencyMs,
      resolution: frameWidth && frameHeight ? `${frameWidth} × ${frameHeight}` : undefined,
      fps: framesPerSecond ? Math.round(framesPerSecond) : undefined,
    };
  }

  return null;
}

export function useRoomViewer(roomId: string | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<ViewerPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const [playoutDelayMs, setPlayoutDelayMsState] = useState(PLAYOUT_DELAY_DEFAULT_MS);

  const receiversRef = useRef<Set<RTCRtpReceiver>>(new Set());

  const applyPlayoutDelay = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(PLAYOUT_DELAY_MAX_MS, ms));
    setPlayoutDelayMsState(clamped);
    for (const receiver of receiversRef.current) {
      receiver.playoutDelayHint = clamped / 1000;
    }
  }, []);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    let statsInterval: ReturnType<typeof setInterval> | null = null;
    setPhase("connecting");
    setError(null);
    setStats(null);
    setHasAudio(false);

    const room = new Room({ adaptiveStream: true, dynacast: true });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (!videoRef.current) return;
      track.attach(videoRef.current);

      // attachToElement() do livekit-client SEMPRE reseta `el.muted` com base em ter ou não
      // faixa de áudio no stream inteiro (`element.muted = tracks.length === 0`) — roda de novo
      // a CADA attach, então se o vídeo anexa depois do áudio (ordem não é garantida), esse
      // segundo attach desmuta de novo mesmo sem ser a track de áudio. Força mudo depois de
      // qualquer attach, não só quando kind===Audio.
      videoRef.current.muted = true;

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
        // Filtra `undefined` explícito (resolution/fps quando o browser ainda não tem esse
        // dado) — sem isso, o spread sobrescreveria o valor bom já exibido com undefined.
        if (partial) {
          const defined = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
          setStats((prev) => (prev ? { ...prev, ...defined } : prev));
        }
      }, STATS_POLL_MS);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (track.receiver) receiversRef.current.delete(track.receiver);
      if (track.kind === Track.Kind.Audio) setHasAudio(false);
    });

    room.on(RoomEvent.Disconnected, () => {
      if (!cancelled) setPhase("ended");
    });

    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      if (state === ConnectionState.Connected && !cancelled) setPhase("connected");
    });

    (async () => {
      try {
        const { token, livekitUrl } = await fetchViewerToken(roomId);
        if (cancelled) return;
        await room.connect(
          livekitUrl,
          token,
          isLocalLivekitUrl(livekitUrl) ? { rtcConfig: { iceServers: [] } } : undefined,
        );
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

  return { videoRef, phase, error, stats, hasAudio, playoutDelayMs, setPlayoutDelayMs: applyPlayoutDelay };
}
