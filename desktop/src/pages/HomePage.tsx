import { useState } from "react";
import { SettingsForm } from "../components/SettingsForm";
import { LiveCard } from "../components/LiveCard";
import { Logo } from "../components/Logo";
import type { useBroadcast } from "../hooks/useBroadcast";
import { defaultStreamSettings } from "../types/stream";

interface HomePageProps {
  broadcast: ReturnType<typeof useBroadcast>;
}

export function HomePage({ broadcast }: HomePageProps) {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const { state, info, error, start, stop } = broadcast;

  if (state === "live" && info) {
    return <LiveCard info={info} onStop={stop} />;
  }

  return (
    <div className="home-page">
      <Logo />
      <h1>ScreenShare</h1>
      <p className="subtitle">Compartilhe sua tela em tempo real</p>

      <SettingsForm settings={settings} onChange={setSettings} />

      {error && <p className="error-text">{error}</p>}

      <button className="btn-primary" onClick={() => start(settings)} disabled={state === "starting"}>
        {state === "starting" ? "Iniciando..." : "Compartilhar tela"}
      </button>
    </div>
  );
}
