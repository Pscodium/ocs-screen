import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { captureScreen } from "../services/capture";
import { createRoom, endRoom } from "../services/backend";
import {
  startBroadcast,
  readPublishStats,
  swapVideoTrack,
  swapAudioTrack,
  type BroadcastSession,
} from "../services/livekit";
import type { StreamSettings } from "../types/stream";
import type { CaptureSource } from "../../../preload/index";

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
  const [swapping, setSwapping] = useState(false);

  const stopCaptureRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<BroadcastSession | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guardado pra poder recapturar com as mesmas preferências ao trocar de fonte ao vivo.
  const settingsRef = useRef<StreamSettings | null>(null);

  const start = useCallback(async (settings: StreamSettings, source: CaptureSource, slug?: string) => {
    setState("starting");
    setError(null);
    settingsRef.current = settings;
    try {
      const { stream, settings: actualSettings, hasAudio, stopAll } = await captureScreen(
        settings,
        source,
        // Track pode parar sozinha (ex.: usuário fecha a janela compartilhada).
        () => stop(),
      );
      stopCaptureRef.current = stopAll;

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
                  // Só sobrescreve quando o outbound-rtp já tem um frame real codificado — evita
                  // piscar pro "—"/0 caso uma leitura pontual venha sem esses campos.
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
      stopCaptureRef.current?.();
      stopCaptureRef.current = null;
      setError(err instanceof Error ? err.message : "Erro ao iniciar transmissão.");
      setState("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Troca a fonte sem parar a transmissão — espectadores continuam conectados o tempo todo
  // (replaceTrack não renegocia a conexão, ver services/livekit.ts).
  const swapSource = useCallback(async (source: CaptureSource) => {
    if (!sessionRef.current || !settingsRef.current) return;
    setSwapping(true);
    try {
      const { stream, settings: actualSettings, hasAudio, stopAll } = await captureScreen(
        settingsRef.current,
        source,
        () => stop(),
      );

      const [newVideoTrack] = stream.getVideoTracks();
      const [newAudioTrack] = stream.getAudioTracks();

      await swapVideoTrack(sessionRef.current, newVideoTrack);
      sessionRef.current.audioPublication = await swapAudioTrack(sessionRef.current, newAudioTrack);

      // Só depois que a nova track já está no ar é seguro derrubar a captura antiga.
      const previousStop = stopCaptureRef.current;
      stopCaptureRef.current = stopAll;
      previousStop?.();

      setInfo((prev) =>
        prev
          ? {
              ...prev,
              actualResolution:
                actualSettings.width && actualSettings.height
                  ? `${actualSettings.width} × ${actualSettings.height}`
                  : "—",
              actualFps: actualSettings.frameRate ? Math.round(actualSettings.frameRate) : 0,
              hasAudio,
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao trocar a fonte.");
    } finally {
      setSwapping(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(async () => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    statsIntervalRef.current = null;

    if (stopCaptureRef.current) stopCaptureRef.current();
    if (sessionRef.current) await sessionRef.current.disconnect();
    if (roomIdRef.current) await endRoom(roomIdRef.current).catch(() => {});

    stopCaptureRef.current = null;
    sessionRef.current = null;
    roomIdRef.current = null;
    settingsRef.current = null;
    setInfo(null);
    setState("idle");
  }, []);

  useEffect(() => {
    return () => {
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    };
  }, []);

  return { state, info, error, start, stop, swapSource, swapping };
}
