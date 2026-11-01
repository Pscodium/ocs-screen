import { useState } from "react";
import type { RoomSummary } from "../services/backend";
import { useNow } from "../hooks/useNow";
import { BroadcastIcon, EyeIcon, LockIcon, SearchIcon } from "./Icons";

// Acima disso aparece a busca.
const SEARCH_THRESHOLD = 6;

function timeAgo(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
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
  rooms: RoomSummary[] | null;
  error: string | null;
  onStartSharing: () => void;
}

// Cards das transmissões públicas (mesma linguagem visual da lista do viewer web). Clicar abre o
// viewer web da sala numa janela própria (main `viewer:open`) — um player só, mantido no viewer.
export function RoomsBrowser({ rooms, error, onStartSharing }: RoomsBrowserProps) {
  const [query, setQuery] = useState("");
  const now = useNow(30_000);

  const showSearch = (rooms?.length ?? 0) > SEARCH_THRESHOLD;
  const normalized = query.trim().toLowerCase();
  const visible = rooms && showSearch && normalized ? rooms.filter((r) => r.roomId.toLowerCase().includes(normalized)) : rooms;

  if (error && !rooms) return <p className="error-text">{error}</p>;

  if (visible === null) {
    return (
      <div className="room-grid">
        {[0, 1, 2].map((i) => (
          <div key={i} className="room-card room-card-skeleton" />
        ))}
      </div>
    );
  }

  if (rooms?.length === 0) {
    return (
      <div className="empty-state empty-state-boxed">
        <span className="empty-state-icon">
          <BroadcastIcon size={22} />
        </span>
        <p className="empty-state-title">Nenhuma transmissão ativa no momento.</p>
        <p className="empty-state-hint">Que tal começar uma? Salas públicas aparecem aqui pra todo mundo.</p>
        <button className="btn-primary btn-inline" onClick={onStartSharing}>
          Compartilhar minha tela
        </button>
      </div>
    );
  }

  return (
    <div className="rooms-browser">
      {showSearch && (
        <label className="room-search">
          <SearchIcon size={15} />
          <input type="search" placeholder="Buscar transmissão" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      {error && <p className="error-text">{error}</p>}
      {visible.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-hint">Nenhuma sala com "{query.trim()}".</p>
        </div>
      ) : (
        <div className="room-grid">
          {visible.map((room) => {
            const specs = formatSettings(room.settings);
            return (
              <button key={room.roomId} className="room-card" onClick={() => window.screenshare.viewer.open(room.viewerUrl)}>
                <span className="room-card-top">
                  <span className="room-avatar" aria-hidden="true">
                    {room.roomId.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="room-card-info">
                    <span className="room-card-name">
                      <span className="room-card-name-text">{room.roomId}</span>
                      {room.hasPassword && (
                        <span className="room-card-lock" title="Protegida por senha">
                          <LockIcon size={12} />
                        </span>
                      )}
                    </span>
                    <span className="room-card-meta">
                      <span className="live-tag">AO VIVO</span>
                      {timeAgo(room.createdAt, now)}
                    </span>
                  </span>
                </span>
                <span className="room-card-bottom">
                  {specs && <span className="chip">{specs}</span>}
                  {room.viewerCount != null && (
                    <span className="room-card-viewers" title="Espectadores">
                      <EyeIcon size={13} />
                      {room.viewerCount}
                    </span>
                  )}
                  <span className="room-card-cta">Assistir</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
