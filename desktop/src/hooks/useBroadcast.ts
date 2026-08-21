import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { captureScreen, stopCapture } from "../services/capture";
import { createRoom, endRoom } from "../services/backend";
import { startBroadcast, readPublishStats, type BroadcastSession } from "../services/livekit";
import type { StreamSettings } from "../types/stream";

export type BroadcastState = "idle" | "starting" | "live" | "error";

export interface BroadcastInfo {
  roomId: string;
  viewerUrl: string;
  viewerCount: number;
  actualResolution: string;
  actualFps: number;
  connectionState: ConnectionState;
  bitrateKbps: number;
  packetLossPercent: number;
}

const STATS_POLL_MS = 2000;

export function useBroadcast() {
  const [state, setState] = useState<BroadcastState>("idle");
  const [info, setInfo] = useState<BroadcastInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<BroadcastSession | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(async (settings: StreamSettings) => {
    setState("starting");
    setError(null);
    try {
      const { stream, settings: actualSettings } = await captureScreen(settings);
      streamRef.current = stream;

      const room = await createRoom(settings);
      roomIdRef.current = room.roomId;

      const session = await startBroadcast(
        room.livekitUrl,
        room.hostToken,
        stream,
        settings,
        (count) => setInfo((prev) => (prev ? { ...prev, viewerCount: count } : prev)),
        (connectionState) => setInfo((prev) => (prev ? { ...prev, connectionState } : prev)),
      );
      sessionRef.current = session;

      // Usuário pode parar o compartilhamento pelo diálogo nativo do navegador/SO.
      stream.getVideoTracks()[0].onended = () => stop();

      setInfo({
        roomId: room.roomId,
        viewerUrl: room.viewerUrl,
        viewerCount: 0,
        actualResolution:
          actualSettings.width && actualSettings.height ? `${actualSettings.width} × ${actualSettings.height}` : "—",
        actualFps: actualSettings.frameRate ? Math.round(actualSettings.frameRate) : 0,
        connectionState: ConnectionState.Connected,
        bitrateKbps: 0,
        packetLossPercent: 0,
      });
      setState("live");

      statsIntervalRef.current = setInterval(async () => {
        const stats = await readPublishStats(session.publication);
        if (stats) {
          setInfo((prev) =>
            prev ? { ...prev, bitrateKbps: stats.bitrateKbps, packetLossPercent: stats.packetLossPercent } : prev,
          );
        }
      }, STATS_POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao iniciar transmissão.");
      setState("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(async () => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    statsIntervalRef.current = null;

    if (streamRef.current) stopCapture(streamRef.current);
    if (sessionRef.current) await sessionRef.current.disconnect();
    if (roomIdRef.current) await endRoom(roomIdRef.current).catch(() => {});

    streamRef.current = null;
    sessionRef.current = null;
    roomIdRef.current = null;
    setInfo(null);
    setState("idle");
  }, []);

  useEffect(() => {
    return () => {
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    };
  }, []);

  return { state, info, error, start, stop };
}
