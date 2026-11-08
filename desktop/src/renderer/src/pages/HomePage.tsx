import { useCallback, useEffect, useState } from "react";
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

// Preferência "usar meu nome do Windows como nome da sala" — só neste computador (localStorage), opt-in.
const USER_NAME_PREF_KEY = "ocs.useWindowsName";

function readUserNamePref(): boolean {
  try {
    return localStorage.getItem(USER_NAME_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeUserNamePref(on: boolean): void {
  try {
    localStorage.setItem(USER_NAME_PREF_KEY, on ? "1" : "0");
  } catch {
    // storage indisponível — a opção só não fica lembrada
  }
}

// Aba "Configuração": apelido + "mostrar meu nome no aviso do Discord" — só neste PC
// (localStorage). Mostrar o nome é opt-in: o padrão é o aviso sair sem nome.
const NICKNAME_KEY = "ocs.nickname";
const ANNOUNCE_NAME_KEY = "ocs.announceName";
const MAX_NICKNAME_LENGTH = 32;

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage indisponível — só não fica lembrado
  }
}

interface ProfileSettingsProps {
  nickname: string;
  onNicknameChange: (value: string) => void;
  announceName: boolean;
  onAnnounceNameChange: (on: boolean) => void;
  open: boolean;
}

function ProfileSettings({ nickname, onNicknameChange, announceName, onAnnounceNameChange, open }: ProfileSettingsProps) {
  const [discordStatus, setDiscordStatus] = useState<"idle" | "loading" | "missing">("idle");

  const fillFromDiscord = useCallback(
    async (silent: boolean) => {
      setDiscordStatus("loading");
      const name = await window.screenshare.system.discordUserName().catch(() => null);
      if (name) {
        onNicknameChange(name.slice(0, MAX_NICKNAME_LENGTH));
        setDiscordStatus("idle");
      } else {
        setDiscordStatus(silent ? "idle" : "missing");
      }
    },
    [onNicknameChange],
  );

  // Sem apelido ainda: ao abrir a aba, sugere o nome do Discord (só preenche o campo local — nada
  // sai do PC enquanto "Mostrar meu nome" estiver desligado).
  useEffect(() => {
    if (open && nickname.trim() === "") void fillFromDiscord(true);
  }, [open]);

  return (
    <>
      <div className="settings-field">
        <label htmlFor="host-nickname">Apelido</label>
        <div className="nickname-row">
          <input
            id="host-nickname"
            className="text-input"
            type="text"
            placeholder="Como você quer aparecer"
            value={nickname}
            maxLength={MAX_NICKNAME_LENGTH}
            onChange={(e) => onNicknameChange(e.target.value)}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={discordStatus === "loading"}
            onClick={() => void fillFromDiscord(false)}
            title="Preenche com o nome da sua conta do Discord aberta neste PC"
          >
            {discordStatus === "loading" ? "Buscando..." : "Usar do Discord"}
          </button>
        </div>
        {discordStatus === "missing" && (
          <span className="toggle-row-hint">Discord não encontrado — abra o app do Discord ou digite o apelido.</span>
        )}
      </div>
      <label className="toggle-row">
        <span className="toggle-row-label">
          Mostrar meu nome no aviso do Discord
          <span className="toggle-row-hint">
            {announceName && nickname.trim() === ""
              ? "Digite um apelido — sem ele o aviso sai sem nome."
              : "Seu apelido aparece na DM que o bot manda pros inscritos."}
          </span>
        </span>
        <span className="toggle-switch">
          <input type="checkbox" checked={announceName} onChange={(e) => onAnnounceNameChange(e.target.checked)} />
          <span className="toggle-slider" />
        </span>
      </label>
    </>
  );
}

// Mesmas regras do backend (`normalizeSlug`/`isValidSlug`): minúsculas, números e hífen, 3–32.
function userNameToSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // "João" → "joao"
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}

export function HomePage({ broadcast, rooms, tab, onTabChange, suspended }: HomePageProps) {
  const [settings, setSettings] = useState(defaultStreamSettings);
  const [slug, setSlug] = useState("");
  const [useUserName, setUseUserName] = useState(readUserNamePref);
  const [userSlug, setUserSlug] = useState("");
  useEffect(() => {
    void window.screenshare.system.userName().then((name) => setUserSlug(userNameToSlug(name)));
  }, []);
  const userNameUsable = userSlug.length >= 3;
  const effectiveSlug = useUserName && userNameUsable ? userSlug : slug;
  const [access, setAccess] = useState<AccessSettings>(defaultAccessSettings);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [nickname, setNickname] = useState(() => readStored(NICKNAME_KEY));
  const [announceName, setAnnounceName] = useState(() => readStored(ANNOUNCE_NAME_KEY) === "1");
  const handleNicknameChange = useCallback((value: string) => {
    setNickname(value);
    writeStored(NICKNAME_KEY, value);
  }, []);
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
    start(settings, source, effectiveSlug, {
      isPrivate: access.isPrivate,
      password: access.usePassword ? access.password : undefined,
      hostName: announceName ? nickname.trim() || undefined : undefined,
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
              <div className="settings-field">
                <div className="settings-field-header">
                  <label htmlFor="room-slug">Nome da sala</label>
                  {userNameUsable && (
                    <label
                      className="mini-toggle"
                      title="Usa o nome do seu perfil do Windows no link. Fica visível pra quem vê a sala. Lembrado neste PC."
                    >
                      Meu nome do Windows
                      <span className="toggle-switch toggle-switch-sm">
                        <input
                          type="checkbox"
                          checked={useUserName}
                          onChange={(e) => {
                            setUseUserName(e.target.checked);
                            writeUserNamePref(e.target.checked);
                          }}
                        />
                        <span className="toggle-slider" />
                      </span>
                    </label>
                  )}
                </div>
                <span className="slug-input-group">
                  <span className="slug-input-prefix">/s/</span>
                  <input
                    id="room-slug"
                    className="slug-input"
                    type="text"
                    placeholder="gerado automaticamente"
                    value={effectiveSlug}
                    onChange={(e) => setSlug(e.target.value)}
                    readOnly={useUserName && userNameUsable}
                    maxLength={32}
                  />
                </span>
              </div>
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
              open={configOpen}
              onToggle={(e) => setConfigOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary className="setup-section-title setup-advanced-summary">Configuração</summary>
              <div className="setup-advanced-body">
                <ProfileSettings
                  nickname={nickname}
                  onNicknameChange={handleNicknameChange}
                  announceName={announceName}
                  onAnnounceNameChange={(on) => {
                    setAnnounceName(on);
                    writeStored(ANNOUNCE_NAME_KEY, on ? "1" : "0");
                  }}
                  open={configOpen}
                />
              </div>
            </details>

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
