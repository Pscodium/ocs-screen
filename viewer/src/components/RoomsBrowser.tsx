import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchActiveRooms, type RoomSummary } from "../services/backend";

const POLL_MS = 4000;

function timeAgo(createdAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (seconds < 60) return "agora mesmo";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `há ${hours}h`;
}

function LockIcon() {
  return (
    <svg className="room-row-lock" width="12" height="12" viewBox="0 0 24 24" aria-label="Protegida por senha">
      <path fill="currentColor" d="M17 9V7A5 5 0 0 0 7 7v2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2ZM9 7a3 3 0 0 1 6 0v2H9Z" />
    </svg>
  );
}

export function RoomsBrowser() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const list = await fetchActiveRooms();
        if (!cancelled) {
          setRooms(list);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Erro desconhecido.");
      }
    };

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error) return <p className="error-text">{error}</p>;

  if (rooms === null) {
    return (
      <div className="room-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="room-row room-row-skeleton" />
        ))}
      </div>
    );
  }

  if (rooms.length === 0) {
    return <p className="subtitle room-list-empty">Nenhuma transmissão ativa no momento.</p>;
  }

  return (
    <div className="room-list">
      {rooms.map((room) => (
        <button key={room.roomId} className="room-row" onClick={() => navigate(`/s/${room.roomId}`)}>
          <span className="room-row-dot" />
          <span className="room-row-info">
            <span className="room-row-name">
              {room.roomId}
              {room.hasPassword && <LockIcon />}
            </span>
            <span className="room-row-meta">{timeAgo(room.createdAt)}</span>
          </span>
          <span className="room-row-cta">Assistir</span>
        </button>
      ))}
    </div>
  );
}
