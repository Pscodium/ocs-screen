import { useState } from "react";
import { LiveCard } from "../components/LiveCard";
import { SourceBrowser } from "../components/SourcePicker";
import { RoomsBrowser } from "../components/RoomsBrowser";
import { SettingsAdvanced, SettingsPrimary } from "../components/SettingsForm";
import { AudioAppsSettings } from "../components/AudioAppsSettings";
import { AccessOptions, type AccessSettings, defaultAccessSettings } from "../components/AccessOptions";
import type { useBroadcast } from "../hooks/useBroadcast";
import type { useActiveRooms } from "../hooks/useActiveRooms";
import type { CaptureSource } from "../../../preload/index";
import {
  AUTO_FPS_TARGET,
  RESOLUTION_CONSTRAINTS,
  defaultStreamSettings,
  getMaxBitrate,
  type StreamSettings,
} from "../types/stream";

export type HomeTab = "share" | "watch";

interface HomePageProps {
  broadcast: ReturnType<typeof useBroadcast>;
  rooms: ReturnType<typeof useActiveRooms>;
  tab: HomeTab;
  onTabChange: (tab: HomeTab) => void;
  // Algo por cima da tela (modal de atualização) — pausa as miniaturas ao vivo, que o DWM
  // desenharia por cima do modal.
  suspended: boolean;
}

// Resumo do perfil escolhido — teto de bitrate pela mesma fórmula do publish (getMaxBitrate), mesmo
// card do viewer web. "Automática" estima por 1080p; o real depende do monitor capturado.
function ProfileSummary({ settings }: { settings: StreamSettings }) {
  const approx = settings.resolution === "auto" || settings.fps === "auto" ? "~" : "";
  const { width, height } = RESOLUTION_CONSTRAINTS[settings.resolution === "auto" ? "1080p" : settings.resolution];
  const fps = settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps;
  const mbps = getMaxBitrate(width, height, settings) / 1_000_000;
  const gbPerHour = (mbps * 3600) / 8 / 1000;

  return (
    <div className="profile-summary">
      <span className="profile-summary-name">
        {approx}
        {height}p{fps}
      </span>
      <div className="profile-summary-rows">
        <span>Bitrate máximo</span>
        <strong>
          {approx}
          {mbps.toFixed(1)} Mbps
        </strong>
        <span>Upload por hora</span>
        <strong>
          até {approx}
          {gbPerHour.toFixed(1)} GB
        </strong>
      </div>
    </div>
  );
}

export function HomePage({ broadcast, rooms, tab, onTabChange, suspended }: HomePageProps) {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState("");
  const [access, setAccess] = useState<AccessSettings>(defaultAccessSettings);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
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

  const starting = state === "starting";
  const passwordMissing = access.usePassword && access.password.trim() === "";

  // Um clique no tile já começa a transmitir — senha ligada e vazia é barrada aqui (senão a sala
  // nasceria sem senha, sem o usuário perceber).
  const handlePick = (source: CaptureSource) => {
    if (starting) return;
    if (passwordMissing) {
      setFormError('Digite a senha da sala (ou desligue "Proteger com senha") antes de escolher a tela.');
      return;
    }
    setFormError(null);
    setPickedId(source.id);
    start(settings, source, slug, {
      isPrivate: access.isPrivate,
      password: access.usePassword ? access.password : undefined,
    });
  };

  const shownError = formError ?? (state === "error" ? error : null);

  return (
    <div className="home-page" data-tab={tab}>
      <div className="setup-layout home-view-share">
        <aside className="setup-sidebar">
          <fieldset className="settings-fieldset" disabled={starting}>
            <section className="setup-section">
              <h3 className="setup-section-title">Qualidade</h3>
              <SettingsPrimary settings={settings} onChange={setSettings} />
              <ProfileSummary settings={settings} />
            </section>

            <section className="setup-section">
              <h3 className="setup-section-title">Sala</h3>
              <label className="settings-field">
                <span>Nome da sala</span>
                <span className="slug-input-group">
                  <span className="slug-input-prefix">/s/</span>
                  <input
                    className="slug-input"
                    type="text"
                    placeholder="gerado automaticamente"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    maxLength={32}
                  />
                </span>
              </label>
              <AccessOptions
                access={access}
                onChange={(next) => {
                  setAccess(next);
                  setFormError(null);
                }}
              />
            </section>

            <details
              className="setup-section setup-advanced"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary className="setup-section-title setup-advanced-summary">Avançado</summary>
              <div className="setup-advanced-body">
                <SettingsAdvanced settings={settings} onChange={setSettings} />
                {settings.nativeTransport && (
                  <div className="setup-subsection">
                    <h4 className="setup-subsection-title">Áudio da transmissão</h4>
                    {advancedOpen && <AudioAppsSettings />}
                  </div>
                )}
              </div>
            </details>
          </fieldset>
        </aside>

        <SourceBrowser
          // Iniciando: nada de relistar — a miniatura de tela do Chromium disputa a duplicação DXGI
          // com a captura nativa que está subindo (e ela falharia, caindo pro modo compatível).
          active={tab === "share" && !suspended && !starting}
          pendingId={starting ? pickedId : null}
          onPick={handlePick}
          footer={
            <div className="source-browser-footer">
              {shownError ? (
                <p className="error-text">{shownError}</p>
              ) : (
                <p className="source-browser-hint">
                  {starting ? "Criando a sala e iniciando a captura..." : "Clique numa tela ou janela pra começar a transmitir."}
                </p>
              )}
            </div>
          }
        />
      </div>

      <section className="home-view-watch">
        <div className="watch-head">
          <div>
            <h2 className="watch-title">
              <span className="live-dot live-dot-ring" />
              Ao vivo agora
              {rooms.rooms && rooms.rooms.length > 0 && <span className="count-pill">{rooms.rooms.length}</span>}
            </h2>
            <p className="watch-subtitle">Transmissões públicas abertas agora. Abre numa janela própria do app.</p>
          </div>
        </div>
        <RoomsBrowser rooms={rooms.rooms} error={rooms.error} onStartSharing={() => onTabChange("share")} />
      </section>
    </div>
  );
}
