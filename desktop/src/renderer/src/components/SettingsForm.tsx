import { FPS_OPTIONS, QUALITY_OPTIONS, RESOLUTION_OPTIONS, type StreamSettings } from "../types/stream";

interface SettingsFormProps {
  settings: StreamSettings;
  onChange: (settings: StreamSettings) => void;
  // Usado no rodapé do SourcePicker: resolução/FPS/qualidade viram uma linha de 3 colunas em vez
  // de empilhados, já que ali disputam espaço com a grade de fontes.
  compact?: boolean;
}

const resolutionLabels: Record<string, string> = {
  auto: "Automática",
  "720p": "720p",
  "1080p": "1080p Full HD",
  "1440p": "1440p",
  "2160p": "2160p 4K",
};

const qualityLabels: Record<string, string> = {
  auto: "Automática",
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  max: "Máxima",
};

export function SettingsForm({ settings, onChange, compact }: SettingsFormProps) {
  return (
    <div className={`settings-form ${compact ? "settings-form-row" : ""}`}>
      <label className="settings-field">
        <span>Resolução</span>
        <select
          value={settings.resolution}
          onChange={(e) => onChange({ ...settings, resolution: e.target.value as StreamSettings["resolution"] })}
        >
          {RESOLUTION_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {resolutionLabels[option]}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span>FPS</span>
        <select
          value={settings.fps}
          onChange={(e) =>
            onChange({
              ...settings,
              fps: e.target.value === "auto" ? "auto" : (Number(e.target.value) as StreamSettings["fps"]),
            })
          }
        >
          {FPS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option === "auto" ? "Automático" : `${option} FPS`}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span>Qualidade</span>
        <select
          value={settings.quality}
          onChange={(e) => onChange({ ...settings, quality: e.target.value as StreamSettings["quality"] })}
        >
          {QUALITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {qualityLabels[option]}
            </option>
          ))}
        </select>
      </label>

      <label className="toggle-row">
        <span className="toggle-row-label">
          Melhorar texto
          <span className="toggle-row-hint">
            {settings.sharpText ? "Nítido, mas desliga pra jogos" : "Código/documentos parados"}
          </span>
        </span>
        <span className="toggle-switch">
          <input
            type="checkbox"
            checked={settings.sharpText}
            onChange={(e) => onChange({ ...settings, sharpText: e.target.checked })}
          />
          <span className="toggle-slider" />
        </span>
      </label>

      <label className="toggle-row">
        <span className="toggle-row-label">
          Mostrar cursor
          <span className="toggle-row-hint">Só afeta captura de tela inteira (monitor)</span>
        </span>
        <span className="toggle-switch">
          <input
            type="checkbox"
            checked={settings.showCursor}
            onChange={(e) => onChange({ ...settings, showCursor: e.target.checked })}
          />
          <span className="toggle-slider" />
        </span>
      </label>

      <details className="settings-advanced">
        <summary className="settings-advanced-summary">Avançado</summary>

        <label className="toggle-row">
          <span className="toggle-row-label">
            Pipeline nativo (beta)
            <span className="toggle-row-hint">
              Encode NVENC nativo em vez do encoder por software do navegador — só monitor, sem
              troca de fonte ao vivo ainda
            </span>
          </span>
          <span className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.nativeTransport}
              onChange={(e) => onChange({ ...settings, nativeTransport: e.target.checked })}
            />
            <span className="toggle-slider" />
          </span>
        </label>

        {/* Sempre no DOM (não condicional) — só a altura anima via grid-template-rows (0fr↔1fr).
            Antes essas 2 linhas entravam/saíam de repente ao ligar "Pipeline nativo", empurrando
            o resto do formulário (e o botão "Compartilhar tela" embaixo) de golpe. */}
        <div className={`settings-advanced-extra ${settings.nativeTransport ? "settings-advanced-extra-open" : ""}`}>
          <div className="settings-advanced-extra-inner">
            <label className="toggle-row">
              <span className="toggle-row-label">
                Usar HEVC (beta)
                <span className="toggle-row-hint">
                  Só com pipeline nativo. Cai pra H.264 sozinho se a GPU/navegador do espectador não
                  suportar
                </span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.preferHevc}
                  onChange={(e) => onChange({ ...settings, preferHevc: e.target.checked, preferAv1: false })}
                />
                <span className="toggle-slider" />
              </span>
            </label>

            <label className="toggle-row">
              <span className="toggle-row-label">
                Usar AV1 (beta)
                <span className="toggle-row-hint">
                  Só com pipeline nativo. Precisa de GPU NVIDIA RTX 40+ pra encoder por hardware
                  (raro) — cai pra H.264 sozinho se a GPU/navegador do espectador não suportar
                </span>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.preferAv1}
                  onChange={(e) => onChange({ ...settings, preferAv1: e.target.checked, preferHevc: false })}
                />
                <span className="toggle-slider" />
              </span>
            </label>
          </div>
        </div>
      </details>
    </div>
  );
}
