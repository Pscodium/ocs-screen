import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ConnectionState } from "livekit-client";
import { useRoomStream } from "../hooks/useRoomStream";
import { useNativeStream } from "../hooks/useNativeStream";
import { fetchRoomInfo, roomExists, verifyRoomPassword } from "../services/backend";
import { useRoomPresence } from "../hooks/useRoomPresence";
import { VideoPlayer } from "../components/VideoPlayer";

export function WatchPage() {
  const { roomId } = useParams<{ roomId: string }>();

  const [attempt, setAttempt] = useState(0);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    if (!roomId) return;
    const previous = document.title;
    document.title = `${roomId} • Screen Share`;
    return () => {
      document.title = previous;
    };
  }, [roomId]);

  if (!roomId) return <StatusMessage text="Link inválido." />;
  if (ended)
    return (
      <EndedScreen
        roomId={roomId}
        onBack={() => {
          setEnded(false);
          setAttempt((n) => n + 1);
        }}
      />
    );

  return <WatchRoomGate key={attempt} roomId={roomId} onEnded={() => setEnded(true)} />;
}

const REJOIN_POLL_MS = 5000;

// Transmissão encerrada: fica consultando a sala e reconecta sozinho quando o host voltar no mesmo
// link (comum com o nome de sala lembrado). Só aceita "voltou" depois de ver a sala sumir pelo menos
// uma vez — logo após encerrar a sala ainda pode existir por um instante e reentraria na sala morta.
function EndedScreen({ roomId, onBack }: { roomId: string; onBack: () => void }) {
  useEffect(() => {
    let cancelled = false;
    let seenGone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const exists = await roomExists(roomId);
      if (cancelled) return;
      if (exists === false) seenGone = true;
      else if (exists === true && seenGone) {
        onBack();
        return;
      }
      timer = setTimeout(poll, REJOIN_POLL_MS);
    };
    timer = setTimeout(poll, REJOIN_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return (
    <div className="status-page">
      <div className="ended-screen">
        <p>A transmissão foi encerrada.</p>
        <p className="subtitle">Se o host voltar neste link, a transmissão abre sozinha.</p>
        <Link className="btn-primary" to="/">
          Ver outras transmissões
        </Link>
      </div>
    </div>
  );
}

// Precisa saber `nativeMode` (ver docs/NATIVE_CAPTURE.md Fase 4) ANTES de escolher entre
// useRoomStream (LiveKit) e useNativeStream (RTCPeerConnection cru) — os dois falam protocolos de
// sinalização diferentes, não dá pra tentar um e cair pro outro depois de já ter começado.
function WatchRoomGate({ roomId, onEnded }: { roomId: string; onEnded: () => void }) {
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
    <NativeWatchRoom roomId={roomId} password={password} onEnded={onEnded} />
  ) : (
    <WatchRoom roomId={roomId} password={password} onEnded={onEnded} />
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

function NativeWatchRoom({ roomId, password, onEnded }: { roomId: string; password?: string; onEnded: () => void }) {
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
      roomId={roomId}
      onEnded={onEnded}
    />
  );
}

function WatchRoom({ roomId, password, onEnded }: { roomId: string; password?: string; onEnded: () => void }) {
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
      roomId={roomId}
      onEnded={onEnded}
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
  roomId,
  onEnded,
}: ReturnType<typeof useRoomStream> &
  Partial<Pick<ReturnType<typeof useNativeStream>, "quality" | "setQuality">> & { roomId: string; onEnded: () => void }) {
  const presence = useRoomPresence(roomId);

  useEffect(() => {
    if (phase === "ended") onEnded();
  }, [phase, onEnded]);

  if (phase === "error") return <StatusMessage text={error ?? "Erro ao conectar."} />;
  if (phase === "ended") return null;

  const isReconnecting =
    connectionState === ConnectionState.Reconnecting || connectionState === ConnectionState.SignalReconnecting;

  return (
    <div className="watch-page">
      {phase === "connecting" && <StatusMessage text={error ?? "Conectando à transmissão..."} overlay />}
      {phase === "connected" && isReconnecting && <StatusMessage text="Reconectando..." overlay />}
      <VideoPlayer
        videoRef={videoRef}
        stats={stats}
        hasAudio={hasAudio}
        playoutDelayMs={playoutDelayMs}
        onPlayoutDelayChange={setPlayoutDelayMs}
        quality={quality}
        onQualityChange={setQuality}
        roomId={roomId}
        startedAt={presence.createdAt}
        viewerCount={presence.viewerCount}
      />
    </div>
  );
}

function StatusMessage({ text, overlay }: { text: string; overlay?: boolean }) {
  return <div className={overlay ? "status-overlay" : "status-page"}>{text}</div>;
}
