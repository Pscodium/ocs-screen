// Relatório de diagnóstico do pipeline nativo pro backend (ver backend/src/routes/telemetry.ts).
// Mandado UMA vez por evento (falha detectada / fim da sessão), nunca periódico. `keepalive` faz o
// pedido sobreviver ao fechamento da aba (mesmo papel do `sendBeacon`, mas aceita JSON com CORS).
// Nunca lança — telemetria não pode atrapalhar a transmissão.

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export type TelemetryValue = string | number | boolean | null;
export type TelemetryData = Record<string, TelemetryValue>;

export function sendTelemetry(
  roomId: string,
  role: "host" | "viewer",
  reason: string,
  sessionId: string,
  data: TelemetryData,
): void {
  try {
    void fetch(`${backendUrl}/rooms/${encodeURIComponent(roomId)}/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, source: "web", reason, sessionId, data }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignora
  }
}

export function newTelemetrySessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Tipo do par ICE selecionado (`host` = direto na LAN, `srflx` = direto via NAT, `relay` = passou
// pelo TURN/coturn) + protocolo — é o que diz se a mídia passou pelo coturn ou não.
export async function selectedCandidateInfo(pc: RTCPeerConnection): Promise<TelemetryData> {
  try {
    const stats = await pc.getStats();
    let pair: RTCIceCandidatePairStats | undefined;
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && (report as RTCIceCandidatePairStats).nominated && (report as RTCIceCandidatePairStats).state === "succeeded") {
        pair = report as RTCIceCandidatePairStats;
      }
    });
    if (!pair) return { iceLocalType: null, iceRemoteType: null };
    const local = stats.get(pair.localCandidateId) as { candidateType?: string; protocol?: string; relayProtocol?: string } | undefined;
    const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
    return {
      iceLocalType: local?.candidateType ?? null,
      iceRemoteType: remote?.candidateType ?? null,
      iceProtocol: local?.protocol ?? null,
      iceRelayProtocol: local?.relayProtocol ?? null,
      rttMs: pair.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : null,
    };
  } catch {
    return { iceLocalType: null, iceRemoteType: null };
  }
}
