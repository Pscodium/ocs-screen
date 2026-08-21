import { useState } from "react";
import { ConnectionState } from "livekit-client";
import type { BroadcastInfo } from "../hooks/useBroadcast";

interface LiveCardProps {
  info: BroadcastInfo;
  onStop: () => void;
}

const connectionLabel: Record<ConnectionState, string> = {
  [ConnectionState.Connected]: "Ao vivo",
  [ConnectionState.Connecting]: "Conectando...",
  [ConnectionState.Reconnecting]: "Reconectando...",
  [ConnectionState.Disconnected]: "Desconectado",
  [ConnectionState.SignalReconnecting]: "Reconectando...",
};

export function LiveCard({ info, onStop }: LiveCardProps) {
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
        {info.hasAudio && <span>🔊 áudio</span>}
      </div>

      <button className="btn-danger" onClick={onStop}>
        Encerrar transmissão
      </button>
    </div>
  );
}
