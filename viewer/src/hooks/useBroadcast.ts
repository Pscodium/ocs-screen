import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { captureScreen, stopCapture } from "../services/capture";
import { createRoom, endRoom } from "../services/backend";
import { startBroadcast, readPublishStats, type BroadcastSession } from "../services/publish";
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
  hasAudio: boolean;
  codec: string;
  encoderImplementation: string | null;
  avgQp: number | null;
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

  const start = useCallback(async (settings: StreamSettings, slug?: string) => {
    setState("starting");
    setError(null);
    try {
      const { stream, settings: actualSettings, hasAudio } = await captureScreen(settings);
      streamRef.current = stream;

      const room = await createRoom(settings, slug);
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
        hasAudio,
        codec: "?",
        encoderImplementation: null,
        avgQp: null,
      });
      setState("live");

      statsIntervalRef.current = setInterval(async () => {
        const stats = await readPublishStats(session.publication);
        if (stats) {
          setInfo((prev) =>
            prev
              ? {
                  ...prev,
                  bitrateKbps: stats.bitrateKbps,
                  packetLossPercent: stats.packetLossPercent,
                  codec: stats.codec,
                  encoderImplementation: stats.encoderImplementation,
                  avgQp: stats.avgQp,
                  actualResolution: stats.actualResolution !== "—" ? stats.actualResolution : prev.actualResolution,
                  actualFps: stats.actualFps > 0 ? stats.actualFps : prev.actualFps,
                }
              : prev,
          );
        }
      }, STATS_POLL_MS);
    } catch (err) {
      // Se a captura já tinha começado (ex.: sala falhou por slug duplicado), não deixa a
      // fonte presa aberta sem transmissão nenhuma usando ela.
      if (streamRef.current) stopCapture(streamRef.current);
      streamRef.current = null;
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
