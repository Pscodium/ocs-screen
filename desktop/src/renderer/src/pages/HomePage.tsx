import { useState } from "react";
import { LiveCard } from "../components/LiveCard";
import { Logo } from "../components/Logo";
import { SourcePicker } from "../components/SourcePicker";
import { RoomsBrowser } from "../components/RoomsBrowser";
import type { useBroadcast } from "../hooks/useBroadcast";
import { defaultStreamSettings } from "../types/stream";
import { type AccessSettings, defaultAccessSettings } from "../components/AccessOptions";

interface HomePageProps {
  broadcast: ReturnType<typeof useBroadcast>;
}

type Tab = "share" | "watch";

export function HomePage({ broadcast }: HomePageProps) {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState("");
  const [access, setAccess] = useState<AccessSettings>(defaultAccessSettings);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("share");
  const { state, info, error, start, stop, swapSource, swapping, optimizeCodec, optimizingCodec, toggleCursor } =
    broadcast;

  if (state === "live" && info) {
    return (
      <LiveCard
        info={info}
        swapping={swapping}
        onStop={stop}
        onSwapSource={swapSource}
        onOptimizeCodec={optimizeCodec}
        optimizingCodec={optimizingCodec}
        onToggleCursor={toggleCursor}
      />
    );
  }

  return (
    <div className="home-page">
      <Logo size={40} />
      <h1>Screen Share</h1>
      <p className="subtitle">Compartilhe sua tela em tempo real</p>

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
          {error && <p className="error-text">{error}</p>}

          <button className="btn-primary" onClick={() => setPickerOpen(true)} disabled={state === "starting"}>
            {state === "starting" ? "Iniciando..." : "Compartilhar tela"}
          </button>
        </>
      ) : (
        <RoomsBrowser onSelect={(room) => window.screenshare.viewer.open(room.viewerUrl)} />
      )}

      {pickerOpen && (
        <SourcePicker
          settings={settings}
          onSettingsChange={setSettings}
          slug={slug}
          onSlugChange={setSlug}
          access={access}
          onAccessChange={setAccess}
          onCancel={() => setPickerOpen(false)}
          onSelect={(source) => {
            setPickerOpen(false);
            start(settings, source, slug, {
              isPrivate: access.isPrivate,
              password: access.usePassword ? access.password : undefined,
            });
          }}
        />
      )}
    </div>
  );
}
