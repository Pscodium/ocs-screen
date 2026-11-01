import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CaptureSource } from "../../../preload/index";
import { isNativeCaptureAvailable } from "../services/nativeCapture";
import { AudioAppsSettings } from "./AudioAppsSettings";
import { AppWindowIcon, MonitorIcon } from "./Icons";

type Tab = "screen" | "window";
type Scope = "all" | Tab;

// Checagem barata de janelas abertas (EnumWindows no main) — só relista janelas quando ela muda.
const POLL_WINDOWS_MS = 1500;
// Miniaturas de tela (fora do ar): refeitas de tempos em tempos só com a aba "Telas" visível. As de
// janela já são ao vivo pelo DWM (`useLiveThumbnails`), não precisam de relistagem periódica.
const SCREEN_REFRESH_MS = 4000;

// Captura nativa: telas ganham o índice de monitor equivalente (DXGI — ordem de enumeração do
// Electron/Chromium e do EnumOutputs é a mesma que o Windows expõe; testado com 1 monitor,
// multi-monitor cai de volta pro desktopCapturer se não bater) e janelas o HWND, que vem embutido
// no id do desktopCapturer ("window:<hwnd>:<n>" no Windows) — ver capture.ts/docs/NATIVE_CAPTURE.md.
// O índice de monitor depende da ordem da lista completa de telas — por isso só listas que contêm
// TODAS as telas (escopo "all" ou "screen") passam por aqui com telas.
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
// as que continuam, some com as fechadas, novas vão pro fim. Fontes fora do `scope` relistado ficam
// intactas (mesmo objeto — o tile memoizado nem re-renderiza).
function mergeSources(prev: CaptureSource[] | null, fresh: CaptureSource[], scope: Scope): CaptureSource[] {
  if (!prev) return fresh;
  const inScope = (s: CaptureSource) => scope === "all" || s.type === scope;
  const byId = new Map(fresh.map((s) => [s.id, s]));
  const kept = prev.flatMap((s) => {
    if (!inScope(s)) return [s];
    const next = byId.get(s.id);
    return next ? [next] : [];
  });
  const known = new Set(prev.map((s) => s.id));
  return [...kept, ...fresh.filter((s) => !known.has(s.id))];
}

// Lista de telas/janelas do seletor. `getSources` trava a thread main enquanto tira as miniaturas
// (numa transmissão no ar isso é engasgo no vídeo), então nada aqui relista à toa:
// - janelas: só quando a lista barata de janelas de topo muda;
// - telas: só fora do ar, com a aba "Telas" visível, a cada SCREEN_REFRESH_MS (ao vivo, relistar
//   telas pausa a captura nativa de monitor — ver main `capture:list-sources`);
// - nada com `active` falso (outra aba do app, modal por cima) ou com a janela escondida/minimizada.
function useCaptureSources(active: boolean, live: boolean, tab: Tab, onFirstLoad: (sources: CaptureSource[]) => void) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(active);
  const tabRef = useRef(tab);
  activeRef.current = active;
  tabRef.current = tab;
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let knownWindows: string | null = null;
    let lastScreens = Date.now();
    let busy = false;

    const load = async (scope: Scope) => {
      const options = scope === "window" ? { windowsOnly: true } : scope === "screen" ? { screensOnly: true } : undefined;
      const [list, nativeAvailable] = await Promise.all([
        window.screenshare.capture.listSources(options),
        isNativeCaptureAvailable(),
      ]);
      if (cancelled) return;
      const fresh = tagSources(list, nativeAvailable);
      setSources((prev) => mergeSources(prev, fresh, scope));
      if (scope !== "window") lastScreens = Date.now();
      return fresh;
    };

    const tick = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (busy || cancelled) return;
      busy = true;
      try {
        if (activeRef.current && !document.hidden) {
          const windows = (await window.screenshare.capture.topLevelWindows()).sort((x, y) => x - y).join(",");
          if (cancelled) return;
          if (knownWindows !== null && windows !== knownWindows) await load("window");
          knownWindows = windows;
          if (!live && tabRef.current === "screen" && Date.now() - lastScreens >= SCREEN_REFRESH_MS) await load("screen");
        }
      } catch {
        // Falha pontual de relistagem — mantém o que já está na tela e tenta no próximo ciclo.
      } finally {
        busy = false;
        if (!cancelled) timer = setTimeout(tick, POLL_WINDOWS_MS);
      }
    };
    wakeRef.current = () => {
      // Volta a ficar visível/ativo: força miniatura de tela nova no próximo ciclo, que roda já.
      lastScreens = 0;
      tick();
    };

    busy = true;
    load("all")
      .then((fresh) => {
        if (fresh) onFirstLoad(fresh);
        return window.screenshare.capture.topLevelWindows();
      })
      .then((w) => {
        knownWindows = w.sort((x, y) => x - y).join(",");
      })
      .catch(() => {
        if (!cancelled) setError("Não foi possível listar telas/janelas.");
      })
      .finally(() => {
        busy = false;
        if (!cancelled) timer = setTimeout(tick, POLL_WINDOWS_MS);
      });

    const onVisibility = () => {
      if (!document.hidden && activeRef.current) wakeRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Monta uma vez — `active`/`tab` são lidos por ref a cada ciclo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  // Reativou (voltou pra aba de transmitir, modal fechou) — atualiza sem esperar o próximo ciclo.
  useEffect(() => {
    if (active) wakeRef.current();
  }, [active]);

  return { sources, error };
}

interface SourceBrowserProps {
  // Falso com outra aba do app por cima: para relistagem e miniaturas ao vivo (o DWM desenha por
  // cima de tudo, inclusive de modais).
  active: boolean;
  // Troca de fonte ao vivo — não relista telas (ver useCaptureSources).
  live?: boolean;
  // Fonte que está iniciando (spinner no tile, demais bloqueados).
  pendingId: string | null;
  onPick: (source: CaptureSource) => void;
  footer?: ReactNode;
}

export function SourceBrowser({ active, live = false, pendingId, onPick, footer }: SourceBrowserProps) {
  const [tab, setTab] = useState<Tab>("screen");
  const onFirstLoad = useCallback((fresh: CaptureSource[]) => {
    if (!fresh.some((s) => s.type === "screen") && fresh.some((s) => s.type === "window")) setTab("window");
  }, []);
  const { sources, error } = useCaptureSources(active, live, tab, onFirstLoad);

  const bodyRef = useRef<HTMLDivElement>(null);
  useLiveThumbnails(bodyRef, active && tab === "window" && pendingId === null, sources);

  const filtered = useMemo(() => sources?.filter((s) => s.type === tab) ?? [], [sources, tab]);
  const screenCount = sources?.filter((s) => s.type === "screen").length ?? 0;
  const windowCount = sources?.filter((s) => s.type === "window").length ?? 0;

  // Callback estável pros tiles memoizados — senão todos re-renderizam a cada atualização.
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const handlePick = useCallback((source: CaptureSource) => pickRef.current(source), []);

  return (
    <div className="source-browser">
      <div className="source-browser-head">
        <h2 className="source-browser-title">Escolha o que compartilhar</h2>
        <div className="segmented" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "screen"}
            className={`segmented-btn ${tab === "screen" ? "segmented-btn-active" : ""}`}
            onClick={() => setTab("screen")}
          >
            <MonitorIcon size={15} />
            Telas
            {screenCount > 0 && <span className="segmented-count">{screenCount}</span>}
          </button>
          <button
            role="tab"
            aria-selected={tab === "window"}
            className={`segmented-btn ${tab === "window" ? "segmented-btn-active" : ""}`}
            onClick={() => setTab("window")}
          >
            <AppWindowIcon size={15} />
            Janelas
            {windowCount > 0 && <span className="segmented-count">{windowCount}</span>}
          </button>
        </div>
      </div>

      {error && <p className="error-text source-browser-error">{error}</p>}

      <div className="source-browser-body" ref={bodyRef}>
        {!sources && !error && (
          <div className={`source-grid source-grid-${tab}`}>
            {Array.from({ length: tab === "screen" ? 2 : 6 }).map((_, i) => (
              <div key={i} className="source-tile-skeleton" />
            ))}
          </div>
        )}

        {sources && filtered.length === 0 && (
          <div className="empty-state">
            <p className="empty-state-title">Nada encontrado aqui.</p>
            <p className="empty-state-hint">
              {tab === "window" ? "Abra a janela que quer mostrar — ela aparece aqui sozinha." : "Nenhum monitor disponível."}
            </p>
          </div>
        )}

        {sources && filtered.length > 0 && (
          <div className={`source-grid source-grid-${tab}`}>
            {filtered.map((source) => (
              <SourceTile
                key={source.id}
                source={source}
                pending={pendingId === source.id}
                disabled={pendingId !== null}
                onPick={handlePick}
              />
            ))}
          </div>
        )}
      </div>
      {footer}
    </div>
  );
}

const SourceTile = memo(function SourceTile({
  source,
  pending,
  disabled,
  onPick,
}: {
  source: CaptureSource;
  pending: boolean;
  disabled: boolean;
  onPick: (source: CaptureSource) => void;
}) {
  // Defesa extra além do filtro no main process (`capture:list-sources`, thumbnail.isEmpty()):
  // se uma miniatura ainda assim vier corrompida/vazia, o navegador desenharia o ícone de imagem
  // quebrada + o `alt` como texto solto por cima do card (não respeita object-fit/overflow do
  // container). Troca por um placeholder controlado (ícone do app se tiver, senão a inicial do
  // nome) — igual ao "sem preview" que o Discord mostra pra esses casos.
  const [thumbnailBroken, setThumbnailBroken] = useState(false);

  return (
    <button
      className={`source-tile ${pending ? "source-tile-pending" : ""}`}
      onClick={() => onPick(source)}
      disabled={disabled}
    >
      <div className="source-thumb" data-live-hwnd={source.nativeWindowHandle}>
        {thumbnailBroken ? (
          <div className="source-thumb-img source-thumb-fallback">
            {source.appIconDataUrl ? (
              <img src={source.appIconDataUrl} alt="" className="source-thumb-fallback-icon" />
            ) : (
              <span>{source.name.charAt(0).toUpperCase()}</span>
            )}
          </div>
        ) : (
          <img
            src={source.thumbnailDataUrl}
            alt=""
            className="source-thumb-img"
            decoding="async"
            draggable={false}
            onError={() => setThumbnailBroken(true)}
          />
        )}
        <span className="source-thumb-cta">{pending ? "Iniciando..." : "Transmitir"}</span>
        {pending && (
          <div className="source-thumb-spinner">
            <span className="spinner" />
          </div>
        )}
      </div>
      <span className="source-tile-label" title={source.name}>
        {source.appIconDataUrl ? (
          <img src={source.appIconDataUrl} alt="" className="source-tile-icon" draggable={false} />
        ) : source.type === "screen" ? (
          <MonitorIcon size={14} />
        ) : (
          <AppWindowIcon size={14} />
        )}
        <span className="source-tile-name">{source.name}</span>
      </span>
    </button>
  );
});

interface SourcePickerProps {
  onSelect: (source: CaptureSource) => void;
  onCancel: () => void;
}

// Troca de fonte AO VIVO (aberto pelo widget): sobrepõe tudo, expande a janela e reaproveita as
// configurações já em uso — só dá pra ajustar quais apps entram no áudio (aplica na hora).
export function SourcePicker({ onSelect, onCancel }: SourcePickerProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    window.screenshare.window.setPickerMode(true);
    return () => window.screenshare.window.setPickerMode(false);
  }, []);

  return (
    <div className="picker-overlay">
      <div className="picker-header">
        <button className="picker-back" onClick={onCancel}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
          </svg>
          Voltar pra transmissão
        </button>
      </div>
      <div className="setup-layout">
        <aside className="setup-sidebar">
          <section className="setup-section">
            <h3 className="setup-section-title">Áudio da transmissão</h3>
            <AudioAppsSettings />
          </section>
        </aside>
        <SourceBrowser
          active
          live
          pendingId={pendingId}
          onPick={(source) => {
            if (pendingId) return;
            setPendingId(source.id);
            onSelect(source);
          }}
          footer={<p className="source-browser-hint">A troca é instantânea pros espectadores — a sala e o link continuam os mesmos.</p>}
        />
      </div>
    </div>
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
    let lastSent = "";
    const send = () => {
      frame = 0;
      const dpr = window.devicePixelRatio;
      const clipRect = body.getBoundingClientRect();
      const items = [...body.querySelectorAll<HTMLElement>("[data-live-hwnd]")].map((el) => {
        const r = el.getBoundingClientRect();
        return { hwnd: Number(el.dataset.liveHwnd), x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr };
      });
      const clip = { x: clipRect.left * dpr, y: clipRect.top * dpr, w: clipRect.width * dpr, h: clipRect.height * dpr };
      // A rede de segurança abaixo chama isso a cada 500ms — sem mudança, nem atravessa o IPC.
      const key = JSON.stringify([items, clip]);
      if (key === lastSent) return;
      lastSent = key;
      window.screenshare.capture.setLiveThumbnails(items, clip);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };
    schedule();
    body.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(body);
    // Janela redimensionando e fontes mudando de tamanho — rede de segurança.
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
