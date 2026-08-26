import type { StreamSettings } from "../types/stream";

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
}

export async function createRoom(settings: StreamSettings, slug?: string): Promise<CreateRoomResponse> {
  const res = await fetch(`${backendUrl}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings, slug: slug || undefined }),
  });
  if (!res.ok) {
    if (res.status === 409) throw new Error("Esse nome de sala já está em uso.");
    if (res.status === 400) throw new Error("Nome de sala inválido (use letras, números e hífen).");
    throw new Error("Falha ao criar sala de transmissão.");
  }
  return res.json();
}

export async function endRoom(roomId: string): Promise<void> {
  await fetch(`${backendUrl}/rooms/${roomId}`, { method: "DELETE" });
}

export interface RoomSummary {
  roomId: string;
  createdAt: number;
}

export async function fetchActiveRooms(): Promise<RoomSummary[]> {
  const res = await fetch(`${backendUrl}/rooms`);
  if (!res.ok) throw new Error("Falha ao listar transmissões ativas.");
  const data = await res.json();
  return data.rooms;
}

export interface RoomInfo {
  roomId: string;
  createdAt: number;
  nativeMode: boolean;
}

// Chamado antes de decidir qual hook usar pra assistir (LiveKit vs transporte nativo, ver
// hooks/useNativeStream.ts) — WatchPage precisa saber `nativeMode` antes de conectar em qualquer
// um dos dois.
export async function fetchRoomInfo(roomId: string): Promise<RoomInfo> {
  const res = await fetch(`${backendUrl}/rooms/${roomId}`);
  if (!res.ok) throw new Error("Sala não encontrada ou encerrada.");
  return res.json();
}

export interface IceServerDescriptor {
  urls: string;
  username?: string;
  credential?: string;
}

// STUN+TURN de verdade (infra própria, ver docker-compose.yml/backend `services/turn.ts`) — cai
// pro STUN público se o backend não tiver TURN configurado ou estiver inacessível. Formato já
// vem pronto pro `RTCPeerConnection({iceServers})` do navegador, sem transformação nenhuma
// (diferente do lado desktop, que precisa embutir usuário/senha na URL pro libdatachannel — ver
// desktop/src/renderer/src/services/nativeTransport.ts).
const FALLBACK_ICE_SERVERS: IceServerDescriptor[] = [{ urls: "stun:stun.l.google.com:19302" }];

export async function fetchIceServers(): Promise<IceServerDescriptor[]> {
  try {
    const res = await fetch(`${backendUrl}/ice-servers`);
    if (!res.ok) return FALLBACK_ICE_SERVERS;
    const data = await res.json();
    return data.iceServers?.length ? data.iceServers : FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
}

// Sinalização do transporte nativo via WebSocket (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase
// 4 e backend/src/services/nativeWsRelay.ts) — substitui o REST+polling anterior. Backend só faz
// relay puro; o protocolo (mensagens JSON `{type: "offer"|"answer"|"ice", ...}`) é decidido e lido
// direto em useNativeStream.ts, aqui só abre a conexão.
export type NativeVideoCodec = "h264" | "hevc" | "av1";

export function openNativeSignalingSocket(roomId: string): WebSocket {
  const wsUrl = `${backendUrl.replace(/^http/, "ws")}/rooms/${roomId}/native/ws?role=viewer`;
  return new WebSocket(wsUrl);
}
