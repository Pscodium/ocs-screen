import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "./Logo";

interface TitleBarProps {
  compact?: boolean;
  // Navegação no meio da barra (fora da região de arrastar — ver `.titlebar-nav`).
  children?: ReactNode;
}

export function TitleBar({ compact, children }: TitleBarProps) {
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
        <Logo size={compact ? 15 : 18} />
        OCS Screen
      </span>
      {children && <nav className="titlebar-nav">{children}</nav>}
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => window.screenshare.window.minimize()} aria-label="Minimizar">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        {!compact && (
          <button className="titlebar-btn" onClick={toggleMaximize} aria-label={isMaximized ? "Restaurar" : "Maximizar"}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
              {isMaximized ? (
                <>
                  <rect x="0.5" y="2.5" width="7" height="7" />
                  <path d="M2.5 2.5V0.5h7v7h-2" />
                </>
              ) : (
                <rect x="0.5" y="0.5" width="9" height="9" />
              )}
            </svg>
          </button>
        )}
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={() => window.screenshare.window.close()}
          aria-label="Fechar"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
