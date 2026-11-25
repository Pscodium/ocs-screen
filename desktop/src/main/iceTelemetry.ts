// Diagnóstico de ICE do lado do host (pipeline nativo, libdatachannel/libjuice). O espectador já
// relata o par escolhido (iceLocalType/iceRemoteType), mas quando a conexão falha não dava pra
// saber se o HOST chegou a ter caminho via TURN: libjuice só aloca relay UDP (sem TURN/TCP nem
// TLS — libjuice#257), então host atrás de rede que bloqueia UDP fica sem candidato relay e a
// única saída é o espectador alcançar ele. Aqui contamos o que foi gerado/recebido por espectador.
// Nada de IP, usuário ou credencial sai daqui — só tipo e protocolo.

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | "other";

interface ViewerIce {
  local: Set<string>;
  remote: Set<string>;
}

export interface ParsedCandidate {
  type: CandidateType;
  protocol: "udp" | "tcp" | "other";
}

export function parseCandidate(candidate: string): ParsedCandidate | null {
  // "candidate:<foundation> <component> <proto> <priority> <ip> <port> typ <type> ..."
  const m = /candidate:\S+\s+\d+\s+(\S+)\s+\d+\s+\S+\s+\d+\s+typ\s+(\S+)/i.exec(candidate);
  if (!m) return null;
  const proto = m[1].toLowerCase();
  const typ = m[2].toLowerCase();
  return {
    protocol: proto === "udp" || proto === "tcp" ? proto : "other",
    type: typ === "host" || typ === "srflx" || typ === "prflx" || typ === "relay" ? typ : "other",
  };
}

// Tipos de servidor ICE configurados (sem host/usuário/senha): "stun", "turn-udp", "turn-tcp", "turns".
export function iceServerKinds(urls: string[]): string {
  const kinds = new Set<string>();
  for (const url of urls) {
    if (/^stuns?:/i.test(url)) kinds.add("stun");
    else if (/^turns:/i.test(url)) kinds.add("turns");
    else if (/^turn:/i.test(url)) kinds.add(/transport=tcp/i.test(url) ? "turn-tcp" : "turn-udp");
  }
  return [...kinds].sort().join(",") || "none";
}

const key = (c: ParsedCandidate) => `${c.type}/${c.protocol}`;

export class IceTelemetry {
  private viewers = new Map<string, ViewerIce>();
  // Agregado da transmissão inteira (sobrevive a forgetViewer).
  private viewersSeen = 0;
  private viewersWithLocalRelay = 0;
  private viewersWithRemoteRelay = 0;
  private localTotals = new Map<string, number>();

  private entry(viewerId: string): ViewerIce {
    let e = this.viewers.get(viewerId);
    if (!e) {
      e = { local: new Set(), remote: new Set() };
      this.viewers.set(viewerId, e);
      this.viewersSeen++;
    }
    return e;
  }

  addLocal(viewerId: string, candidate: string): void {
    const c = parseCandidate(candidate);
    if (!c) return;
    const e = this.entry(viewerId);
    if (c.type === "relay" && ![...e.local].some((k) => k.startsWith("relay/"))) this.viewersWithLocalRelay++;
    e.local.add(key(c));
    this.localTotals.set(key(c), (this.localTotals.get(key(c)) ?? 0) + 1);
  }

  addRemote(viewerId: string, candidate: string): void {
    const c = parseCandidate(candidate);
    if (!c) return;
    const e = this.entry(viewerId);
    if (c.type === "relay" && ![...e.remote].some((k) => k.startsWith("relay/"))) this.viewersWithRemoteRelay++;
    e.remote.add(key(c));
  }

  // Do espectador que falhou: o que cada lado tinha. "host/udp,srflx/udp" sem relay = sem TURN.
  viewerSummary(viewerId: string): Record<string, string | boolean> {
    const e = this.viewers.get(viewerId);
    const local = e ? [...e.local].sort().join(",") : "";
    const remote = e ? [...e.remote].sort().join(",") : "";
    return {
      hostCandidates: local || "none",
      viewerCandidates: remote || "none",
      hostHasRelay: local.includes("relay/"),
      viewerHasRelay: remote.includes("relay/"),
    };
  }

  totals(): Record<string, number | string> {
    return {
      iceViewersSeen: this.viewersSeen,
      iceViewersHostRelay: this.viewersWithLocalRelay,
      iceViewersRemoteRelay: this.viewersWithRemoteRelay,
      iceHostCandidateTypes: [...this.localTotals.keys()].sort().join(",") || "none",
    };
  }

  forget(viewerId: string): void {
    this.viewers.delete(viewerId);
  }
}
