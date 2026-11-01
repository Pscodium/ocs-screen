import { useEffect, useState } from "react";

// Relógio que re-renderiza a cada `intervalMs` — pra contadores de duração ao vivo.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
