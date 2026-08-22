import { FPS_OPTIONS, QUALITY_OPTIONS, RESOLUTION_OPTIONS, type StreamSettings } from "../types/stream";

interface SettingsFormProps {
  settings: StreamSettings;
  onChange: (settings: StreamSettings) => void;
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

export function SettingsForm({ settings, onChange }: SettingsFormProps) {
  return (
    <div className="settings-form">
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

      <p className="settings-hint">
        No diálogo que abrir a seguir, ligue o botão "Compartilhar também áudio do sistema" se quiser transmitir som
        — o navegador exige essa confirmação separada, não dá pra pular.
      </p>
    </div>
  );
}
