import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ConnectionState } from "livekit-client";
import { useRoomStream } from "../hooks/useRoomStream";
import { useNativeStream } from "../hooks/useNativeStream";
import { fetchRoomInfo, verifyRoomPassword } from "../services/backend";
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
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [gateError, setGateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRoomInfo(roomId)
      .then((info) => {
        if (cancelled) return;
        setNeedsPassword(info.hasPassword);
        setNativeMode(info.nativeMode);
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
  if (needsPassword && password === undefined) return <PasswordGate roomId={roomId} onUnlock={setPassword} />;
  return nativeMode ? (
    <NativeWatchRoom roomId={roomId} password={password} />
  ) : (
    <WatchRoom roomId={roomId} password={password} />
  );
}

function PasswordGate({ roomId, onUnlock }: { roomId: string; onUnlock: (password: string) => void }) {
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value || checking) return;
    setChecking(true);
    setError(null);
    try {
      if (await verifyRoomPassword(roomId, value)) onUnlock(value);
      else setError("Senha incorreta.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao validar senha.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="status-page">
      <form className="home-card password-gate" onSubmit={submit}>
        <div className="password-gate-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M17 9V7A5 5 0 0 0 7 7v2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2ZM9 7a3 3 0 0 1 6 0v2H9Z" />
          </svg>
        </div>
        <h2>Transmissão protegida</h2>
        <p className="subtitle">
          Digite a senha para assistir <strong>{roomId}</strong>.
        </p>
        <input
          className={`slug-input password-input${error ? " input-error" : ""}`}
          type="password"
          placeholder="Senha"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && <p className="error-text">{error}</p>}
        <button className="btn-primary" type="submit" disabled={!value || checking}>
          {checking ? "Verificando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}

function NativeWatchRoom({ roomId, password }: { roomId: string; password?: string }) {
  const { videoRef, phase, connectionState, error, stats, hasAudio, playoutDelayMs, setPlayoutDelayMs, quality, setQuality } =
    useNativeStream(roomId, password);
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
      quality={quality}
      setQuality={setQuality}
    />
  );
}

function WatchRoom({ roomId, password }: { roomId: string; password?: string }) {
  const { videoRef, phase, connectionState, error, stats, hasAudio, playoutDelayMs, setPlayoutDelayMs } =
    useRoomStream(roomId, password);
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
  quality,
  setQuality,
}: ReturnType<typeof useRoomStream> & Partial<Pick<ReturnType<typeof useNativeStream>, "quality" | "setQuality">>) {

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
        quality={quality}
        onQualityChange={setQuality}
      />
    </div>
  );
}

function StatusMessage({ text, overlay }: { text: string; overlay?: boolean }) {
  return <div className={overlay ? "status-overlay" : "status-page"}>{text}</div>;
}
