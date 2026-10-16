import type { StreamSettings } from "../types/stream";

export const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
  nativeMode: boolean;
}

// Sala privada = fora da lista pública ("Assistir"/home do viewer), só entra quem tem o link.
// Senha = espectador digita antes de assistir (o backend guarda só o hash e confere no token/WS).
export interface RoomAccess {
  isPrivate: boolean;
  password?: string;
}

export async function createRoom(
  settings: StreamSettings,
  slug?: string,
  nativeMode?: boolean,
  access: RoomAccess = { isPrivate: false },
): Promise<CreateRoomResponse> {
  const res = await fetch(`${backendUrl}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings,
      slug: slug || undefined,
      nativeMode,
      isPrivate: access.isPrivate,
      password: access.password || undefined,
    }),
  });
  if (!res.ok) {
    if (res.status === 409) throw new Error("Esse nome de sala já está em uso.");
    if (res.status === 400) throw new Error("Nome de sala ou senha inválidos (nome: letras, números e hífen; senha: até 128 caracteres).");
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
  hasPassword?: boolean;
  viewerUrl: string;
}

export async function fetchActiveRooms(): Promise<RoomSummary[]> {
  const res = await fetch(`${backendUrl}/rooms`);
  if (!res.ok) throw new Error("Falha ao listar transmissões ativas.");
  const data = await res.json();
  return data.rooms;
}

