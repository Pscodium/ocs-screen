import { useEffect, useState } from "react";
import { ConnectionState } from "livekit-client";
import type { BroadcastInfo } from "../hooks/useBroadcast";
import { SourcePicker } from "./SourcePicker";
import { isSoftwareEncoder } from "../services/codecs";
import type { CaptureSource } from "../../../preload/index";
import { useNow } from "../hooks/useNow";
import { LivePreview } from "./LivePreview";
import { formatDuration, viewersLabel } from "../utils/format";
import {
  AlertIcon,
  BoltIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  CursorIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  StopIcon,
  SwapIcon,
  VolumeIcon,
} from "./Icons";

const PREVIEW_PREF_KEY = "ocs.livePreview";

function readPreviewPref(): boolean {
  try {
    return localStorage.getItem(PREVIEW_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

interface LiveCardProps {
  info: BroadcastInfo;
  swapping: boolean;
  onStop: () => void;
  onSwapSource: (source: CaptureSource) => void;
  onOptimizeCodec: () => void;
  optimizingCodec: boolean;
  onToggleCursor: () => void;
}

// Codecs pesados de codificar por software (AV1/VP9 usam libaom/libvpx, muito mais caros em CPU
// que H.264 por software) — só esses valem a troca forçada pra H.264. H.264 por software
// (openh264) já é o mais leve que existe, forçar de novo não ajudaria em nada.
function isHeavyCodec(codec: string): boolean {
  return codec.toUpperCase() === "AV1" || codec.toUpperCase() === "VP9";
}

// "1920 × 1080" → "1080p" — o widget tem largura fixa (WIDGET_SIZE no main), a resolução exata
// fica no tooltip.
function compactResolution(resolution: string): string {
  const match = resolution.match(/(\d+)\s*×\s*(\d+)/);
  if (!match) return resolution;
  const height = Number(match[2]);
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return `${height}p`;
}

const connectionLabel: Record<ConnectionState, string> = {
  [ConnectionState.Connected]: "Ao vivo",
  [ConnectionState.Connecting]: "Conectando",
  [ConnectionState.Reconnecting]: "Reconectando",
  [ConnectionState.Disconnected]: "Desconectado",
  [ConnectionState.SignalReconnecting]: "Reconectando",
};

// Widget "ao vivo" — janela pequena sempre no topo (tamanho fixo, ver WIDGET_SIZE no main process).
// Tudo que importa de relance (estado, tempo, espectadores, link) fica visível; diagnóstico fino
// (encoder, QP, motivo de fallback) vai pro tooltip dos avisos.
export function LiveCard({
  info,
  swapping,
  onStop,
  onSwapSource,
  onOptimizeCodec,
  optimizingCodec,
  onToggleCursor,
}: LiveCardProps) {
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Card monta quando a transmissão entra no ar (e continua montado na troca de fonte) — serve de
  // início pro contador de duração.
  const [startedAt] = useState(() => Date.now());
  const now = useNow();
  const isLive = info.connectionState === ConnectionState.Connected;
  // Preview só existe no pipeline nativo (miniatura da textura de captura, ver LivePreview).
  const [previewOn, setPreviewOn] = useState(readPreviewPref);
  const showPreview = previewOn && info.nativeMode;

  // A janela do widget cresce/encolhe com o preview (main `window:set-widget-preview`).
  useEffect(() => {
    window.screenshare.window.setWidgetPreview(showPreview);
  }, [showPreview]);
  useEffect(() => () => window.screenshare.window.setWidgetPreview(false), []);

  const togglePreview = () => {
    const next = !previewOn;
    setPreviewOn(next);
    try {
      localStorage.setItem(PREVIEW_PREF_KEY, next ? "1" : "0");
    } catch {
      // Sem storage — vale só até fechar o app.
    }
  };

  const copyLink = async () => {
    try {
      await window.screenshare.clipboard.writeText(info.viewerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard pode falhar sem foco na janela — usuário ainda vê o link no texto.
    }
  };

  const softwareEncoding = isSoftwareEncoder(info.encoderImplementation) || info.hasSoftwareLayer;
  const encoderWarning = softwareEncoding
    ? [
        isSoftwareEncoder(info.encoderImplementation)
          ? `Codificando por software (${info.encoderImplementation}) — pode pesar a CPU.`
          : "A camada principal tá em hardware, mas pelo menos uma camada menor do simulcast caiu em software.",
        info.qualityLimitationReason && info.qualityLimitationReason !== "none"
          ? `Motivo reportado: ${info.qualityLimitationReason}.`
          : null,
        info.avgEncodeMs !== null ? `Tempo médio de encode: ${info.avgEncodeMs}ms/frame.` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const codecLabel = info.codec !== "?" ? info.codec.toUpperCase() : "—";
  const stats: { label: string; value: string; title?: string }[] = [
    { label: "Resolução", value: compactResolution(info.actualResolution), title: info.actualResolution },
    { label: "FPS", value: info.actualFps > 0 ? String(info.actualFps) : "—" },
    { label: "Bitrate", value: info.bitrateKbps > 0 ? `${(info.bitrateKbps / 1000).toFixed(1)}M` : "—", title: "Mbps enviados" },
    {
      label: "Codec",
      value: codecLabel,
      title: [
        info.encoderImplementation ? `Encoder: ${info.encoderImplementation}` : null,
        info.avgQp !== null ? `QP médio: ${info.avgQp}` : null,
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    },
  ];

  return (
    <div className="live-card">
      <div className="live-head">
        <span className={`live-pill ${isLive ? "" : "live-pill-warning"}`}>
          <span className="live-dot" />
          {connectionLabel[info.connectionState]}
        </span>
        <span className="live-timer" title="Tempo no ar">
          <ClockIcon size={13} />
          {formatDuration(now - startedAt)}
        </span>
        <div className="live-actions">
          {info.nativeMode && (
            <button
              className={`icon-btn ${previewOn ? "icon-btn-active" : ""}`}
              onClick={togglePreview}
              title={previewOn ? "Esconder preview" : "Mostrar preview da transmissão"}
              aria-label={previewOn ? "Esconder preview" : "Mostrar preview da transmissão"}
              aria-pressed={previewOn}
            >
              {previewOn ? <EyeIcon size={15} /> : <EyeOffIcon size={15} />}
            </button>
          )}
          {info.nativeMode && (
            <button
              className={`icon-btn ${info.cursorEnabled ? "" : "icon-btn-off"}`}
              onClick={onToggleCursor}
              title={info.cursorEnabled ? "Esconder cursor" : "Mostrar cursor"}
              aria-label={info.cursorEnabled ? "Esconder cursor" : "Mostrar cursor"}
            >
              <CursorIcon size={15} off={!info.cursorEnabled} />
            </button>
          )}
          <button
            className={`icon-btn ${swapping ? "icon-btn-spinning" : ""}`}
            onClick={() => setPickerOpen(true)}
            disabled={swapping}
            title="Trocar tela/janela"
            aria-label="Trocar tela/janela"
          >
            <SwapIcon size={15} />
          </button>
          <button className="live-stop" onClick={onStop} title="Encerrar transmissão">
            <StopIcon size={13} />
            Encerrar
          </button>
        </div>
      </div>

      <div className="live-room">
        <span className="live-room-name" title={info.roomId}>
          {info.roomId}
        </span>
        <span className="live-room-chips">
          {info.hasPassword && (
            <span className="chip" title="Protegida por senha — mande a senha junto com o link.">
              <LockIcon size={11} />
              Senha
            </span>
          )}
          {info.isPrivate && (
            <span className="chip" title="Sala privada — não aparece na lista, só entra quem tem o link.">
              <EyeOffIcon size={11} />
              Privada
            </span>
          )}
          {info.hasAudio && (
            <span className="chip" title="Áudio da transmissão ativo">
              <VolumeIcon size={11} level="high" />
              Áudio
            </span>
          )}
        </span>
      </div>

      <div className="live-link">
        <span className="live-link-text" title={info.viewerUrl}>
          {info.viewerUrl.replace(/^https?:\/\//, "")}
        </span>
        <button className={`live-link-copy ${copied ? "live-link-copied" : ""}`} onClick={copyLink}>
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>

      {info.captureWarning && (
        <div className="live-warning" role="alert">
          <AlertIcon size={13} />
          <span>{info.captureWarning}</span>
        </div>
      )}

      {showPreview && <LivePreview onExpand={() => window.screenshare.viewer.open(info.viewerUrl)} />}

      <div className="live-stats">
        {stats.map((s) => (
          <div key={s.label} className="live-stat" title={s.title}>
            <span className="live-stat-value">{s.value}</span>
            <span className="live-stat-label">{s.label}</span>
          </div>
        ))}
      </div>

      <div className="live-foot">
        <span className="live-viewers" title="Espectadores conectados">
          <EyeIcon size={13} />
          {viewersLabel(info.viewerCount)}
        </span>
        <span className="live-foot-right">
          {info.packetLossPercent > 0 && (
            <span className={info.packetLossPercent >= 2 ? "live-foot-warning" : ""} title="Perda de pacotes">
              {info.packetLossPercent}% perda
            </span>
          )}
          {info.nativeFallbackReason && (
            <span className="live-foot-warning" title={info.nativeFallbackReason}>
              <AlertIcon size={12} />
              Modo compatível
            </span>
          )}
          {encoderWarning && (
            <span className="live-foot-warning" title={encoderWarning}>
              <AlertIcon size={12} />
              CPU
            </span>
          )}
          {isSoftwareEncoder(info.encoderImplementation) && isHeavyCodec(info.codec) && (
            <button
              className="live-optimize"
              onClick={onOptimizeCodec}
              disabled={optimizingCodec}
              title="Trocar pra H.264 agora — mais leve que AV1/VP9 por software. Causa um soluço curto de vídeo pros espectadores."
            >
              <BoltIcon size={12} />
              {optimizingCodec ? "Otimizando" : "Otimizar"}
            </button>
          )}
        </span>
      </div>

      {/* Diagnóstico de dev — o que em produção só aparece em tooltip, sempre visível. Só existe em
          build de dev (`import.meta.env.DEV`); o widget já nasce mais alto nesse caso. */}
      {import.meta.env.DEV && (
        <dl className="live-diag">
          <div>
            <dt>Encoder</dt>
            <dd>{info.encoderImplementation ?? "—"}</dd>
          </div>
          <div>
            <dt>QP</dt>
            <dd>{info.avgQp ?? "—"}</dd>
          </div>
          <div>
            <dt>Encode</dt>
            <dd>{info.avgEncodeMs !== null ? `${info.avgEncodeMs}ms` : "—"}</dd>
          </div>
          <div>
            <dt>Captura</dt>
            <dd>{info.captureFps !== null ? `${info.captureFps} fps` : "—"}</dd>
          </div>
          <div>
            <dt>Perda</dt>
            <dd>{info.packetLossPercent}%</dd>
          </div>
          <div>
            <dt>Limitação</dt>
            <dd>{info.qualityLimitationReason ?? "—"}</dd>
          </div>
          <div>
            <dt>SW layer</dt>
            <dd>{info.hasSoftwareLayer ? "sim" : "não"}</dd>
          </div>
        </dl>
      )}

      {pickerOpen && (
        <SourcePicker
          onCancel={() => setPickerOpen(false)}
          onSelect={(source) => {
            setPickerOpen(false);
            onSwapSource(source);
          }}
        />
      )}
    </div>
  );
}
