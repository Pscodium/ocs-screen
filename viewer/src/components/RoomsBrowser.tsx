import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchActiveRooms, type RoomSummary } from "../services/backend";
import { EyeIcon, LockIcon, SearchIcon } from "./Icons";

const POLL_MS = 4000;
// Acima disso a lista rola e aparece a busca (a altura do painel comporta 3 linhas).
const SEARCH_THRESHOLD = 3;

function timeAgo(createdAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (seconds < 60) return "agora mesmo";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `há ${hours}h`;
}

function formatSettings(settings: RoomSummary["settings"]): string | null {
  if (!settings) return null;
  const res = settings.resolution === "auto" ? "Res. auto" : settings.resolution;
  const fps = settings.fps === "auto" ? "FPS auto" : `${settings.fps} FPS`;
  return `${res} · ${fps}`;
}

interface RoomsBrowserProps {
  // Host transmitindo não pode sair da página (mataria a transmissão) — abre em outra aba.
  openInNewTab?: boolean;
  // Sala do próprio host, marcada como "Você" na lista.
  ownRoomId?: string;
  onCountChange?: (count: number) => void;
}

export function RoomsBrowser({ openInNewTab, ownRoomId, onCountChange }: RoomsBrowserProps) {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

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

  useEffect(() => {
    if (rooms) onCountChange?.(rooms.length);
  }, [rooms, onCountChange]);

  const open = (roomId: string) => {
    const path = `/s/${roomId}`;
    if (openInNewTab) window.open(path, "_blank", "noopener");
    else navigate(path);
  };

  const showSearch = (rooms?.length ?? 0) > SEARCH_THRESHOLD;
  const normalized = query.trim().toLowerCase();
  const filtered = rooms && showSearch && normalized ? rooms.filter((r) => r.roomId.toLowerCase().includes(normalized)) : rooms;
  // Sala do próprio host sempre no topo.
  const visible = filtered && [...filtered].sort((a, b) => Number(b.roomId === ownRoomId) - Number(a.roomId === ownRoomId));

  let body;
  if (error) {
    body = <p className="error-text">{error}</p>;
  } else if (visible === null) {
    body = [0, 1, 2].map((i) => <div key={i} className="room-row room-row-skeleton" />);
  } else if (rooms?.length === 0) {
    body = (
      <div className="room-list-empty">
        <p className="room-list-empty-title">Nenhuma transmissão ativa no momento.</p>
        <p className="room-list-empty-hint">Que tal começar uma? Quem entrar aqui vai te ver na lista.</p>
      </div>
    );
  } else if (visible.length === 0) {
    body = (
      <div className="room-list-empty">
        <p className="room-list-empty-hint">Nenhuma sala com "{query.trim()}".</p>
      </div>
    );
  } else {
    body = visible.map((room) => {
      const specs = formatSettings(room.settings);
      const isOwn = room.roomId === ownRoomId;
      return (
        <button key={room.roomId} className="room-row" onClick={() => open(room.roomId)}>
          <span className="room-row-avatar" aria-hidden="true">
            {room.roomId.slice(0, 1).toUpperCase()}
          </span>
          <span className="room-row-dot" />
          <span className="room-row-info">
            <span className="room-row-name">
              {room.roomId}
              {room.hasPassword && (
                <span className="room-row-lock" title="Protegida por senha">
                  <LockIcon size={12} />
                </span>
              )}
              {isOwn && <span className="room-row-own">Você</span>}
            </span>
            <span className="room-row-meta">
              <span className="room-row-live">AO VIVO</span>
              {timeAgo(room.createdAt)}
              {specs && <span className="room-row-specs"> · {specs}</span>}
            </span>
          </span>
          {room.viewerCount != null && (
            <span className="room-row-viewers" title="Espectadores">
              <EyeIcon size={14} />
              {room.viewerCount}
            </span>
          )}
          <span className="room-row-cta">{openInNewTab ? "Abrir ↗" : "Assistir"}</span>
        </button>
      );
    });
  }

  return (
    <div className="rooms-browser">
      {showSearch && (
        <label className="room-search">
          <SearchIcon size={15} />
          <input type="search" placeholder="Buscar transmissão" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      <div className="room-list">{body}</div>
    </div>
  );
}
