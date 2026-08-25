import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ConnectionState } from "livekit-client";
import { useRoomStream } from "../hooks/useRoomStream";
import { useNativeStream } from "../hooks/useNativeStream";
import { fetchRoomInfo } from "../services/backend";
import { VideoPlayer } from "../components/VideoPlayer";

export function WatchPage() {
  const { roomId } = useParams<{ roomId: string }>();

  if (!roomId) return <StatusMessage text="Link inválido." />;

  return <WatchRoomGate roomId={roomId} />;
}

// Precisa saber `nativeMode` (ver docs/NATIVE_CAPTURE.md Fase 4) ANTES de escolher entre
// useRoomStream (LiveKit) e useNativeStream (RTCPeerConnection cru) — os dois falam protocolos de
// sinalização diferentes, não dá pra tentar um e cair pro outro depois de já ter começado.
function WatchRoomGate({ roomId }: { roomId: string }) {
  const [nativeMode, setNativeMode] = useState<boolean | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRoomInfo(roomId)
      .then((info) => {
        if (!cancelled) setNativeMode(info.nativeMode);
      })
      .catch((err) => {
        if (!cancelled) setGateError(err instanceof Error ? err.message : "Erro ao conectar.");
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (gateError) return <StatusMessage text={gateError} />;
  if (nativeMode === null) return <StatusMessage text="Conectando à transmissão..." overlay />;
  return nativeMode ? <NativeWatchRoom roomId={roomId} /> : <WatchRoom roomId={roomId} />;
}

function NativeWatchRoom({ roomId }: { roomId: string }) {
  const { videoRef, phase, connectionState, error, stats, hasAudio, playoutDelayMs, setPlayoutDelayMs } =
    useNativeStream(roomId);
  return (
    <WatchRoomView
      phase={phase}
      connectionState={connectionState}
      error={error}
      videoRef={videoRef}
      stats={stats}
      hasAudio={hasAudio}
      playoutDelayMs={playoutDelayMs}
      setPlayoutDelayMs={setPlayoutDelayMs}
    />
  );
}

function WatchRoom({ roomId }: { roomId: string }) {
  const { videoRef, phase, connectionState, error, stats, hasAudio, playoutDelayMs, setPlayoutDelayMs } =
    useRoomStream(roomId);
  return (
    <WatchRoomView
      phase={phase}
      connectionState={connectionState}
      error={error}
      videoRef={videoRef}
      stats={stats}
      hasAudio={hasAudio}
      playoutDelayMs={playoutDelayMs}
      setPlayoutDelayMs={setPlayoutDelayMs}
    />
  );
}

function WatchRoomView({
  phase,
  connectionState,
  error,
  videoRef,
  stats,
  hasAudio,
  playoutDelayMs,
  setPlayoutDelayMs,
}: ReturnType<typeof useRoomStream>) {

  if (phase === "error") return <StatusMessage text={error ?? "Erro ao conectar."} />;
  if (phase === "ended") return <StatusMessage text="A transmissão foi encerrada." />;

  const isReconnecting =
    connectionState === ConnectionState.Reconnecting || connectionState === ConnectionState.SignalReconnecting;

  return (
    <div className="watch-page">
      {phase === "connecting" && <StatusMessage text="Conectando à transmissão..." overlay />}
      {phase === "connected" && isReconnecting && <StatusMessage text="Reconectando..." overlay />}
      <VideoPlayer
        videoRef={videoRef}
        stats={stats}
        hasAudio={hasAudio}
        playoutDelayMs={playoutDelayMs}
        onPlayoutDelayChange={setPlayoutDelayMs}
      />
    </div>
  );
}

function StatusMessage({ text, overlay }: { text: string; overlay?: boolean }) {
  return <div className={overlay ? "status-overlay" : "status-page"}>{text}</div>;
}
