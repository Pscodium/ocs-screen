import type { useAppUpdater } from "../hooks/useAppUpdater";

interface UpdateModalProps {
  updater: ReturnType<typeof useAppUpdater>;
}

// `releaseNotes` NÃO é o markdown cru do corpo do release: tanto o feed do electron-updater
// (instalador) quanto o `body_html` da API do GitHub (Store, ver checkStoreUpdate no main) já vêm
// renderizados em HTML pelo próprio GitHub. Tratar como texto puro fazia aparecer tags literais
// tipo "<li>" na tela. É conteúdo do nosso próprio repo (owner/repo fixos), não input de terceiro.
function ReleaseNotes({ html }: { html: string }) {
  return <div className="update-notes" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function UpdateModal({ updater }: UpdateModalProps) {
  const { visible, phase, version, releaseNotes, percent, error, download, install, dismiss, channel, required, requiredMin } =
    updater;

  if (!visible) return null;

  const isStore = channel === "store";
  const title = required ? "Atualização obrigatória" : "Nova versão disponível";
  const targetVersion = version ?? (requiredMin && requiredMin !== "?" ? requiredMin : null);

  return (
    <div className="update-overlay">
      <div className="update-modal" role="dialog" aria-modal="true" aria-labelledby="update-modal-title">
        <div className="update-modal-header">
          <span className="update-modal-icon">{required ? "⚠️" : "⬆️"}</span>
          <div>
            <h2 id="update-modal-title">{title}</h2>
            {targetVersion && (
              <p className="update-modal-version">
                v{__APP_VERSION__} → <strong>v{targetVersion}</strong>
              </p>
            )}
          </div>
        </div>

        {required && (
          <p className="update-modal-required">
            Esta versão do app não é mais suportada. Atualize para voltar a transmitir.
          </p>
        )}

        {phase === "available" && releaseNotes && <ReleaseNotes html={releaseNotes} />}
        {phase === "available" && !releaseNotes && !required && (
          <p className="subtitle">Uma nova versão do Screen Share está pronta pra instalar.</p>
        )}
        {phase === "available" && isStore && (
          <p className="update-modal-hint">
            A atualização é feita pela Microsoft Store. Se ainda não aparecer lá, pode levar alguns dias
            para ser liberada.
          </p>
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
              {!required && (
                <button className="btn-secondary" onClick={dismiss}>
                  Agora não
                </button>
              )}
              <button className="btn-primary" onClick={download}>
                {isStore ? "Abrir Microsoft Store" : "Atualizar"}
              </button>
            </>
          )}

          {phase === "downloading" && !required && (
            <button className="btn-secondary" onClick={dismiss}>
              Continuar em segundo plano
            </button>
          )}

          {phase === "downloaded" && (
            <>
              {!required && (
                <button className="btn-secondary" onClick={dismiss}>
                  Depois
                </button>
              )}
              <button className="btn-primary" onClick={install}>
                Reiniciar e instalar
              </button>
            </>
          )}

          {phase === "error" &&
            (required ? (
              <button className="btn-primary" onClick={download}>
                {isStore ? "Abrir Microsoft Store" : "Tentar de novo"}
              </button>
            ) : (
              <button className="btn-secondary" onClick={dismiss}>
                Fechar
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
