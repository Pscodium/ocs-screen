import { useEffect, useState, type RefObject } from "react";
import type { StreamStats } from "../hooks/useRoomStream";

interface VideoPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  stats: StreamStats | null;
  hasAudio: boolean;
}

export function VideoPlayer({ videoRef, stats, hasAudio }: VideoPlayerProps) {
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [volume, setVolume] = useState(1);
  // Começa mudo de propósito: o navegador bloqueia autoplay com som sem gesto do usuário —
  // começar já "desmutado" mostra 🔊 mas não toca nada até alguma interação, o que confunde
  // (parece bug). Começando mudo, o ícone reflete o estado real e o clique no botão desmuta
  // com um gesto direto e confiável.
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = muted;
    }
  }, [videoRef, volume, muted]);

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
      <video
        ref={videoRef as RefObject<HTMLVideoElement>}
        autoPlay
        playsInline
        muted
        className="video-element"
      />
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
        {hasAudio ? (
          <div className="volume-control">
            <button
              className={`volume-icon-btn ${muted ? "btn-unmute-hint" : ""}`}
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? "Ativar som" : "Mudo"}
              title={muted ? "Clique para ativar o som" : "Mudo"}
            >
              {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
            </button>
            <div className="volume-flyout">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setVolume(next);
                  setMuted(next === 0);
                }}
                className="volume-slider"
              />
            </div>
          </div>
        ) : (
          <span className="video-stats" title="O host não está compartilhando áudio">
            🔇 sem áudio
          </span>
        )}
        <button onClick={toggleFullscreen} className="btn-fullscreen">
          Tela cheia
        </button>
      </div>
    </div>
  );
}
