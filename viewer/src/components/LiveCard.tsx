import { useState } from "react";
import { ConnectionState } from "livekit-client";
import type { BroadcastInfo } from "../hooks/useBroadcast";
import { isSoftwareEncoder } from "../services/codecs";

interface LiveCardProps {
  info: BroadcastInfo;
  onStop: () => void;
  onOptimizeCodec: () => void;
  optimizingCodec: boolean;
}

// Codecs pesados de codificar por software (AV1/VP9 usam libaom/libvpx) — só esses valem a troca
// forçada pra H.264. H.264 por software (openh264) já é o mais leve que existe.
function isHeavyCodec(codec: string): boolean {
  return codec.toUpperCase() === "AV1" || codec.toUpperCase() === "VP9";
}

const connectionLabel: Record<ConnectionState, string> = {
  [ConnectionState.Connected]: "Ao vivo",
  [ConnectionState.Connecting]: "Conectando...",
  [ConnectionState.Reconnecting]: "Reconectando...",
  [ConnectionState.Disconnected]: "Desconectado",
  [ConnectionState.SignalReconnecting]: "Reconectando...",
};

export function LiveCard({ info, onStop, onOptimizeCodec, optimizingCodec }: LiveCardProps) {
  const [copied, setCopied] = useState(false);
  const isLive = info.connectionState === ConnectionState.Connected;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(info.viewerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão de clipboard — link continua visível no texto pra copiar manualmente.
    }
  };

  return (
    <div className="live-card">
      <div className="live-top-row">
        <div className={`live-badge ${isLive ? "" : "live-badge-warning"}`}>
          <span className={`live-dot ${isLive ? "" : "live-dot-warning"}`} />
          {connectionLabel[info.connectionState]}
        </div>
        <span className="live-viewer-count">
          {info.viewerCount} espectador{info.viewerCount === 1 ? "" : "es"}
        </span>
      </div>

      <button className="live-link-btn" onClick={copyLink} title={info.viewerUrl}>
        <span className="live-link-text">{info.viewerUrl}</span>
        <span className="live-link-copy">{copied ? "Copiado!" : "Copiar"}</span>
      </button>

      <div className="live-stats">
        <span>{info.actualResolution}</span>
        <span>{info.actualFps} FPS</span>
        <span>{info.bitrateKbps > 0 ? `${(info.bitrateKbps / 1000).toFixed(1)} Mbps` : "—"}</span>
        <span>{info.packetLossPercent}% perda</span>
        {info.codec !== "?" && (
          <span title={info.encoderImplementation ? `Encoder: ${info.encoderImplementation}` : undefined}>
            {info.codec.toUpperCase()}
            {info.encoderImplementation && ` (${info.encoderImplementation})`}
          </span>
        )}
        {(isSoftwareEncoder(info.encoderImplementation) || info.hasSoftwareLayer) && (
          <span
            className="live-stats-warning"
            title={[
              isSoftwareEncoder(info.encoderImplementation)
                ? `Codificando por software (${info.encoderImplementation}) — pode pesar a CPU. Confere se "usar aceleração de hardware" tá ligado nas configurações do navegador.`
                : "A camada principal tá em hardware, mas pelo menos uma camada menor do simulcast caiu em software.",
              info.qualityLimitationReason && info.qualityLimitationReason !== "none"
                ? `Motivo reportado pelo navegador: ${info.qualityLimitationReason}.`
                : null,
              info.avgEncodeMs !== null ? `Tempo médio de encode: ${info.avgEncodeMs}ms/frame.` : null,
            ]
              .filter(Boolean)
              .join("\n")}
          >
            ⚠️ CPU
          </span>
        )}
        {isSoftwareEncoder(info.encoderImplementation) && isHeavyCodec(info.codec) && (
          <button
            className="live-optimize-btn"
            onClick={onOptimizeCodec}
            disabled={optimizingCodec}
            title="Trocar pra H.264 agora — mais leve que AV1/VP9 por software. Causa um soluço curto de vídeo pros espectadores."
          >
            {optimizingCodec ? "Otimizando..." : "⚡ Otimizar codec"}
          </button>
        )}
        {info.avgQp !== null && <span title="QP médio — quanto maior, mais comprimido/blocado">QP {info.avgQp}</span>}
        {info.hasAudio && <span>🔊 áudio</span>}
      </div>

      {/* HUD de dev — mesmos campos que hoje só aparecem no tooltip do aviso de CPU, sempre
          visíveis, sem precisar de hover. Só existe em build de dev. */}
      {import.meta.env.DEV && (
        <div className="live-stats-dev">
          <span>Encode médio: {info.avgEncodeMs !== null ? `${info.avgEncodeMs}ms/frame` : "—"}</span>
          <span>Limitação: {info.qualityLimitationReason ?? "—"}</span>
          <span>Camada software: {info.hasSoftwareLayer ? "sim" : "não"}</span>
        </div>
      )}

      <button className="btn-danger" onClick={onStop}>
        Encerrar transmissão
      </button>
    </div>
  );
}
