import { useState, type RefObject } from "react";
import type { StreamStats } from "../hooks/useRoomStream";

interface VideoPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  stats: StreamStats | null;
}

export function VideoPlayer({ videoRef, stats }: VideoPlayerProps) {
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const toggleFullscreen = () => {
    if (!containerRef) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.requestFullscreen();
    }
  };

  return (
    <div className="video-container" ref={setContainerRef}>
      <video ref={videoRef as RefObject<HTMLVideoElement>} autoPlay playsInline className="video-element" />
      <div className="video-controls">
        {stats && (
          <button className="video-stats" onClick={() => setShowDetails((v) => !v)}>
            {stats.resolution} • {stats.fps} FPS
            {showDetails && (
              <>
                {" "}
                • {stats.bitrateKbps > 0 ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps` : "—"} • {stats.latencyMs}
                ms • {stats.packetLossPercent}% perda
              </>
            )}
          </button>
        )}
        <button onClick={toggleFullscreen} className="btn-fullscreen">
          Tela cheia
        </button>
      </div>
    </div>
  );
}
