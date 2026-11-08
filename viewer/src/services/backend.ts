import type { StreamSettings } from "../types/stream";

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
  // Backend antigo não devolve — aí a sala fica no modo sem proteção, como antes.
  hostSecret?: string;
}

// Segredo de host por sala, só em memória (nunca persistido): prova pro backend que quem encerra a
// sala ou conecta como host é quem criou.
const hostSecrets = new Map<string, string>();

export function getHostSecret(roomId: string): string | undefined {
  return hostSecrets.get(roomId);
}

export interface RoomAccess {
  isPrivate: boolean;
  password?: string;
  // Opt-in: apelido mostrado no aviso do Discord. Ausente = aviso sem nome.
  hostName?: string;
}

export async function createRoom(
  settings: StreamSettings,
  slug?: string,
  access: RoomAccess = { isPrivate: false },
  nativeMode = false,
): Promise<CreateRoomResponse> {
  const res = await fetch(`${backendUrl}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings,
      slug: slug || undefined,
      isPrivate: access.isPrivate,
      password: access.password || undefined,
      hostName: access.hostName || undefined,
      nativeMode,
      source: "web",
      appVersion: __APP_VERSION__,
      hostAuth: true,
      // Legado — backend em produção antes do `source` só entende isso. Pode sair depois do deploy.
      isWebLive: true,
    }),
  });
  if (!res.ok) {
    if (res.status === 409) throw new Error("Esse nome de sala já está em uso.");
    if (res.status === 400) throw new Error("Nome de sala inválido (use letras, números e hífen).");
    throw new Error("Falha ao criar sala de transmissão.");
  }
  const room = (await res.json()) as CreateRoomResponse;
  if (room.hostSecret) hostSecrets.set(room.roomId, room.hostSecret);
  return room;
}

export async function endRoom(roomId: string): Promise<void> {
  const secret = hostSecrets.get(roomId);
  try {
    await fetch(`${backendUrl}/rooms/${roomId}`, {
      method: "DELETE",
      headers: secret ? { "X-Host-Secret": secret } : {},
    });
  } finally {
    hostSecrets.delete(roomId);
  }
}

export interface RoomSummary {
  roomId: string;
  createdAt: number;
  hasPassword: boolean;
  settings?: Pick<StreamSettings, "resolution" | "fps" | "quality">;
  // null quando o backend não consegue saber (LiveKit fora do ar).
  viewerCount?: number | null;
  // De onde o host transmite. Ausente em backend antigo (aí a UI não mostra a origem).
  source?: "desktop" | "web";
}

// Rótulo curto da origem da transmissão (campo `source` do backend).
export function roomSourceLabel(source: RoomSummary["source"]): string | null {
  if (source === "desktop") return "App";
  if (source === "web") return "Navegador";
  return null;
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
  hasPassword: boolean;
  settings?: Pick<StreamSettings, "resolution" | "fps" | "quality">;
  viewerCount?: number | null;
}

// Valida a senha antes de montar o player (token/WS checam de novo no backend).
export async function verifyRoomPassword(roomId: string, password: string): Promise<boolean> {
  const res = await fetch(`${backendUrl}/rooms/${roomId}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error("Sala não encontrada ou encerrada.");
  return true;
}

// Chamado antes de decidir qual hook usar pra assistir (LiveKit vs transporte nativo, ver
// hooks/useNativeStream.ts) — WatchPage precisa saber `nativeMode` antes de conectar em qualquer
// um dos dois.
export async function fetchRoomInfo(roomId: string): Promise<RoomInfo> {
  const res = await fetch(`${backendUrl}/rooms/${roomId}`);
  if (!res.ok) throw new Error("Sala não encontrada ou encerrada.");
  return res.json();
}

// true/false = sala existe/não existe (404); null = não deu pra saber (rede) — quem chama trata
// null como "talvez exista" e não encerra nada por causa disso.
export async function roomExists(roomId: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${backendUrl}/rooms/${roomId}`);
    if (res.status === 404) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
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

export function openNativeSignalingSocket(roomId: string, password?: string): WebSocket {
  const passwordParam = password ? `&password=${encodeURIComponent(password)}` : "";
  const wsUrl = `${backendUrl.replace(/^http/, "ws")}/rooms/${roomId}/native/ws?role=viewer${passwordParam}`;
  return new WebSocket(wsUrl);
}
