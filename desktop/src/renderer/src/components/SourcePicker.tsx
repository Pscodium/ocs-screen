import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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

// Ao vivo: só a checagem barata de janelas abertas (relista quando muda). Fora do ar: relista tudo
// (atualiza também as miniaturas de tela — sem transmissão, o custo na thread main não importa).
const POLL_LIVE_MS = 1000;
const POLL_IDLE_MS = 2000;

// Captura nativa: telas ganham o índice de monitor equivalente (DXGI — ordem de enumeração do
// Electron/Chromium e do EnumOutputs é a mesma que o Windows expõe; testado com 1 monitor,
// multi-monitor cai de volta pro desktopCapturer se não bater) e janelas o HWND, que vem embutido
// no id do desktopCapturer ("window:<hwnd>:<n>" no Windows) — ver capture.ts/docs/NATIVE_CAPTURE.md.
function tagSources(list: CaptureSource[], nativeAvailable: boolean): CaptureSource[] {
  let screenIndex = 0;
  return list.map((source) => {
    if (source.type === "screen" && nativeAvailable) return { ...source, nativeMonitorIndex: screenIndex++ };
    if (source.type === "window" && nativeAvailable) {
      const match = source.id.match(/^window:(-?\d+):/);
      if (match) return { ...source, nativeWindowHandle: Number(match[1]) };
    }
    return source;
  });
}

// Mantém a ordem que o usuário já está vendo (tile não pula de lugar a cada atualização): atualiza
// as que continuam, some com as fechadas, novas vão pro fim. `keepScreens` = a lista nova só tem
// janelas (atualização ao vivo), as telas anteriores ficam como estão.
function mergeSources(prev: CaptureSource[] | null, fresh: CaptureSource[], keepScreens: boolean): CaptureSource[] {
  if (!prev) return fresh;
  const byId = new Map(fresh.map((s) => [s.id, s]));
  const kept = prev.flatMap((s) => {
    if (keepScreens && s.type === "screen") return [s];
    const next = byId.get(s.id);
    return next ? [next] : [];
  });
  const known = new Set(prev.map((s) => s.id));
  return [...kept, ...fresh.filter((s) => !known.has(s.id))];
}

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
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let knownWindows = "";
    // Ao vivo (troca de fonte = sem `settings`), relistar só JANELAS — relistar telas pausa a
    // captura nativa de monitor por um instante (ver preload `listSources`).
    const live = !settings;

    // Janela aberta/fechada com o seletor aberto aparece/some sozinha (antes a lista era montada
    // uma vez: janela nova só aparecia saindo e voltando). Relistar (`getSources`) trava a thread
    // main ~50ms — numa transmissão no ar isso é engasgo no vídeo —, então só relista quando a
    // lista barata de janelas de topo mudou. As miniaturas de janela são ao vivo à parte (DWM,
    // `useLiveThumbnails`); as de tela ficam fixas ao vivo, e fora dele são refeitas junto.
    const load = async (first: boolean) => {
      try {
        const [list, nativeAvailable] = await Promise.all([
          window.screenshare.capture.listSources(first || !live ? undefined : { windowsOnly: true }),
          isNativeCaptureAvailable(),
        ]);
        if (cancelled) return;
        const fresh = tagSources(list, nativeAvailable);
        setSources((prev) => mergeSources(prev, fresh, !first && live));
        if (first && !fresh.some((s) => s.type === "screen") && fresh.some((s) => s.type === "window")) {
          setTab("window");
        }
      } catch {
        if (first && !cancelled) setError("Não foi possível listar telas/janelas.");
      }
    };
    const poll = async () => {
      try {
        const windows = (await window.screenshare.capture.topLevelWindows()).sort((x, y) => x - y).join(",");
        if (cancelled) return;
        const changed = windows !== knownWindows;
        knownWindows = windows;
        if (changed || !live) await load(false);
      } finally {
        if (!cancelled) timer = setTimeout(poll, live ? POLL_LIVE_MS : POLL_IDLE_MS);
      }
    };
    load(true).then(() => window.screenshare.capture.topLevelWindows()).then((w) => {
      if (cancelled) return;
      knownWindows = w.sort((x, y) => x - y).join(",");
      timer = setTimeout(poll, live ? POLL_LIVE_MS : POLL_IDLE_MS);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `settings` só decide o modo (ao vivo ou não) — não reinicia a cada mudança de configuração.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bodyRef = useRef<HTMLDivElement>(null);
  useLiveThumbnails(bodyRef, tab === "window" && pendingId === null, sources);

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

            <div className="picker-body" ref={bodyRef}>
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
      <div className="picker-thumbnail-wrap" data-live-hwnd={source.nativeWindowHandle}>
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

// Miniaturas AO VIVO das janelas: o DWM desenha o conteúdo atual de cada janela por cima do tile
// (ver addon.cpp `ThumbnailsUpdate`) — aqui só informa onde cada tile está (pixels físicos da área
// cliente) e a área visível do corpo rolável, sempre que algo pode ter mexido no layout. A
// miniatura estática continua embaixo (aparece se o DWM não registrar a janela).
function useLiveThumbnails(bodyRef: RefObject<HTMLDivElement | null>, enabled: boolean, sources: CaptureSource[] | null) {
  useEffect(() => {
    const body = bodyRef.current;
    const clear = () => window.screenshare.capture.setLiveThumbnails([], { x: 0, y: 0, w: 0, h: 0 });
    if (!enabled || !body) {
      clear();
      return;
    }
    let frame = 0;
    const send = () => {
      frame = 0;
      const dpr = window.devicePixelRatio;
      const clipRect = body.getBoundingClientRect();
      const items = [...body.querySelectorAll<HTMLElement>("[data-live-hwnd]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { hwnd: Number(el.dataset.liveHwnd), x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr };
      });
      window.screenshare.capture.setLiveThumbnails(items, {
        x: clipRect.left * dpr,
        y: clipRect.top * dpr,
        w: clipRect.width * dpr,
        h: clipRect.height * dpr,
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };
    schedule();
    body.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(body);
    // Janela redimensionando (seletor abrindo) e fontes mudando de tamanho — rede de segurança.
    const interval = setInterval(schedule, 500);
    return () => {
      body.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      clearInterval(interval);
      if (frame) cancelAnimationFrame(frame);
      clear();
    };
  }, [bodyRef, enabled, sources]);
}
