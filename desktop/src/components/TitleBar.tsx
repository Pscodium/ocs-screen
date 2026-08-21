import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

interface TitleBarProps {
  compact?: boolean;
}

export function TitleBar({ compact }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized);
    const unlisten = appWindow.onResized(async () => {
      setIsMaximized(await appWindow.isMaximized());
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className={`titlebar ${compact ? "titlebar-compact" : ""}`} data-tauri-drag-region>
      <span className="titlebar-title" data-tauri-drag-region>
        ScreenShare
      </span>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => appWindow.minimize()} aria-label="Minimizar">
          &#8211;
        </button>
        {!compact && (
          <button
            className="titlebar-btn"
            onClick={() => appWindow.toggleMaximize()}
            aria-label={isMaximized ? "Restaurar" : "Maximizar"}
          >
            {isMaximized ? "❐" : "☐"}
          </button>
        )}
        <button className="titlebar-btn titlebar-btn-close" onClick={() => appWindow.close()} aria-label="Fechar">
          &#10005;
        </button>
      </div>
    </div>
  );
}
