import { TitleBar } from "./components/TitleBar";
import { HomePage } from "./pages/HomePage";
import { useBroadcast } from "./hooks/useBroadcast";
import { useWidgetWindow } from "./hooks/useWidgetWindow";

export function App() {
  const broadcast = useBroadcast();
  const isLive = broadcast.state === "live";
  useWidgetWindow(isLive);

  return (
    <div className={`app-shell ${isLive ? "app-shell-widget" : ""}`}>
      <TitleBar compact={isLive} />
      <div className="app-content">
        <HomePage broadcast={broadcast} />
      </div>
    </div>
  );
}
