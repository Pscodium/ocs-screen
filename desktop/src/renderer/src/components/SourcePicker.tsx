import { useEffect, useMemo, useState } from "react";
import type { CaptureSource } from "../../../preload/index";
import { isNativeCaptureAvailable } from "../services/nativeCapture";
import { SettingsAdvanced, SettingsPrimary } from "./SettingsForm";
import { AudioAppsSettings } from "./AudioAppsSettings";
import { AccessOptions, type AccessSettings } from "./AccessOptions";
import type { StreamSettings } from "../types/stream";

// `settings`/`slug` (+ callbacks) só existem no fluxo de "começar a compartilhar" (HomePage) — a
// troca de fonte ao vivo (LiveCard, `onSwapSource`) reaproveita as configurações já em uso, não
// faz sentido reconfigurar resolução/FPS/sala no meio de uma transmissão. Sem eles, a barra
// lateral só mostra o áudio da transmissão (ajustável ao vivo).
interface SourcePickerConfigurable {
  settings: StreamSettings;
  onSettingsChange: (settings: StreamSettings) => void;
  slug: string;
  onSlugChange: (slug: string) => void;
  access: AccessSettings;
  onAccessChange: (access: AccessSettings) => void;
}

type SourcePickerProps = (SourcePickerConfigurable | Partial<Record<keyof SourcePickerConfigurable, undefined>>) & {
  onSelect: (source: CaptureSource) => void;
  onCancel: () => void;
};

type Tab = "screen" | "window";

export function SourcePicker({
  settings,
  onSettingsChange,
  slug,
  onSlugChange,
  access,
  onAccessChange,
  onSelect,
  onCancel,
}: SourcePickerProps) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("screen");
  // Feedback visual imediato no clique — a track real do LiveKit só fica pronta um instante
  // depois (captura + publish), mas o tile já reage na hora pra não parecer travado.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    // A grade precisa de mais espaço que a janela normal do app — expande enquanto o seletor
    // estiver aberto, volta ao tamanho normal ao fechar (seleciona ou cancela).
    window.screenshare.window.setPickerMode(true);
    return () => window.screenshare.window.setPickerMode(false);
  }, []);

  useEffect(() => {
    // Captura nativa (DXGI) só existe pra monitor inteiro, nunca janela — marca as fontes do tipo
    // "screen" com o índice de monitor equivalente pra `capture.ts` poder decidir qual caminho
    // usar (nativo vs desktopCapturer). Ordem de enumeração de tela do Electron/Chromium e de
    // saída do DXGI (EnumOutputs) seguem a mesma ordem que o Windows expõe os monitores — testado
    // em produção com 1 monitor; setups multi-monitor caem de volta pro desktopCapturer se a
    // ordem não bater (usuário sempre pode escolher outro tile).
    Promise.all([window.screenshare.capture.listSources(), isNativeCaptureAvailable()])
      .then(([list, nativeAvailable]) => {
        let screenIndex = 0;
        const tagged = list.map((source) => {
          if (source.type === "screen" && nativeAvailable) {
            return { ...source, nativeMonitorIndex: screenIndex++ };
          }
          // Backend WGC (janela, ver docs/NATIVE_CAPTURE.md §Backend Abstrato) — HWND vem
          // embutido no id do desktopCapturer, formato "window:<hwnd>:<n>" no Windows.
          if (source.type === "window" && nativeAvailable) {
            const match = source.id.match(/^window:(-?\d+):/);
            if (match) {
              return { ...source, nativeWindowHandle: Number(match[1]) };
            }
          }
          return source;
        });
        setSources(tagged);
        if (!tagged.some((s) => s.type === "screen") && tagged.some((s) => s.type === "window")) {
          setTab("window");
        }
      })
      .catch(() => setError("Não foi possível listar telas/janelas."));
  }, []);

  const filtered = useMemo(() => sources?.filter((s) => s.type === tab) ?? [], [sources, tab]);
  const screenCount = sources?.filter((s) => s.type === "screen").length ?? 0;
  const windowCount = sources?.filter((s) => s.type === "window").length ?? 0;

  // Um clique no tile já começa a transmitir — então senha ligada e vazia é barrada aqui (senão
  // a sala nasceria sem senha, sem o usuário perceber).
  const passwordMissing = !!access && access.usePassword && access.password.trim() === "";
  const handlePick = (source: CaptureSource) => {
    if (pendingId) return;
    if (passwordMissing) {
      setError("Digite a senha da sala (ou desligue \"Proteger com senha\") antes de escolher a tela.");
      return;
    }
    setPendingId(source.id);
    onSelect(source);
  };

  return (
    <div className="picker-overlay">
      <div className="picker-modal">
        <div className="picker-header">
          <button className="picker-back" onClick={onCancel} aria-label="Voltar">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
            </svg>
            Voltar
          </button>
          <h2>Escolha o que compartilhar</h2>
          <button className="picker-close" onClick={onCancel} aria-label="Cancelar">
            &#10005;
          </button>
        </div>

        {/* Layout em 2 colunas: configurações na lateral esquerda (o que importa em evidência,
            o resto em "Avançado"), fontes à direita — cada coluna rola sozinha, lado a lado (antes
            eram dois scrolls empilhados, grade espremida pelo rodapé). */}
        <div className="picker-layout">
          <aside className="picker-sidebar">
            {settings ? (
              <>
                <section className="picker-section">
                  <h3 className="picker-section-title">Transmissão</h3>
                  <SettingsPrimary settings={settings} onChange={onSettingsChange!} />
                </section>

                <section className="picker-section">
                  <h3 className="picker-section-title">Sala</h3>
                  <label className="settings-field">
                    <span>Nome (opcional)</span>
                    <input
                      className="slug-input"
                      type="text"
                      placeholder="ex.: reuniao-time"
                      value={slug}
                      onChange={(e) => onSlugChange!(e.target.value)}
                      maxLength={32}
                    />
                  </label>
                  <AccessOptions
                    access={access!}
                    onChange={(next) => {
                      onAccessChange!(next);
                      if (error?.startsWith("Digite a senha")) setError(null);
                    }}
                  />
                </section>

                <details
                  className="picker-section picker-advanced"
                  open={advancedOpen}
                  onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
                >
                  <summary className="picker-section-title picker-advanced-summary">Avançado</summary>
                  <div className="picker-advanced-body">
                    <SettingsAdvanced settings={settings} onChange={onSettingsChange!} />
                    {settings.nativeTransport && (
                      <div className="picker-subsection">
                        <h4 className="picker-subsection-title">Áudio da transmissão</h4>
                        {advancedOpen && <AudioAppsSettings />}
                      </div>
                    )}
                  </div>
                </details>
              </>
            ) : (
              // Troca de fonte ao vivo: sem reconfigurar resolução/sala, mas dá pra ajustar quais
              // apps entram no áudio (aplica na hora na transmissão no ar).
              <section className="picker-section">
                <h3 className="picker-section-title">Áudio da transmissão</h3>
                <AudioAppsSettings />
              </section>
            )}
          </aside>

          <div className="picker-main">
            <div className="picker-tabs">
              <button
                className={`picker-tab ${tab === "screen" ? "picker-tab-active" : ""}`}
                onClick={() => setTab("screen")}
              >
                Telas {screenCount > 0 && <span className="picker-tab-count">{screenCount}</span>}
              </button>
              <button
                className={`picker-tab ${tab === "window" ? "picker-tab-active" : ""}`}
                onClick={() => setTab("window")}
              >
                Janelas {windowCount > 0 && <span className="picker-tab-count">{windowCount}</span>}
              </button>
            </div>

            {error && <p className="error-text picker-error">{error}</p>}

            <div className="picker-body">
              {!sources && !error && (
                <div className="picker-grid">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="picker-tile-skeleton" />
                  ))}
                </div>
              )}

              {sources && filtered.length === 0 && <p className="subtitle">Nada encontrado aqui.</p>}

              {sources && filtered.length > 0 && (
                <div className="picker-grid">
                  {filtered.map((source) => (
                    <SourceTile
                      key={source.id}
                      source={source}
                      pending={pendingId === source.id}
                      disabled={pendingId !== null}
                      onPick={() => handlePick(source)}
                    />
                  ))}
                </div>
              )}
            </div>
            <p className="picker-hint">Clique numa tela ou janela pra começar a transmitir.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SourceTile({
  source,
  pending,
  disabled,
  onPick,
}: {
  source: CaptureSource;
  pending: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  // Defesa extra além do filtro no main process (`capture:list-sources`, thumbnail.isEmpty()):
  // se uma miniatura ainda assim vier corrompida/vazia, o navegador desenharia o ícone de imagem
  // quebrada + o `alt` como texto solto por cima do card (não respeita object-fit/overflow do
  // container). Troca por um placeholder controlado (ícone do app se tiver, senão a inicial do
  // nome) — igual ao "sem preview" que o Discord mostra pra esses casos.
  const [thumbnailBroken, setThumbnailBroken] = useState(false);

  return (
    <button
      className={`picker-tile ${pending ? "picker-tile-pending" : ""}`}
      onClick={onPick}
      disabled={disabled}
    >
      <div className="picker-thumbnail-wrap">
        {thumbnailBroken ? (
          <div className="picker-thumbnail picker-thumbnail-fallback">
            {source.appIconDataUrl ? (
              <img src={source.appIconDataUrl} alt="" className="picker-thumbnail-fallback-icon" />
            ) : (
              <span>{source.name.charAt(0).toUpperCase()}</span>
            )}
          </div>
        ) : (
          <img
            src={source.thumbnailDataUrl}
            alt=""
            className="picker-thumbnail"
            onError={() => setThumbnailBroken(true)}
          />
        )}
        {!thumbnailBroken && source.appIconDataUrl && (
          <img src={source.appIconDataUrl} alt="" className="picker-app-icon" />
        )}
        {pending && (
          <div className="picker-tile-spinner">
            <span className="spinner" />
          </div>
        )}
      </div>
      <span className="picker-tile-label" title={source.name}>
        {source.name}
      </span>
    </button>
  );
}
