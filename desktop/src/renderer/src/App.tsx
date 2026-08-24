import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { UpdateModal } from "./components/UpdateModal";
import { NativeCaptureDebug } from "./components/NativeCaptureDebug";
import { HomePage } from "./pages/HomePage";
import { useBroadcast } from "./hooks/useBroadcast";
import { useWidgetWindow } from "./hooks/useWidgetWindow";
import { useAppUpdater } from "./hooks/useAppUpdater";

export function App() {
  const broadcast = useBroadcast();
  const isLive = broadcast.state === "live";
  useWidgetWindow(isLive);
  const updater = useAppUpdater();

  useEffect(() => {
    window.screenshare.tray.setStatus(isLive, broadcast.info?.viewerCount ?? 0);
  }, [isLive, broadcast.info?.viewerCount]);

  return (
    <div className={`app-shell ${isLive ? "app-shell-widget" : ""}`}>
      <TitleBar compact={isLive} />
      <div className="app-content">
        <HomePage broadcast={broadcast} />
      </div>
      {!isLive && <UpdateModal updater={updater} />}
      {import.meta.env.DEV && !isLive && <NativeCaptureDebug />}
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
