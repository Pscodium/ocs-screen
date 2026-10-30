import { useState } from "react";
import { Link } from "react-router-dom";
import { SettingsForm } from "../components/SettingsForm";
import { LiveCard } from "../components/LiveCard";
import { RoomsBrowser } from "../components/RoomsBrowser";
import { useBroadcast } from "../hooks/useBroadcast";
import { defaultStreamSettings } from "../types/stream";

type Tab = "share" | "watch";

export function HomePage() {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordMissing = usePassword && password.trim() === "";
  const [tab, setTab] = useState<Tab>("share");
  const { state, info, error, start, stop, optimizeCodec, optimizingCodec } = useBroadcast();

  if (state === "live" && info) {
    return (
      <LiveCard info={info} onStop={stop} onOptimizeCodec={optimizeCodec} optimizingCodec={optimizingCodec} />
    );
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

            <div className="access-options">
              <label className="toggle-row">
                <span className="toggle-row-label">
                  Sala privada
                  <span className="toggle-row-hint">Não aparece na lista — só entra quem tiver o link.</span>
                </span>
                <span className="toggle-switch">
                  <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                  <span className="toggle-slider" />
                </span>
              </label>

              <label className="toggle-row">
                <span className="toggle-row-label">
                  Proteger com senha
                  <span className="toggle-row-hint">Espectadores precisam digitar a senha pra assistir.</span>
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
              className="btn-primary"
              onClick={() => start(settings, slug, { isPrivate, password: usePassword ? password : undefined })}
              disabled={state === "starting" || passwordMissing}
            >
              {state === "starting" ? "Iniciando..." : "Compartilhar tela"}
            </button>

            <p className="share-audio-hint">
              Pra transmitir som, ligue "Compartilhar também áudio do sistema" no diálogo do navegador.
            </p>
          </>
        ) : (
          <RoomsBrowser />
        )}
      </div>

      <Link className="footer-link" to="/privacidade">
        Política de privacidade
      </Link>
    </div>
  );
}
