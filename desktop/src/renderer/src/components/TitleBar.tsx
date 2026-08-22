import { useEffect, useState } from "react";
import { Logo } from "./Logo";

interface TitleBarProps {
  compact?: boolean;
}

export function TitleBar({ compact }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    window.screenshare.window.isMaximized().then(setIsMaximized);
  }, []);

  const toggleMaximize = () => {
    window.screenshare.window.toggleMaximize();
    setIsMaximized((v) => !v);
  };

  return (
    <div className={`titlebar ${compact ? "titlebar-compact" : ""}`}>
      <span className="titlebar-title">
        <Logo size={16} />
        ScreenShare
      </span>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => window.screenshare.window.minimize()} aria-label="Minimizar">
          &#8211;
        </button>
        {!compact && (
          <button className="titlebar-btn" onClick={toggleMaximize} aria-label={isMaximized ? "Restaurar" : "Maximizar"}>
            {isMaximized ? "❐" : "☐"}
          </button>
        )}
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={() => window.screenshare.window.close()}
          aria-label="Fechar"
        >
          &#10005;
        </button>
      </div>
    </div>
  );
}
