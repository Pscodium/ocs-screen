import { useEffect, useRef, useState, type RefObject } from "react";
import type { StreamStats } from "../hooks/useRoomStream";
import { PLAYOUT_DELAY_MAX_MS } from "../hooks/useRoomStream";
import { useNow } from "../hooks/useNow";
import { formatDuration } from "../utils/format";
import { EyeIcon, FullscreenIcon, QualityIcon, SlidersIcon, StatsIcon, VolumeIcon } from "./Icons";

interface VideoPlayerProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  stats: StreamStats | null;
  hasAudio: boolean;
  playoutDelayMs: number;
  onPlayoutDelayChange: (ms: number) => void;
  // Simulcast (Sprint 27, ver docs/NATIVE_CAPTURE.md Fase 4 "Simulcast") — só existe no caminho
  // nativo (`useNativeStream`), LiveKit não passa esses props (seletor de qualidade fica ausente
  // nesse caminho, não é um erro). Seleção manual nessa v1, sem medição automática de rede.
  quality?: "high" | "low";
  onQualityChange?: (tier: "high" | "low") => void;
  roomId: string;
  // Início da sala (backend) — base do contador de tempo ao vivo.
  startedAt: number | null;
  viewerCount: number | null;
}

const HIDE_DELAY_MS = 2200;

export function VideoPlayer({
  videoRef,
  stats,
  hasAudio,
  playoutDelayMs,
  onPlayoutDelayChange,
  quality,
  onQualityChange,
  roomId,
  startedAt,
  viewerCount,
}: VideoPlayerProps) {
  const now = useNow();
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const [containerRef, setContainerRef] = useState<HTMLDivElement | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [volume, setVolume] = useState(0);
  // Começa mudo de propósito: o navegador bloqueia autoplay com som sem gesto do usuário —
  // começar já "desmutado" mostra 🔊 mas não toca nada até alguma interação, o que confunde
  // (parece bug). Começando mudo, o ícone reflete o estado real e o clique no botão desmuta
  // com um gesto direto e confiável.
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

  // Safari no iPhone não implementa a Fullscreen API padrão em containers/divs (só no iPad) —
  // tenta o caminho padrão primeiro (funciona em desktop e Android) e cai pro fullscreen nativo
  // do próprio <video> (`webkitEnterFullscreen`, específico de WebKit) quando aquele falhar.
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }

    if (containerRef?.requestFullscreen) {
      containerRef.requestFullscreen().catch(() => {
        videoRef.current?.webkitEnterFullscreen?.();
      });
    } else {
      videoRef.current?.webkitEnterFullscreen?.();
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

      <div className={`video-top-bar ${controlsVisible ? "" : "video-controls-hidden"}`}>
        <span className="video-room-name">{roomId}</span>
        {stats && (
          <span className="video-quality-tag">
            {stats.resolution} · {stats.fps} FPS
          </span>
        )}
      </div>

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
        <div className="video-controls-info">
          <span className="video-live-tag">AO VIVO</span>
          {startedAt !== null && (
            <span className="video-info-item" title="Tempo no ar">
              {formatDuration(now - startedAt)}
            </span>
          )}
          {viewerCount !== null && (
            <span className="video-info-item" title="Espectadores">
              <EyeIcon size={15} />
              {viewerCount}
            </span>
          )}
        </div>

        <div className="video-controls-actions">
          {stats && (
            <div className="ctrl-group">
              <button
                className={`ctrl-btn ${showDetails ? "ctrl-btn-active" : ""}`}
                onClick={() => setShowDetails((v) => !v)}
                aria-label="Estatísticas da conexão"
                title="Estatísticas"
              >
                <StatsIcon size={18} />
              </button>
              {showDetails && (
                <div className="ctrl-popover ctrl-popover-open ctrl-stats">
                  <span>Resolução</span>
                  <strong>{stats.resolution}</strong>
                  <span>FPS</span>
                  <strong>{stats.fps}</strong>
                  <span>Bitrate</span>
                  <strong>{stats.bitrateKbps > 0 ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps` : "—"}</strong>
                  <span>Buffer</span>
                  <strong>{stats.latencyMs} ms</strong>
                  <span>Perda</span>
                  <strong>{stats.packetLossPercent}%</strong>
                </div>
              )}
            </div>
          )}

          <div className="ctrl-group">
            <button className="ctrl-btn" aria-label="Ajustar suavização" title="Suavização">
              <SlidersIcon size={18} />
            </button>
            <div className="ctrl-popover">
              <span className="ctrl-popover-title">
                Suavização <strong>{playoutDelayMs} ms</strong>
              </span>
              <input
                type="range"
                min={0}
                max={PLAYOUT_DELAY_MAX_MS}
                step={25}
                value={playoutDelayMs}
                onChange={(e) => onPlayoutDelayChange(Number(e.target.value))}
                className="ctrl-slider"
              />
              <span className="ctrl-popover-hint">Mais buffer = menos travadas, mais atraso.</span>
            </div>
          </div>

          {onQualityChange && (
            <div className="ctrl-group">
              <button className="ctrl-btn" aria-label="Qualidade" title="Qualidade">
                <QualityIcon size={18} />
              </button>
              <div className="ctrl-popover ctrl-menu">
                <span className="ctrl-popover-title">Qualidade</span>
                {(["high", "low"] as const).map((tier) => (
                  <button
                    key={tier}
                    className={`ctrl-menu-option ${quality === tier ? "ctrl-menu-option-active" : ""}`}
                    onClick={() => onQualityChange(tier)}
                  >
                    {tier === "high" ? "Alta" : "Baixa (economiza dados)"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasAudio ? (
            <div className="ctrl-group ctrl-volume">
              <button
                className={`ctrl-btn ${muted ? "btn-unmute-hint" : ""}`}
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? "Ativar som" : "Mudo"}
                title={muted ? "Clique para ativar o som" : "Mudo"}
              >
                <VolumeIcon size={18} level={muted || volume === 0 ? "off" : volume < 0.5 ? "low" : "high"} />
              </button>
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
                className="ctrl-slider ctrl-volume-slider"
                aria-label="Volume"
              />
            </div>
          ) : (
            <span className="ctrl-btn ctrl-btn-static" title="O host não está compartilhando áudio">
              <VolumeIcon size={18} level="off" />
            </span>
          )}

          <button
            onClick={toggleFullscreen}
            className="ctrl-btn"
            title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
            aria-label="Tela cheia"
          >
            <FullscreenIcon size={18} exit={isFullscreen} />
          </button>
        </div>
      </div>
    </div>
  );
}
