import { useEffect, useMemo, useState } from "react";
import type { CaptureSource } from "../../../preload/index";
import { isNativeCaptureAvailable } from "../services/nativeCapture";
import { SettingsForm } from "./SettingsForm";
import type { StreamSettings } from "../types/stream";

// `settings`/`slug` (+ callbacks) só existem no fluxo de "começar a compartilhar" (HomePage) — a
// troca de fonte ao vivo (LiveCard, `onSwapSource`) reaproveita as configurações já em uso, não
// faz sentido reconfigurar resolução/FPS/sala no meio de uma transmissão. Omitir os 4 juntos
// esconde o rodapé de configuração inteiro (`showSettingsFooter` computado a partir disso).
interface SourcePickerConfigurable {
  settings: StreamSettings;
  onSettingsChange: (settings: StreamSettings) => void;
  slug: string;
  onSlugChange: (slug: string) => void;
}

type SourcePickerProps = (SourcePickerConfigurable | Partial<Record<keyof SourcePickerConfigurable, undefined>>) & {
  onSelect: (source: CaptureSource) => void;
  onCancel: () => void;
};

type Tab = "screen" | "window";

export function SourcePicker({ settings, onSettingsChange, slug, onSlugChange, onSelect, onCancel }: SourcePickerProps) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("screen");
  // Feedback visual imediato no clique — a track real do LiveKit só fica pronta um instante
  // depois (captura + publish), mas o tile já reage na hora pra não parecer travado.
  const [pendingId, setPendingId] = useState<string | null>(null);

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

  const handlePick = (source: CaptureSource) => {
    if (pendingId) return;
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

        {error && <p className="error-text">{error}</p>}

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

        {/* Qualidade/FPS/sala vivem aqui, junto da escolha de fonte — uma tela só, como o mockup
            original de CLAUDE.md (Monitor/Janela/Qualidade/FPS juntos). Evita repetir esse formulário
            numa segunda janela de tamanho fixo e diferente (era a causa do "quebra o tamanho da
            tela": HomePage cramava tudo isso numa janela 440×720 fixa e não-redimensionável). */}
        {settings && (
          <div className="picker-footer">
            <SettingsForm settings={settings} onChange={onSettingsChange!} compact />

            <label className="settings-field room-slug-field">
              <span>Nome da sala (opcional)</span>
              <input
                className="slug-input"
                type="text"
                placeholder="ex.: reuniao-time"
                value={slug}
                onChange={(e) => onSlugChange!(e.target.value)}
                maxLength={32}
              />
            </label>
          </div>
        )}
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
