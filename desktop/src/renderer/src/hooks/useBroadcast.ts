import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { captureScreen, type CaptureResult } from "../services/capture";
import { createRoom, endRoom, backendUrl } from "../services/backend";
import {
  startBroadcast,
  readPublishStats,
  swapVideoTrack,
  swapAudioTrack,
  switchToH264,
  type BroadcastSession,
} from "../services/livekit";
import {
  isNativeTransportAvailable,
  startNativeTransport,
  stopNativeTransport,
  onNativeTransportEnded,
  onNativeTransportError,
  onNativeTransportState,
  onNativeTransportEncoderInfo,
  setNativeCursorEnabled,
  swapNativeTransportSource,
} from "../services/nativeTransport";
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
  qualityLimitationReason: string | null;
  avgEncodeMs: number | null;
  hasSoftwareLayer: boolean;
  // fps de captura nativa (medido no main process, antes do encoder) — `null` quando a fonte
  // atual não usa o caminho nativo (desktopCapturer não tem equivalente a reportar).
  captureFps: number | null;
  // Motivo de ter caído pro caminho antigo (LiveKit/desktopCapturer) MESMO com "Pipeline nativo"
  // ligado nas configurações — antes isso acontecia 100% em silêncio (usuário achava que tava no
  // nativo, não estava, só descobriu comparando FPS — ver docs/TASKS.md). `null` = ou não pediu
  // nativo, ou o nativo funcionou de verdade.
  nativeFallbackReason: string | null;
  // Só true quando o pipeline nativo (NVENC) tá REALMENTE ativo (não caiu pro fallback) — usado
  // pelo LiveCard pra decidir se mostra o botão de cursor ao vivo (só o caminho nativo consegue
  // ligar/desligar cursor DURANTE a transmissão; o caminho antigo/desktopCapturer sempre inclui o
  // cursor por conta do próprio SO, sem toggle possível).
  nativeMode: boolean;
  cursorEnabled: boolean;
}

const STATS_POLL_MS = 2000;

export function useBroadcast() {
  const [state, setState] = useState<BroadcastState>("idle");
  const [info, setInfo] = useState<BroadcastInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [optimizingCodec, setOptimizingCodec] = useState(false);

  const stopCaptureRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<BroadcastSession | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guardado pra poder recapturar com as mesmas preferências ao trocar de fonte ao vivo.
  const settingsRef = useRef<StreamSettings | null>(null);
  const unsubscribeCaptureStatsRef = useRef<(() => void) | null>(null);
  // Transporte nativo (Fase 3/4, ver services/nativeTransport.ts) — pula LiveKit pro vídeo. `stop()`
  // e `swapSource()` precisam saber qual caminho tá ativo pra limpar/agir certo.
  const isNativeTransportModeRef = useRef(false);
  const unsubscribeNativeEndedRef = useRef<(() => void) | null>(null);
  const unsubscribeNativeErrorRef = useRef<(() => void) | null>(null);
  const unsubscribeNativeStateRef = useRef<(() => void) | null>(null);
  const unsubscribeNativeEncoderInfoRef = useRef<(() => void) | null>(null);

  // Assina (ou limpa, se a fonte nova não for nativa) as estatísticas de fps de captura — chamado
  // tanto no `start()` quanto no `swapSource()`, já que trocar de fonte pode entrar ou sair do
  // caminho nativo.
  const subscribeCaptureStats = useCallback((onCaptureStats: CaptureResult["onCaptureStats"]) => {
    unsubscribeCaptureStatsRef.current?.();
    unsubscribeCaptureStatsRef.current = null;
    if (!onCaptureStats) {
      setInfo((prev) => (prev ? { ...prev, captureFps: null } : prev));
      return;
    }
    unsubscribeCaptureStatsRef.current = onCaptureStats((stats) => {
      setInfo((prev) => (prev ? { ...prev, captureFps: stats.fps } : prev));
    });
  }, []);

  const start = useCallback(async (settings: StreamSettings, source: CaptureSource, slug?: string) => {
    setState("starting");
    setError(null);
    settingsRef.current = settings;

    // Modo nativo (opt-in, ver services/nativeTransport.ts): captura (DXGI/monitor ou WGC/janela)
    // → NVENC → RTP nativo, pula LiveKit pro vídeo inteiro.
    const nativeSource =
      source.nativeMonitorIndex !== undefined
        ? { monitorIndex: source.nativeMonitorIndex }
        : source.nativeWindowHandle !== undefined
          ? { hwnd: source.nativeWindowHandle }
          : null;
    const nativeAvailable = await isNativeTransportAvailable();
    // Preenchido só quando o usuário PEDIU nativo mas caiu pro caminho antigo mesmo assim — vira
    // aviso visível no LiveCard (bug real relatado: usuário testou achando que tava no nativo,
    // só percebeu que não porque comparou FPS manualmente — antes essa queda era 100% silenciosa).
    let nativeFallbackReason: string | null = null;
    if (settings.nativeTransport && !nativeAvailable) {
      nativeFallbackReason = "Pipeline nativo indisponível nessa instalação — usando encoder do navegador.";
    } else if (settings.nativeTransport && !nativeSource) {
      nativeFallbackReason = "Essa fonte não pôde ser preparada pro pipeline nativo — usando encoder do navegador.";
    }

    if (settings.nativeTransport && nativeSource && nativeAvailable) {
      try {
        const room = await createRoom(settings, slug, true);
        roomIdRef.current = room.roomId;

        const ok = await startNativeTransport(room.roomId, backendUrl, nativeSource, settings);
        if (!ok) throw new Error("Falha ao iniciar o pipeline nativo (captura ou encoder NVENC indisponível).");

        isNativeTransportModeRef.current = true;
        unsubscribeNativeEndedRef.current = onNativeTransportEnded(() => stop());
        unsubscribeNativeErrorRef.current = onNativeTransportError((message) => setError(message));
        // Multi-espectador (1 sessão TransportCore por viewer, ver docs/NATIVE_CAPTURE.md Fase 4
        // "SFU") — `connectedCount` já vem calculado do main process (soma de sessões
        // conectadas). Sem isso o LiveCard sempre mostrava "0" mesmo com gente assistindo
        // (viewerCount nunca era atualizado nesse caminho, só o `setInfo` inicial fixava 0 uma vez).
        unsubscribeNativeStateRef.current = onNativeTransportState(({ connectedCount }) => {
          setInfo((prev) => (prev ? { ...prev, viewerCount: connectedCount } : prev));
        });
        // Fallback pro Media Foundation (software) quando NVENC não inicializa, e/ou codec
        // degradado (pediu HEVC, ficou H.264) — usuário merece saber dos dois (ver
        // docs/NATIVE_CAPTURE.md Fase 3 "Fallback de encoder por software"/"HEVC"). Dispara de
        // novo se o host reiniciar em H.264 porque o viewer não decodifica HEVC.
        unsubscribeNativeEncoderInfoRef.current = onNativeTransportEncoderInfo(({ software, codec }) => {
          const codecLabel = codec === "hevc" ? "HEVC" : codec === "av1" ? "AV1" : "H.264";
          const engineLabel = software ? "software, sem NVENC" : "NVENC (nativo)";
          setInfo((prev) => (prev ? { ...prev, codec, encoderImplementation: `${codecLabel} — ${engineLabel}` } : prev));
          if (software) {
            setError(
              "GPU NVIDIA/NVENC não disponível — usando encoder por software (mais lento, consome mais CPU).",
            );
          }
        });

        setInfo({
          roomId: room.roomId,
          viewerUrl: room.viewerUrl,
          viewerCount: 0,
          actualResolution: "—",
          actualFps: settings.fps === "auto" ? 0 : settings.fps,
          connectionState: ConnectionState.Connected,
          bitrateKbps: 0,
          packetLossPercent: 0,
          hasAudio: false,
          codec: "h264",
          encoderImplementation: "NVENC (nativo)",
          avgQp: null,
          qualityLimitationReason: null,
          avgEncodeMs: null,
          hasSoftwareLayer: false,
          captureFps: null,
          nativeFallbackReason: null,
          nativeMode: true,
          cursorEnabled: settings.showCursor,
        });
        setState("live");
      } catch (err) {
        if (roomIdRef.current) await endRoom(roomIdRef.current).catch(() => {});
        roomIdRef.current = null;
        setError(err instanceof Error ? err.message : "Erro ao iniciar transmissão nativa.");
        setState("error");
      }
      return;
    }

    try {
      const { stream, settings: actualSettings, hasAudio, stopAll, onCaptureStats } = await captureScreen(
        settings,
        source,
        // Track pode parar sozinha (ex.: usuário fecha a janela compartilhada).
        () => stop(),
      );
      stopCaptureRef.current = stopAll;
      subscribeCaptureStats(onCaptureStats);

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
        qualityLimitationReason: null,
        avgEncodeMs: null,
        hasSoftwareLayer: false,
        captureFps: null,
        nativeFallbackReason,
        nativeMode: false,
        cursorEnabled: settings.showCursor,
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
                  qualityLimitationReason: stats.qualityLimitationReason,
                  avgEncodeMs: stats.avgEncodeMs,
                  hasSoftwareLayer: stats.hasSoftwareLayer,
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
  // (replaceTrack não renegocia a conexão no caminho LiveKit; no pipeline nativo as sessões
  // TransportCore também não dependem da captura, só recebem bytes do encoder — ver
  // services/nativeTransport.ts / addon.cpp).
  const swapSource = useCallback(async (source: CaptureSource) => {
    if (isNativeTransportModeRef.current) {
      const nativeSource =
        source.nativeMonitorIndex !== undefined
          ? { monitorIndex: source.nativeMonitorIndex }
          : source.nativeWindowHandle !== undefined
            ? { hwnd: source.nativeWindowHandle }
            : null;
      if (!nativeSource) {
        setError("Essa fonte não pôde ser preparada pro pipeline nativo — escolhe outra tela/janela.");
        return;
      }
      setSwapping(true);
      try {
        const ok = await swapNativeTransportSource(nativeSource, settingsRef.current?.showCursor ?? true);
        if (!ok) {
          // O main process já parou a captura antiga tentando trocar (ver
          // ipcMain.handle("native-transport:swap-source")) — não dá pra "voltar" pra fonte
          // anterior sem replumbar tudo, então encerra a transmissão de verdade em vez de deixar
          // a UI mostrando "ao vivo" com um pipeline morto por trás.
          setError("Falha ao trocar de fonte no pipeline nativo — a transmissão foi encerrada.");
          await stop();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro ao trocar de fonte.");
        await stop();
      } finally {
        setSwapping(false);
      }
      return;
    }
    if (!sessionRef.current || !settingsRef.current) return;
    setSwapping(true);
    try {
      const { stream, settings: actualSettings, hasAudio, stopAll, onCaptureStats } = await captureScreen(
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
      subscribeCaptureStats(onCaptureStats);

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

  // Ação explícita do usuário (nunca automática — ver docs/INSIGHTS-ENCODER.md #13) pra forçar
  // H.264 quando detectar que o codec preferencial caiu em software pesado. Causa um soluço
  // visual curto pros espectadores (é uma republicação, não um replaceTrack), por isso não roda sozinho.
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

  // Liga/desliga cursor DURANTE a transmissão — só existe pro pipeline nativo (`nativeMode`).
  // Caminho antigo (desktopCapturer) sempre inclui o cursor por conta do próprio SO/DWM, sem
  // toggle possível ao vivo (nem antes disso, na real — só valia o instante em que compartilhava).
  const toggleCursor = useCallback(async () => {
    if (!isNativeTransportModeRef.current) return;
    setInfo((prev) => {
      if (!prev) return prev;
      const next = !prev.cursorEnabled;
      setNativeCursorEnabled(next).catch(() => {});
      return { ...prev, cursorEnabled: next };
    });
  }, []);

  const stop = useCallback(async () => {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    statsIntervalRef.current = null;
    unsubscribeCaptureStatsRef.current?.();
    unsubscribeCaptureStatsRef.current = null;
    unsubscribeNativeEndedRef.current?.();
    unsubscribeNativeEndedRef.current = null;
    unsubscribeNativeErrorRef.current?.();
    unsubscribeNativeErrorRef.current = null;
    unsubscribeNativeStateRef.current?.();
    unsubscribeNativeStateRef.current = null;
    unsubscribeNativeEncoderInfoRef.current?.();
    unsubscribeNativeEncoderInfoRef.current = null;

    if (isNativeTransportModeRef.current) {
      await stopNativeTransport().catch(() => {});
      isNativeTransportModeRef.current = false;
    }

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

  return { state, info, error, start, stop, swapSource, swapping, optimizeCodec, optimizingCodec, toggleCursor };
}
