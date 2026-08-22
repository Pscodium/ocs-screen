import type { useAppUpdater } from "../hooks/useAppUpdater";

interface UpdateModalProps {
  updater: ReturnType<typeof useAppUpdater>;
}

// Changelog vem como markdown puro do corpo do release do GitHub — não vale a pena trazer uma
// lib de markdown só pra isso; um render linha-a-linha (bullet pra "-"/"*", resto como parágrafo)
// cobre o formato que qualquer changelog normal usa.
function ReleaseNotes({ text }: { text: string }) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    <ul className="update-notes">
      {lines.map((line, i) => (
        <li key={i}>{line.replace(/^[-*]\s*/, "")}</li>
      ))}
    </ul>
  );
}

export function UpdateModal({ updater }: UpdateModalProps) {
  const { visible, phase, version, releaseNotes, percent, error, download, install, dismiss } = updater;

  if (!visible) return null;

  return (
    <div className="update-overlay">
      <div className="update-modal">
        <div className="update-modal-header">
          <span className="update-modal-icon">⬆️</span>
          <div>
            <h2>Nova versão disponível</h2>
            {version && <p className="update-modal-version">v{version}</p>}
          </div>
        </div>

        {phase === "available" && releaseNotes && <ReleaseNotes text={releaseNotes} />}
        {phase === "available" && !releaseNotes && (
          <p className="subtitle">Uma nova versão do Screen Share está pronta pra instalar.</p>
        )}

        {phase === "downloading" && (
          <div className="update-progress">
            <div className="update-progress-bar">
              <div className="update-progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="update-progress-label">Baixando... {percent}%</span>
          </div>
        )}

        {phase === "downloaded" && (
          <p className="subtitle">Atualização baixada. Reinicie pra aplicar — é rápido.</p>
        )}

        {phase === "error" && <p className="error-text">{error ?? "Falha ao atualizar."}</p>}

        <div className="update-modal-actions">
          {phase === "available" && (
            <>
              <button className="btn-secondary" onClick={dismiss}>
                Agora não
              </button>
              <button className="btn-primary" onClick={download}>
                Atualizar
              </button>
            </>
          )}

          {phase === "downloading" && (
            <button className="btn-secondary" onClick={dismiss}>
              Continuar em segundo plano
            </button>
          )}

          {phase === "downloaded" && (
            <>
              <button className="btn-secondary" onClick={dismiss}>
                Depois
              </button>
              <button className="btn-primary" onClick={install}>
                Reiniciar e instalar
              </button>
            </>
          )}

          {phase === "error" && (
            <button className="btn-secondary" onClick={dismiss}>
              Fechar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
