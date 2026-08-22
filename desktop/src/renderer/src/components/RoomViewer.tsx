import { useEffect } from "react";
import { useRoomViewer } from "../hooks/useRoomViewer";
import { VideoPlayer } from "./VideoPlayer";

interface RoomViewerProps {
  roomId: string;
  onBack: () => void;
}

export function RoomViewer({ roomId, onBack }: RoomViewerProps) {
  const { videoRef, phase, error, stats, hasAudio, playoutDelayMs, setPlayoutDelayMs } = useRoomViewer(roomId);

  useEffect(() => {
    window.screenshare.window.setWatchMode(true);
    return () => window.screenshare.window.setWatchMode(false);
  }, []);

  return (
    <div className="room-viewer">
      <div className="room-viewer-topbar">
        <button className="room-viewer-back" onClick={onBack} aria-label="Voltar">
          ←
        </button>
        <span className="room-viewer-title">{roomId}</span>
      </div>

      <div className="room-viewer-stage">
        {phase === "connecting" && <p className="subtitle">Conectando...</p>}
        {phase === "error" && <p className="error-text">{error}</p>}
        {phase === "ended" && <p className="subtitle">A transmissão foi encerrada.</p>}

        {(phase === "connected" || phase === "connecting") && (
          <VideoPlayer
            videoRef={videoRef}
            stats={stats}
            hasAudio={hasAudio}
            playoutDelayMs={playoutDelayMs}
            onPlayoutDelayChange={setPlayoutDelayMs}
          />
        )}
      </div>
    </div>
  );
}
