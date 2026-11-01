import { useEffect, useState } from "react";
import { fetchActiveRooms, type RoomSummary } from "../services/backend";

// Aba "Ao vivo agora" aberta: atualiza rápido. Fechada: só mantém o contador da aba em dia.
const POLL_FOCUSED_MS = 4000;
const POLL_BACKGROUND_MS = 15000;

// Lista pública de transmissões. Não consulta com o app minimizado/escondido nem durante a própria
// transmissão (`enabled` false) — volta a consultar na hora quando reaparece.
export function useActiveRooms(enabled: boolean, focused: boolean) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loading = false;

    const load = async () => {
      if (loading) return;
      loading = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (!document.hidden) {
        try {
          const list = await fetchActiveRooms();
          if (cancelled) return;
          setRooms(list);
          setError(null);
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Erro desconhecido.");
        }
      }
      loading = false;
      if (!cancelled) timer = setTimeout(load, focused ? POLL_FOCUSED_MS : POLL_BACKGROUND_MS);
    };
    const onVisibility = () => {
      if (!document.hidden) load();
    };

    load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, focused]);

  return { rooms, error };
}
