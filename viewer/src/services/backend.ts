import type { StreamSettings } from "../types/stream";

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export interface CreateRoomResponse {
  roomId: string;
  hostToken: string;
  livekitUrl: string;
  viewerUrl: string;
}

export async function createRoom(settings: StreamSettings): Promise<CreateRoomResponse> {
  const res = await fetch(`${backendUrl}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) throw new Error("Falha ao criar sala de transmissão.");
  return res.json();
}

export async function endRoom(roomId: string): Promise<void> {
  await fetch(`${backendUrl}/rooms/${roomId}`, { method: "DELETE" });
}
