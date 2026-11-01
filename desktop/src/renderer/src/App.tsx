import { useEffect, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { UpdateModal } from "./components/UpdateModal";
import { BroadcastIcon, EyeIcon } from "./components/Icons";
import { HomePage, type HomeTab } from "./pages/HomePage";
import { useBroadcast } from "./hooks/useBroadcast";
import { useWidgetWindow } from "./hooks/useWidgetWindow";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useActiveRooms } from "./hooks/useActiveRooms";

export function App() {
  const broadcast = useBroadcast();
  const isLive = broadcast.state === "live";
  useWidgetWindow(isLive);
  const updater = useAppUpdater();
  const [tab, setTab] = useState<HomeTab>("share");
  const rooms = useActiveRooms(!isLive, tab === "watch");
  const roomCount = rooms.rooms?.length ?? 0;

  useEffect(() => {
    window.screenshare.tray.setStatus(isLive, broadcast.info?.viewerCount ?? 0);
  }, [isLive, broadcast.info?.viewerCount]);

  return (
    <div className={`app-shell ${isLive ? "app-shell-widget" : ""}`}>
      <TitleBar compact={isLive}>
        {!isLive && (
          <div className="nav-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "share"}
              className={`nav-tab ${tab === "share" ? "nav-tab-active" : ""}`}
              onClick={() => setTab("share")}
            >
              <BroadcastIcon size={15} />
              Transmitir
            </button>
            <button
              role="tab"
              aria-selected={tab === "watch"}
              className={`nav-tab ${tab === "watch" ? "nav-tab-active" : ""}`}
              onClick={() => setTab("watch")}
            >
              <EyeIcon size={15} />
              Ao vivo agora
              {roomCount > 0 && <span className="nav-tab-count">{roomCount}</span>}
            </button>
          </div>
        )}
      </TitleBar>
      <div className="app-content">
        <HomePage broadcast={broadcast} rooms={rooms} tab={tab} onTabChange={setTab} suspended={updater.visible} />
      </div>
      {!isLive && <UpdateModal updater={updater} />}
      {/* Só builda em dev (import.meta.env.DEV) — não vaza pro instalador de produção. Sem isso,
          testar o modal de atualização exigia publicar uma versão de verdade no GitHub toda vez. */}
      {import.meta.env.DEV && !isLive && !updater.visible && (
        <button className="debug-update-btn" onClick={updater.simulate} title="Simular tela de atualização">
          🐞 update
        </button>
      )}
    </div>
  );
}
