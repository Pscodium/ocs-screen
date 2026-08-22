import { useEffect, useRef, useState, type RefObject } from "react";
import type { ViewerStats } from "../hooks/useRoomViewer";
import { PLAYOUT_DELAY_MAX_MS } from "../hooks/useRoomViewer";

interface VideoPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  stats: ViewerStats | null;
  hasAudio: boolean;
  playoutDelayMs: number;
  onPlayoutDelayChange: (ms: number) => void;
}

const HIDE_DELAY_MS = 2200;

export function VideoPlayer({ videoRef, stats, hasAudio, playoutDelayMs, onPlayoutDelayChange }: VideoPlayerProps) {
  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [volume, setVolume] = useState(1);
  // Começa mudo de propósito: definir só via prop/atributo JSX não é confiável (o elemento pode
  // já ter recebido a track antes do primeiro render aplicar o atributo) — força via DOM direto.
  const [muted, setMuted] = useState(true);

  // Some sozinho depois de parado — não dá pra usar só ":hover" no container inteiro, porque o
  // vídeo ocupa a tela toda e o mouse quase sempre tá "dentro" dele. Em vez disso, some por
  // inatividade e volta ao mexer o mouse; fica sempre visível enquanto o cursor tá em cima da
  // própria barra (não pode sumir no meio de um ajuste de slider).
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveringBarRef = useRef(false);

  const scheduleHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!hoveringBarRef.current) setControlsVisible(false);
    }, HIDE_DELAY_MS);
  };

  useEffect(() => {
    scheduleHide();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div
      className={`video-container ${controlsVisible ? "" : "video-cursor-hidden"}`}
      ref={setContainerRef}
      onMouseMove={() => {
        setControlsVisible(true);
        scheduleHide();
      }}
    >
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

      <div
        className={`video-controls-bar ${controlsVisible ? "" : "video-controls-hidden"}`}
        onMouseEnter={() => {
          hoveringBarRef.current = true;
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        }}
        onMouseLeave={() => {
          hoveringBarRef.current = false;
          scheduleHide();
        }}
      >
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
