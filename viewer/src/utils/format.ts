// "12:05" / "1:02:33" — tempo de transmissão no player e no painel do host.
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function viewersLabel(count: number): string {
  return `${count} espectador${count === 1 ? "" : "es"}`;
}
