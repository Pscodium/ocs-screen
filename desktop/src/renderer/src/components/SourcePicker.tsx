import { useEffect, useMemo, useState } from "react";
import type { CaptureSource } from "../../../preload/index";

interface SourcePickerProps {
  onSelect: (source: CaptureSource) => void;
  onCancel: () => void;
}

type Tab = "screen" | "window";

export function SourcePicker({ onSelect, onCancel }: SourcePickerProps) {
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
    window.screenshare.capture
      .listSources()
      .then((list) => {
        setSources(list);
        if (!list.some((s) => s.type === "screen") && list.some((s) => s.type === "window")) {
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
  return (
    <button
      className={`picker-tile ${pending ? "picker-tile-pending" : ""}`}
      onClick={onPick}
      disabled={disabled}
    >
      <div className="picker-thumbnail-wrap">
        <img src={source.thumbnailDataUrl} alt={source.name} className="picker-thumbnail" />
        {source.appIconDataUrl && <img src={source.appIconDataUrl} alt="" className="picker-app-icon" />}
        {pending && (
          <div className="picker-tile-spinner">
            <span className="spinner" />
          </div>
        )}
      </div>
      <span className="picker-tile-label">{source.name}</span>
    </button>
  );
}
