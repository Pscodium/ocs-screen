import { useState } from "react";

// Acesso à sala criada pela transmissão — mesmo fluxo do viewer web (viewer/src/pages/HomePage.tsx):
// "privada" some da lista pública de transmissões, "senha" faz o espectador digitar antes de
// assistir (o backend guarda só o hash e confere no token/WS de sinalização).
export interface AccessSettings {
  isPrivate: boolean;
  usePassword: boolean;
  password: string;
}

export const defaultAccessSettings: AccessSettings = { isPrivate: false, usePassword: false, password: "" };

interface AccessOptionsProps {
  access: AccessSettings;
  onChange: (access: AccessSettings) => void;
}

export function AccessOptions({ access, onChange }: AccessOptionsProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="access-options">
      <label className="toggle-row">
        <span className="toggle-row-label">
          Sala privada
          <span className="toggle-row-hint">Não aparece na lista — só entra quem tiver o link.</span>
        </span>
        <span className="toggle-switch">
          <input type="checkbox" checked={access.isPrivate} onChange={(e) => onChange({ ...access, isPrivate: e.target.checked })} />
          <span className="toggle-slider" />
        </span>
      </label>

      <label className="toggle-row">
        <span className="toggle-row-label">
          Proteger com senha
          <span className="toggle-row-hint">Espectadores precisam digitar a senha pra assistir.</span>
        </span>
        <span className="toggle-switch">
          <input
            type="checkbox"
            checked={access.usePassword}
            onChange={(e) => onChange({ ...access, usePassword: e.target.checked })}
          />
          <span className="toggle-slider" />
        </span>
      </label>

      {access.usePassword && (
        <div className="password-input-wrap">
          <input
            className="slug-input password-input"
            type={showPassword ? "text" : "password"}
            placeholder="Senha da sala"
            value={access.password}
            onChange={(e) => onChange({ ...access, password: e.target.value })}
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
  );
}
