import { useState } from "react";
import { SettingsForm } from "../components/SettingsForm";
import { LiveCard } from "../components/LiveCard";
import { Logo } from "../components/Logo";
import { useBroadcast } from "../hooks/useBroadcast";
import { defaultStreamSettings } from "../types/stream";

export function HomePage() {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const { state, info, error, start, stop } = useBroadcast();

  if (state === "live" && info) {
    return <LiveCard info={info} onStop={stop} />;
  }

  return (
    <div className="home-page">
      <Logo />
      <h1>ScreenShare</h1>
      <p className="subtitle">Compartilhe sua tela direto do navegador — sem instalar nada.</p>

      <div className="home-card">
        <SettingsForm settings={settings} onChange={setSettings} />

        {error && <p className="error-text">{error}</p>}

        <button className="btn-primary" onClick={() => start(settings)} disabled={state === "starting"}>
          {state === "starting" ? "Iniciando..." : "Compartilhar tela"}
        </button>
      </div>
    </div>
  );
}
