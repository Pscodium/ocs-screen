import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { captureScreen, stopCapture } from "../services/capture";
import { createRoom, endRoom, type RoomAccess } from "../services/backend";
import { startBroadcast, readPublishStats, switchToH264, type BroadcastSession } from "../services/publish";
import { WebNativeHost, isWebNativeHostSupported } from "../services/webNativeHost";
import { AUTO_FPS_TARGET, getMaxBitrate, type StreamSettings } from "../types/stream";

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
  qualityLimitationReason: string | null;
  avgEncodeMs: number | null;
  hasSoftwareLayer: boolean;
}

const STATS_POLL_MS = 2000;

export function useBroadcast() {
  const [state, setState] = useState<BroadcastState>("idle");
  const [info, setInfo] = useState<BroadcastInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optimizingCodec, setOptimizingCodec] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<BroadcastSession | null>(null);
  const nativeHostRef = useRef<WebNativeHost | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settingsRef = useRef<StreamSettings | null>(null);

  const start = useCallback(async (settings: StreamSettings, slug?: string, access?: RoomAccess) => {
    setState("starting");
    setError(null);
    settingsRef.current = settings;
    try {
      const { stream, settings: actualSettings, hasAudio } = await captureScreen(settings);
      streamRef.current = stream;

      // Caminho principal: protocolo do transporte nativo (WebCodecs + DataChannel, mesmo viewer
      // do app desktop — ver services/webNativeHost.ts). LiveKit só sobra como fallback pra
      // navegador sem WebCodecs/Insertable Streams (Firefox, Safari).
      const useNative = isWebNativeHostSupported();
      const room = await createRoom(settings, slug, access, useNative);
      roomIdRef.current = room.roomId;

      if (useNative) {
        const width = actualSettings.width ?? 1920;
        const height = actualSettings.height ?? 1080;
        const host = new WebNativeHost({
          roomId: room.roomId,
          stream,
          bitrateBps: getMaxBitrate(width, height, settings),
          fps: settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps,
          onViewerCount: (count) => setInfo((prev) => (prev ? { ...prev, viewerCount: count } : prev)),
        });
        nativeHostRef.current = host;
        await host.start();
      } else {
        sessionRef.current = await startBroadcast(
          room.livekitUrl,
          room.hostToken,
          stream,
          settings,
          (count) => setInfo((prev) => (prev ? { ...prev, viewerCount: count } : prev)),
          (connectionState) => setInfo((prev) => (prev ? { ...prev, connectionState } : prev)),
        );
      }

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
        codec: useNative ? "H.264" : "?",
        encoderImplementation: null,
        avgQp: null,
        qualityLimitationReason: null,
        avgEncodeMs: null,
        hasSoftwareLayer: false,
      });
      setState("live");

      statsIntervalRef.current = setInterval(async () => {
        const nativeHost = nativeHostRef.current;
        if (nativeHost) {
          const stats = nativeHost.takeStats();
          setInfo((prev) =>
            prev
              ? {
                  ...prev,
                  bitrateKbps: stats.bitrateKbps,
                  codec: `H.264 (WebCodecs, alvo ${(stats.targetBitrateKbps / 1000).toFixed(1)} Mbps)`,
                  encoderImplementation: stats.hardwareAccelerated ? "hardware" : "OpenH264 (software)",
                  avgEncodeMs: stats.avgEncodeMs,
                  actualResolution: stats.width ? `${stats.width} × ${stats.height}` : prev.actualResolution,
                  actualFps: stats.fps > 0 ? stats.fps : prev.actualFps,
                }
              : prev,
          );
          return;
        }
        const session = sessionRef.current;
        if (!session) return;
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
                  qualityLimitationReason: stats.qualityLimitationReason,
                  avgEncodeMs: stats.avgEncodeMs,
                  hasSoftwareLayer: stats.hasSoftwareLayer,
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

  // Ação explícita do usuário (nunca automática — docs/INSIGHTS-ENCODER.md #13) pra forçar H.264
  // quando o codec preferencial cair em software pesado. Causa um soluço visual curto pros
  // espectadores (é republicação, não replaceTrack).
  const optimizeCodec = useCallback(async () => {
    if (!sessionRef.current || !settingsRef.current) return;
    setOptimizingCodec(true);
    try {
      await switchToH264(sessionRef.current, settingsRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao otimizar codec.");
    } finally {
      setOptimizingCodec(false);
    }
  }, []);

  const stop = useCallback(async () => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    statsIntervalRef.current = null;

    if (streamRef.current) stopCapture(streamRef.current);
    nativeHostRef.current?.stop();
    nativeHostRef.current = null;
    if (sessionRef.current) await sessionRef.current.disconnect();
    if (roomIdRef.current) await endRoom(roomIdRef.current).catch(() => {});

    streamRef.current = null;
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

  return { state, info, error, start, stop, optimizeCodec, optimizingCodec };
}
