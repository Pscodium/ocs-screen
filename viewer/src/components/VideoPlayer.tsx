import { useEffect, useState, type RefObject } from "react";
import type { StreamStats } from "../hooks/useRoomStream";
import { PLAYOUT_DELAY_MAX_MS } from "../hooks/useRoomStream";

interface VideoPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  stats: StreamStats | null;
  hasAudio: boolean;
  playoutDelayMs: number;
  onPlayoutDelayChange: (ms: number) => void;
}

export function VideoPlayer({ videoRef, stats, hasAudio, playoutDelayMs, onPlayoutDelayChange }: VideoPlayerProps) {
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

      {stats && (
        <div className="live-quality-badge">
          <span className="live-dot" />
          {stats.resolution} · {stats.fps} FPS
        </div>
      )}

      <div className="video-controls-bar">
        {stats && (
          <button className="pill-btn" onClick={() => setShowDetails((v) => !v)} title="Estatísticas da conexão">
            📊
          </button>
        )}

        {showDetails && stats && (
          <div className="stats-flyout">
            <span>{stats.bitrateKbps > 0 ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps` : "—"}</span>
            <span>{stats.latencyMs}ms buffer</span>
            <span>{stats.packetLossPercent}% perda</span>
          </div>
        )}

        <div className="pill-divider" />

        <div className="pill-popover-group" title={`Suavização: ${playoutDelayMs}ms de buffer extra`}>
          <button className="pill-btn" aria-label="Ajustar suavização">
            🎚️
          </button>
          <div className="pill-flyout pill-flyout-wide">
            <span className="pill-flyout-value">{playoutDelayMs}ms</span>
            <input
              type="range"
              min={0}
              max={PLAYOUT_DELAY_MAX_MS}
              step={25}
              value={playoutDelayMs}
              onChange={(e) => onPlayoutDelayChange(Number(e.target.value))}
              className="pill-slider"
            />
          </div>
        </div>

        <div className="pill-divider" />

        {hasAudio ? (
          <div className="pill-popover-group">
            <button
              className={`pill-btn ${muted ? "btn-unmute-hint" : ""}`}
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? "Ativar som" : "Mudo"}
              title={muted ? "Clique para ativar o som" : "Mudo"}
            >
              {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
            </button>
            <div className="pill-flyout">
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
                className="pill-slider"
              />
            </div>
          </div>
        ) : (
          <span className="pill-btn pill-btn-static" title="O host não está compartilhando áudio">
            🔇
          </span>
        )}

        <div className="pill-divider" />

        <button onClick={toggleFullscreen} className="pill-btn" title="Tela cheia" aria-label="Tela cheia">
          ⛶
        </button>
      </div>
    </div>
  );
}
