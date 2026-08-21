import { useParams } from "react-router-dom";
import { ConnectionState } from "livekit-client";
import { useRoomStream } from "../hooks/useRoomStream";
import { VideoPlayer } from "../components/VideoPlayer";

export function WatchPage() {
  const { roomId } = useParams<{ roomId: string }>();

  if (!roomId) return <StatusMessage text="Link inválido." />;

  return <WatchRoom roomId={roomId} />;
}

function WatchRoom({ roomId }: { roomId: string }) {
  const { videoRef, phase, connectionState, error, stats } = useRoomStream(roomId);

  if (phase === "error") return <StatusMessage text={error ?? "Erro ao conectar."} />;
  if (phase === "ended") return <StatusMessage text="A transmissão foi encerrada." />;

  const isReconnecting =
    connectionState === ConnectionState.Reconnecting || connectionState === ConnectionState.SignalReconnecting;

  return (
    <div className="watch-page">
      {phase === "connecting" && <StatusMessage text="Conectando à transmissão..." overlay />}
      {phase === "connected" && isReconnecting && <StatusMessage text="Reconectando..." overlay />}
      <VideoPlayer videoRef={videoRef} stats={stats} />
    </div>
  );
}

function StatusMessage({ text, overlay }: { text: string; overlay?: boolean }) {
  return <div className={overlay ? "status-overlay" : "status-page"}>{text}</div>;
}
