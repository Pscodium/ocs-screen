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
