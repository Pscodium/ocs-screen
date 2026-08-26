import { useState } from "react";
import { ConnectionState } from "livekit-client";
import type { BroadcastInfo } from "../hooks/useBroadcast";
import { SourcePicker } from "./SourcePicker";
import { isSoftwareEncoder } from "../services/codecs";
import type { CaptureSource } from "../../../preload/index";

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
          {info.nativeMode && (
            <button
              className={`live-swap-btn ${info.cursorEnabled ? "" : "live-swap-btn-off"}`}
              onClick={onToggleCursor}
              title={info.cursorEnabled ? "Esconder cursor" : "Mostrar cursor"}
              aria-label={info.cursorEnabled ? "Esconder cursor" : "Mostrar cursor"}
            >
              {/* Ícone reflete o ESTADO atual (cursor normal = visível, cursor riscado = escondido)
                  — mesmo padrão de botão de mudo (alto-falante vs alto-falante riscado), em vez de
                  só mudar a cor (confuso: não dava pra saber o que o botão representava de fato). */}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true">
                <path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.12 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.12a.5.5 0 0 1-.95.06z" />
                {/* Diagonal OPOSTA à da seta (que já vai de ~4,4 a ~19,19) — na mesma direção a
                    risca ficava paralela ao ícone, quase some por cima dele. */}
                {!info.cursorEnabled && (
                  <line x1="21" y1="3" x2="3" y2="21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                )}
              </svg>
            </button>
          )}
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
          {info.nativeFallbackReason && (
            <span className="live-stats-badge live-stats-badge-warning" title={info.nativeFallbackReason}>
              🐌
            </span>
          )}
          {(isSoftwareEncoder(info.encoderImplementation) || info.hasSoftwareLayer) && (
            <span
              className="live-stats-badge live-stats-badge-warning"
              title={[
                isSoftwareEncoder(info.encoderImplementation)
                  ? `Codificando por software (${info.encoderImplementation}) — pode pesar a CPU. Confere se "usar aceleração de hardware" tá ligado nas configurações do navegador/app.`
                  : `A camada principal tá em hardware, mas pelo menos uma camada menor do simulcast caiu em software.`,
                info.qualityLimitationReason && info.qualityLimitationReason !== "none"
                  ? `Motivo reportado pelo navegador: ${info.qualityLimitationReason}.`
                  : null,
                info.avgEncodeMs !== null ? `Tempo médio de encode: ${info.avgEncodeMs}ms/frame.` : null,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              ⚠️
            </span>
          )}
          {isSoftwareEncoder(info.encoderImplementation) && isHeavyCodec(info.codec) && (
            <button
              className={`live-stats-badge live-stats-optimize ${optimizingCodec ? "live-stats-optimize-spinning" : ""}`}
              onClick={onOptimizeCodec}
              disabled={optimizingCodec}
              title="Trocar pra H.264 agora — mais leve que AV1/VP9 por software. Causa um soluço curto de vídeo pros espectadores."
            >
              ⚡
            </button>
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

      {/* HUD de dev — tudo que hoje só aparece em tooltip (hover), sempre visível, estilo contador
          de FPS de jogo. Só existe em build de dev (`import.meta.env.DEV`); o widget já nasce mais
          alto nesse caso (ver WIDGET_SIZE em main/index.ts) pra sobrar espaço sem cortar nada. */}
      {import.meta.env.DEV && (
        <div className="live-stats-dev">
          <span>Codec: {info.codec}</span>
          <span>Encoder: {info.encoderImplementation ?? "—"}</span>
          <span>Perda: {info.packetLossPercent}%</span>
          <span>QP médio: {info.avgQp ?? "—"}</span>
          <span>Encode médio: {info.avgEncodeMs !== null ? `${info.avgEncodeMs}ms/frame` : "—"}</span>
          <span>Limitação: {info.qualityLimitationReason ?? "—"}</span>
          <span>Camada software: {info.hasSoftwareLayer ? "sim" : "não"}</span>
          <span>FPS de captura nativa: {info.captureFps ?? "— (não é captura nativa)"}</span>
        </div>
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
