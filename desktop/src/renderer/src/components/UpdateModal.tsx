import type { useAppUpdater } from "../hooks/useAppUpdater";

interface UpdateModalProps {
  updater: ReturnType<typeof useAppUpdater>;
}

// `releaseNotes` do electron-updater (provider GitHub) NÃO é o markdown cru do corpo do release —
// o feed Atom do GitHub (releases.atom) já vem com o conteúdo renderizado em HTML pelo próprio
// GitHub (mesmo motor que renderiza a página do release). Tratar como texto puro fazia aparecer
// tags literais tipo "<li>" na tela em vez de um bullet de verdade. É conteúdo do nosso próprio
// repo (owner/repo fixos em electron-builder.yml), não input de terceiro — seguro renderizar direto.
function ReleaseNotes({ html }: { html: string }) {
  return <div className="update-notes" dangerouslySetInnerHTML={{ __html: html }} />;
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

        {phase === "available" && releaseNotes && <ReleaseNotes html={releaseNotes} />}
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
