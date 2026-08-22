import { useState } from "react";
import { SettingsForm } from "../components/SettingsForm";
import { LiveCard } from "../components/LiveCard";
import { RoomsBrowser } from "../components/RoomsBrowser";
import { useBroadcast } from "../hooks/useBroadcast";
import { defaultStreamSettings } from "../types/stream";

type Tab = "share" | "watch";

export function HomePage() {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState("");
  const [tab, setTab] = useState<Tab>("share");
  const { state, info, error, start, stop } = useBroadcast();

  if (state === "live" && info) {
    return <LiveCard info={info} onStop={stop} />;
  }

  return (
    <div className="home-page">
      <h1>Screen Share</h1>
      <p className="subtitle">Compartilhe sua tela direto do navegador — sem instalar nada.</p>

      <div className="home-card">
        <div className="mode-tabs">
          <button className={`mode-tab ${tab === "share" ? "mode-tab-active" : ""}`} onClick={() => setTab("share")}>
            Transmitir
          </button>
          <button className={`mode-tab ${tab === "watch" ? "mode-tab-active" : ""}`} onClick={() => setTab("watch")}>
            Assistir
          </button>
        </div>

        {tab === "share" ? (
          <>
            <SettingsForm settings={settings} onChange={setSettings} />

            <label className="settings-field room-slug-field">
              <span>Nome da sala (opcional)</span>
              <input
                className="slug-input"
                type="text"
                placeholder="ex.: reuniao-time"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                maxLength={32}
              />
            </label>

            {error && <p className="error-text">{error}</p>}

            <button className="btn-primary" onClick={() => start(settings, slug)} disabled={state === "starting"}>
              {state === "starting" ? "Iniciando..." : "Compartilhar tela"}
            </button>
          </>
        ) : (
          <RoomsBrowser />
        )}
      </div>
    </div>
  );
}
