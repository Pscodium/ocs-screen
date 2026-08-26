import { useState } from "react";
import { LiveCard } from "../components/LiveCard";
import { Logo } from "../components/Logo";
import { SourcePicker } from "../components/SourcePicker";
import { RoomsBrowser } from "../components/RoomsBrowser";
import { RoomViewer } from "../components/RoomViewer";
import type { useBroadcast } from "../hooks/useBroadcast";
import { defaultStreamSettings } from "../types/stream";

interface HomePageProps {
  broadcast: ReturnType<typeof useBroadcast>;
}

type Tab = "share" | "watch";

export function HomePage({ broadcast }: HomePageProps) {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("share");
  const [watchingRoomId, setWatchingRoomId] = useState<string | null>(null);
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

  if (watchingRoomId) {
    return <RoomViewer roomId={watchingRoomId} onBack={() => setWatchingRoomId(null)} />;
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
        <RoomsBrowser onSelect={setWatchingRoomId} />
      )}

      {pickerOpen && (
        <SourcePicker
          settings={settings}
          onSettingsChange={setSettings}
          slug={slug}
          onSlugChange={setSlug}
          onCancel={() => setPickerOpen(false)}
          onSelect={(source) => {
            setPickerOpen(false);
            start(settings, source, slug);
          }}
        />
      )}
    </div>
  );
}
