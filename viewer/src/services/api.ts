const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";

export interface ViewerTokenResponse {
  token: string;
  livekitUrl: string;
  roomId: string;
}

export async function fetchViewerToken(roomId: string): Promise<ViewerTokenResponse> {
  const res = await fetch(`${backendUrl}/rooms/${roomId}/token`, { method: "POST" });
  if (!res.ok) {
    if (res.status === 404) throw new Error("Sala não encontrada ou encerrada.");
    throw new Error("Falha ao entrar na sala.");
  }
  return res.json();
}
