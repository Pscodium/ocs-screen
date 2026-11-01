import { useState } from "react";
import { EyeOffIcon, GlobeIcon, LockIcon } from "./Icons";

// Acesso à sala criada pela transmissão — mesmo fluxo e visual do viewer web (viewer/src/pages/HomePage.tsx):
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
    <>
      <div className="settings-field">
        <span>Visibilidade</span>
        <div className="visibility-options" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={!access.isPrivate}
            className={`visibility-option ${!access.isPrivate ? "visibility-option-active" : ""}`}
            onClick={() => onChange({ ...access, isPrivate: false })}
          >
            <GlobeIcon size={17} />
            <span className="visibility-option-title">Pública</span>
            <span className="visibility-option-hint">Aparece na lista</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={access.isPrivate}
            className={`visibility-option ${access.isPrivate ? "visibility-option-active" : ""}`}
            onClick={() => onChange({ ...access, isPrivate: true })}
          >
            <EyeOffIcon size={17} />
            <span className="visibility-option-title">Privada</span>
            <span className="visibility-option-hint">Só com o link</span>
          </button>
        </div>
      </div>

      <div className={`password-box ${access.usePassword ? "password-box-on" : ""}`}>
        <label className="toggle-row">
          <span className="password-box-icon">
            <LockIcon size={15} />
          </span>
          <span className="toggle-row-label">
            Proteger com senha
            <span className="toggle-row-hint">Espectadores digitam a senha pra assistir.</span>
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
              className="text-input password-input"
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
    </>
  );
}
