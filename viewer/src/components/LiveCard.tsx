import { useState } from "react";
import { ConnectionState } from "livekit-client";
import type { BroadcastInfo } from "../hooks/useBroadcast";
import { isSoftwareEncoder } from "../services/codecs";
import { useNow } from "../hooks/useNow";
import { formatDuration, viewersLabel } from "../utils/format";
import { CheckIcon, ClockIcon, CopyIcon, EyeIcon } from "./Icons";

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

// VP9 por software é a escolha padrão do web pra movimento (ver services/codecs.ts) — encoder de
// software sozinho não é problema. Só avisa/oferece H.264 quando o navegador diz que a CPU tá
// limitando de verdade; senão o aviso ficaria sempre ligado e empurraria o host pro H.264, que
// congela com movimento no navegador.
function isCpuLimited(info: BroadcastInfo): boolean {
  return info.qualityLimitationReason === "cpu";
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
  // Card monta quando a transmissão entra no ar — serve de início pro contador de duração.
  const [startedAt] = useState(() => Date.now());
  const now = useNow();
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

  const stats: { label: string; value: string; title?: string }[] = [
    { label: "Resolução", value: info.actualResolution },
    { label: "FPS", value: String(info.actualFps) },
    { label: "Bitrate", value: info.bitrateKbps > 0 ? `${(info.bitrateKbps / 1000).toFixed(1)} Mbps` : "—" },
    { label: "Perda", value: `${info.packetLossPercent}%` },
    {
      label: "Codec",
      value: info.codec !== "?" ? info.codec.toUpperCase() : "—",
      title: info.encoderImplementation ? `Encoder: ${info.encoderImplementation}` : undefined,
    },
  ];

  return (
    <section className="home-card live-card">
      <div className="live-top-row">
        <div className={`live-badge ${isLive ? "" : "live-badge-warning"}`}>
          <span className={`live-dot ${isLive ? "" : "live-dot-warning"}`} />
          {connectionLabel[info.connectionState]}
        </div>
        <span className="live-room-name">{info.roomId}</span>
        <span className="live-meta">
          <span title="Tempo no ar">
            <ClockIcon size={14} />
            {formatDuration(now - startedAt)}
          </span>
          <span title="Espectadores">
            <EyeIcon size={14} />
            {viewersLabel(info.viewerCount)}
          </span>
        </span>
      </div>

      <div className="live-link-row">
        <span className="live-link-text" title={info.viewerUrl}>
          {info.viewerUrl}
        </span>
        <button className={`live-link-copy ${copied ? "live-link-copied" : ""}`} onClick={copyLink}>
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          {copied ? "Copiado" : "Copiar link"}
        </button>
      </div>

      <div className="live-stats">
        {stats.map((s) => (
          <div key={s.label} className="live-stat" title={s.title}>
            <span className="live-stat-value">{s.value}</span>
            <span className="live-stat-label">{s.label}</span>
          </div>
        ))}
      </div>

      {(isCpuLimited(info) || info.avgQp !== null || info.hasAudio) && (
        <div className="live-extra">
          {info.hasAudio && <span>Áudio do sistema ativo</span>}
          {info.avgQp !== null && <span title="QP médio — quanto maior, mais comprimido/blocado">QP {info.avgQp}</span>}
          {isCpuLimited(info) && (
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
              ⚠️ CPU limitando
            </span>
          )}
          {isCpuLimited(info) && isSoftwareEncoder(info.encoderImplementation) && isHeavyCodec(info.codec) && (
            <button
              className="live-optimize-btn"
              onClick={onOptimizeCodec}
              disabled={optimizingCodec}
              title="Trocar pra H.264 agora — mais leve que AV1/VP9 por software. Causa um soluço curto de vídeo pros espectadores."
            >
              {optimizingCodec ? "Otimizando..." : "⚡ Otimizar codec"}
            </button>
          )}
        </div>
      )}

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
    </section>
  );
}
