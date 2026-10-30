import { useEffect, useState } from "react";
import { fetchRoomInfo } from "../services/backend";

const POLL_MS = 5000;

// Início da sala e espectadores conectados, consultados periodicamente pro HUD do player.
export function useRoomPresence(roomId: string) {
  const [createdAt, setCreatedAt] = useState<number | null>(null);
  const [viewerCount, setViewerCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const info = await fetchRoomInfo(roomId);
        if (cancelled) return;
        setCreatedAt(info.createdAt);
        setViewerCount(info.viewerCount ?? null);
      } catch {
        // Sala encerrada/rede — o próprio stream já trata o fim; o HUD só mantém o último valor.
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [roomId]);

  return { createdAt, viewerCount };
}
