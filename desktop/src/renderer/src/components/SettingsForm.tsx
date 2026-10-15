import { FPS_OPTIONS, QUALITY_OPTIONS, RESOLUTION_OPTIONS, type StreamSettings } from "../types/stream";

// Configurações de transmissão do seletor de fonte, em duas partes (barra lateral do SourcePicker):
// - `SettingsPrimary`: o que muda a cara da transmissão e todo mundo mexe (resolução, FPS,
//   qualidade) — sempre visível.
// - `SettingsAdvanced`: ajustes finos e de diagnóstico (texto nítido, cursor, pipeline/codec) —
//   dentro de "Avançado".

interface SettingsProps {
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

export function SettingsPrimary({ settings, onChange }: SettingsProps) {
  return (
    <>
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

      <div className="settings-pair">
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
      </div>
    </>
  );
}

export function SettingsAdvanced({ settings, onChange }: SettingsProps) {
  return (
    <>
      <label className="toggle-row">
        <span className="toggle-row-label">
          Melhorar texto
          <span className="toggle-row-hint">
            {settings.sharpText ? "Nítido, mas desliga pra jogos" : "Código/documentos parados"}
          </span>
        </span>
        <span className="toggle-switch">
          <input type="checkbox" checked={settings.sharpText} onChange={(e) => onChange({ ...settings, sharpText: e.target.checked })} />
          <span className="toggle-slider" />
        </span>
      </label>

      <label className="toggle-row">
        <span className="toggle-row-label">
          Mostrar cursor
          <span className="toggle-row-hint">Dá pra ligar/desligar ao vivo no widget</span>
        </span>
        <span className="toggle-switch">
          <input type="checkbox" checked={settings.showCursor} onChange={(e) => onChange({ ...settings, showCursor: e.target.checked })} />
          <span className="toggle-slider" />
        </span>
      </label>

      <label className="toggle-row">
        <span className="toggle-row-label">
          Pipeline nativo
          <span className="toggle-row-hint">Captura + encoder NVENC próprios (recomendado com GPU NVIDIA)</span>
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

      {/* Sempre no DOM — só a altura anima via grid-template-rows (0fr↔1fr), sem empurrar o resto
          de golpe ao ligar/desligar "Pipeline nativo". */}
      <div className={`settings-advanced-extra ${settings.nativeTransport ? "settings-advanced-extra-open" : ""}`}>
        <div className="settings-advanced-extra-inner">
          <label className="toggle-row">
            <span className="toggle-row-label">
              Usar HEVC
              <span className="toggle-row-hint">Mais qualidade na mesma banda. Cai pra H.264 sozinho se algum espectador não suportar</span>
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
              Usar AV1
              <span className="toggle-row-hint">Só GPU NVIDIA RTX 40+ — nas outras transmite H.264</span>
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
    </>
  );
}
