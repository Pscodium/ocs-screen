import { useState } from "react";
import { ConnectionState } from "livekit-client";
import type { BroadcastInfo } from "../hooks/useBroadcast";
import { SourcePicker } from "./SourcePicker";
import type { CaptureSource } from "../../../preload/index";

interface LiveCardProps {
  info: BroadcastInfo;
  swapping: boolean;
  onStop: () => void;
  onSwapSource: (source: CaptureSource) => void;
}

// Nomes de encoder por software que os browsers reportam em `encoderImplementation` — o resto
// (ex.: "ExternalEncoder", nomes de vendor) é hardware. Usado só pra avisar o usuário que a
// transmissão pode estar pesando mais CPU do que deveria (ver docs/INSIGHTS-ENCODER.md #2).
function isSoftwareEncoder(name: string | null): boolean {
  if (!name) return false;
  return /libvpx|libaom|openh264|libx264/i.test(name);
}

// Widget "ao vivo" é uma janela pequena de tamanho fixo (340×140, não redimensionável) — não tem
// espaço pra uma linha de estatísticas cheia de spans soltos (resolução, fps, bitrate, perda,
// codec, QP, aviso de CPU, áudio já eram 8 itens). Resolução+fps viram um rótulo só, e o que é
// só diagnóstico (perda de pacote/codec/encoder/QP) vira tooltip de um ícone único.
function compactResolution(resolution: string): string {
  const match = resolution.match(/(\d+)\s*×\s*(\d+)/);
  if (!match) return resolution;
  const height = Number(match[2]);
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  return resolution;
}

const connectionLabel: Record<ConnectionState, string> = {
  [ConnectionState.Connected]: "Ao vivo",
  [ConnectionState.Connecting]: "Conectando...",
  [ConnectionState.Reconnecting]: "Reconectando...",
  [ConnectionState.Disconnected]: "Desconectado",
  [ConnectionState.SignalReconnecting]: "Reconectando...",
};

export function LiveCard({ info, swapping, onStop, onSwapSource }: LiveCardProps) {
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const isLive = info.connectionState === ConnectionState.Connected;

  const copyLink = async () => {
    try {
      await window.screenshare.clipboard.writeText(info.viewerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard pode falhar sem foco na janela — usuário ainda vê o link no texto.
    }
  };

  return (
    <div className="live-card">
      <div className="live-top-row">
        <div className={`live-badge ${isLive ? "" : "live-badge-warning"}`}>
          <span className={`live-dot ${isLive ? "" : "live-dot-warning"}`} />
          {connectionLabel[info.connectionState]}
          <span className="live-viewer-count">
            · {info.viewerCount} espectador{info.viewerCount === 1 ? "" : "es"}
          </span>
        </div>
        <div className="live-top-actions">
          <button
            className={`live-swap-btn ${swapping ? "live-swap-btn-spinning" : ""}`}
            onClick={() => setPickerOpen(true)}
            disabled={swapping}
            title="Trocar tela/janela"
            aria-label="Trocar tela/janela"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L14 11h7V4l-3.35 2.35z" />
            </svg>
          </button>
          <button
            className="live-stop-btn"
            onClick={onStop}
            title="Encerrar transmissão"
            aria-label="Encerrar transmissão"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08C.11 12.91 0 12.66 0 12.38c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
          </button>
        </div>
      </div>

      <button className="live-link-btn" onClick={copyLink} title={info.viewerUrl}>
        <span className="live-link-text">{info.viewerUrl}</span>
        <span className="live-link-copy">{copied ? "Copiado!" : "Copiar"}</span>
      </button>

      <div className="live-stats">
        <span className="live-stats-primary">
          {compactResolution(info.actualResolution)} · {info.actualFps}fps ·{" "}
          {info.bitrateKbps > 0 ? `${(info.bitrateKbps / 1000).toFixed(1)} Mbps` : "—"}
        </span>
        <span className="live-stats-icons">
          {isSoftwareEncoder(info.encoderImplementation) && (
            <span
              className="live-stats-badge live-stats-badge-warning"
              title={`Codificando por software (${info.encoderImplementation}) — pode pesar a CPU. Sem encoder de hardware disponível pra esse codec nesse PC.`}
            >
              ⚠️
            </span>
          )}
          {info.codec !== "?" && (
            <span
              className="live-stats-badge"
              title={[
                `Codec: ${info.codec.toUpperCase()}${info.encoderImplementation ? ` (${info.encoderImplementation})` : ""}`,
                `Perda de pacote: ${info.packetLossPercent}%`,
                info.avgQp !== null ? `QP médio: ${info.avgQp}` : null,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              ⓘ
            </span>
          )}
          {info.hasAudio && <span className="live-stats-badge">🔊</span>}
        </span>
      </div>

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
