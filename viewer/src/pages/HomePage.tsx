import { useEffect, useState } from "react";
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

// Navegador não expõe o nome do usuário do SO (o app desktop usa os.userInfo()).
// Equivalente no web: opção (ligada por padrão) de reusar o último nome de sala digitado neste navegador.
const LAST_SLUG_KEY = "ocs:lastRoomSlug";
const REMEMBER_SLUG_PREF_KEY = "ocs:rememberRoomSlug";

function readRememberPref(): boolean {
  try {
    return localStorage.getItem(REMEMBER_SLUG_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeRememberPref(on: boolean): void {
  try {
    localStorage.setItem(REMEMBER_SLUG_PREF_KEY, on ? "1" : "0");
    if (!on) localStorage.removeItem(LAST_SLUG_KEY);
  } catch {
    // storage bloqueado: preferência não persiste
  }
}

function loadLastSlug(): string {
  if (!readRememberPref()) return "";
  try {
    return localStorage.getItem(LAST_SLUG_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastSlug(slug: string): void {
  try {
    if (slug.trim()) localStorage.setItem(LAST_SLUG_KEY, slug.trim());
    else localStorage.removeItem(LAST_SLUG_KEY);
  } catch {
    // storage bloqueado: só não lembra
  }
}

export function HomePage() {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState(loadLastSlug);
  const [rememberSlug, setRememberSlug] = useState(readRememberPref);
  const [isPrivate, setIsPrivate] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordMissing = usePassword && password.trim() === "";
  const [tab, setTab] = useState<Tab>("share");
  const [roomCount, setRoomCount] = useState<number | null>(null);
  const { state, info, error, start, stop, optimizeCodec, optimizingCodec } = useBroadcast();
  const isLive = state === "live" && info !== null;

  // Ao vivo: título da aba mostra o estado e fechar/recarregar a aba pede confirmação — fechar
  // encerra a transmissão pra todo mundo.
  useEffect(() => {
    if (!isLive) return;
    const previous = document.title;
    document.title = "🔴 Ao vivo • Screen Share";
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.title = previous;
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [isLive]);

  return (
    <div className="home-page">
      <header className="home-header">
        <h1>
          Screen Share <span className="app-version">v{__APP_VERSION__}</span>
        </h1>
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
                <div className="settings-field">
                  <div className="settings-field-header">
                    <label htmlFor="room-slug">Nome da sala</label>
                    <label
                      className="mini-toggle"
                      title="Reusa o último nome de sala que você digitou. Lembrado neste navegador."
                    >
                      Usar sempre este nome
                      <span className="toggle-switch toggle-switch-sm">
                        <input
                          type="checkbox"
                          checked={rememberSlug}
                          onChange={(e) => {
                            setRememberSlug(e.target.checked);
                            writeRememberPref(e.target.checked);
                          }}
                        />
                        <span className="toggle-slider" />
                      </span>
                    </label>
                  </div>
                  <span className="slug-input-group">
                    <span className="slug-input-prefix">/s/</span>
                    <input
                      id="room-slug"
                      className="slug-input"
                      type="text"
                      placeholder="gerado automaticamente"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      maxLength={32}
                    />
                  </span>
                </div>

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
                  onClick={() => {
                    if (rememberSlug) saveLastSlug(slug);
                    void start(settings, slug, { isPrivate, password: usePassword ? password : undefined });
                  }}
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
