import { useState } from "react";
import { Link } from "react-router-dom";
import { SettingsForm } from "../components/SettingsForm";
import { LiveCard } from "../components/LiveCard";
import { RoomsBrowser } from "../components/RoomsBrowser";
import { EyeOffIcon, GlobeIcon, LockIcon } from "../components/Icons";
import { useBroadcast } from "../hooks/useBroadcast";
import {
  AUTO_FPS_TARGET,
  RESOLUTION_CONSTRAINTS,
  defaultStreamSettings,
  getMaxBitrate,
  type StreamSettings,
} from "../types/stream";

type Tab = "share" | "watch";

// Resumo do perfil escolhido — teto de bitrate pela mesma fórmula do publish (getMaxBitrate).
// "Automática" estima por 1080p; o real depende do que o navegador capturar.
function ProfileSummary({ settings }: { settings: StreamSettings }) {
  const isAutoRes = settings.resolution === "auto";
  const { width, height } = RESOLUTION_CONSTRAINTS[settings.resolution === "auto" ? "1080p" : settings.resolution];
  const fps = settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps;
  const mbps = getMaxBitrate(width, height, settings) / 1_000_000;
  const gbPerHour = (mbps * 3600) / 8 / 1000;
  const approx = isAutoRes || settings.fps === "auto" ? "~" : "";

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

export function HomePage() {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordMissing = usePassword && password.trim() === "";
  const [tab, setTab] = useState<Tab>("share");
  const [roomCount, setRoomCount] = useState<number | null>(null);
  const { state, info, error, start, stop, optimizeCodec, optimizingCodec } = useBroadcast();
  const isLive = state === "live" && info !== null;

  return (
    <div className="home-page">
      <header className="home-header">
        <h1>Screen Share</h1>
        <p className="subtitle">Compartilhe sua tela direto do navegador — sem instalar nada.</p>
      </header>

      {/* Mobile: abas alternam os painéis. Desktop (CSS): grade com tudo visível, abas escondidas.
          A transmissão ao vivo continua nesta mesma página — o painel da sala vira o LiveCard. */}
      <div className="home-layout" data-tab={tab}>
        <div className="mode-tabs">
          <button className={`mode-tab ${tab === "share" ? "mode-tab-active" : ""}`} onClick={() => setTab("share")}>
            {isLive ? "Sua transmissão" : "Transmitir"}
          </button>
          <button className={`mode-tab ${tab === "watch" ? "mode-tab-active" : ""}`} onClick={() => setTab("watch")}>
            Assistir
          </button>
        </div>

        <section className="home-card home-panel-settings">
          <h2 className="home-panel-title">Qualidade</h2>
          <fieldset className="settings-fieldset" disabled={isLive || state === "starting"}>
            <SettingsForm settings={settings} onChange={setSettings} />
          </fieldset>
          <ProfileSummary settings={settings} />
          <p className="share-audio-hint">
            {isLive
              ? "Encerre a transmissão para mudar a qualidade."
              : 'Pra transmitir som, ligue "Compartilhar também áudio do sistema" no diálogo do navegador.'}
          </p>
        </section>

        <section className="home-card home-panel-watch">
          <div className="home-panel-head">
            <h2 className="home-panel-title">
              <span className="live-dot" />
              Ao vivo agora
              {roomCount !== null && roomCount > 0 && <span className="home-panel-count">{roomCount}</span>}
            </h2>
            <span className="home-panel-hint">
              {isLive ? "Abre em outra aba — sua transmissão continua" : "Clique numa transmissão pra assistir"}
            </span>
          </div>
          <RoomsBrowser openInNewTab={isLive} ownRoomId={info?.roomId} onCountChange={setRoomCount} />
        </section>

        {isLive ? (
          <LiveCard info={info} onStop={stop} onOptimizeCodec={optimizeCodec} optimizingCodec={optimizingCodec} />
        ) : (
          <section className="home-card home-panel-room">
            <h2 className="home-panel-title">Sala</h2>

            <div className="room-form">
              <div className="room-form-col">
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

                <div className="settings-field">
                  <span>Visibilidade</span>
                  <div className="visibility-options" role="radiogroup">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!isPrivate}
                      className={`visibility-option ${!isPrivate ? "visibility-option-active" : ""}`}
                      onClick={() => setIsPrivate(false)}
                    >
                      <GlobeIcon size={18} />
                      <span className="visibility-option-title">Pública</span>
                      <span className="visibility-option-hint">Aparece na lista</span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isPrivate}
                      className={`visibility-option ${isPrivate ? "visibility-option-active" : ""}`}
                      onClick={() => setIsPrivate(true)}
                    >
                      <EyeOffIcon size={18} />
                      <span className="visibility-option-title">Privada</span>
                      <span className="visibility-option-hint">Só com o link</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="room-form-col">
                <div className={`password-box ${usePassword ? "password-box-on" : ""}`}>
                  <label className="toggle-row">
                    <span className="password-box-icon">
                      <LockIcon size={16} />
                    </span>
                    <span className="toggle-row-label">
                      Proteger com senha
                      <span className="toggle-row-hint">Espectadores digitam a senha pra assistir.</span>
                    </span>
                    <span className="toggle-switch">
                      <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
                      <span className="toggle-slider" />
                    </span>
                  </label>

                  {usePassword && (
                    <div className="password-input-wrap">
                      <input
                        className="slug-input password-input"
                        type={showPassword ? "text" : "password"}
                        placeholder="Senha da sala"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        maxLength={128}
                        autoComplete="new-password"
                        autoFocus
                      />
                      <button
                        type="button"
                        className="password-reveal"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                      >
                        {showPassword ? "Ocultar" : "Mostrar"}
                      </button>
                    </div>
                  )}
                </div>

                {error && <p className="error-text">{error}</p>}

                <button
                  className="btn-primary btn-share"
                  onClick={() => start(settings, slug, { isPrivate, password: usePassword ? password : undefined })}
                  disabled={state === "starting" || passwordMissing}
                >
                  {state === "starting" ? "Iniciando..." : "Compartilhar tela"}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      <Link className="footer-link" to="/privacidade">
        Política de privacidade
      </Link>
    </div>
  );
}
