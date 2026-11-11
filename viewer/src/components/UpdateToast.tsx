import { useEffect, useState } from "react";

// Aviso de versão nova do site: compara o `version.json` publicado (gerado no build, ver
// vite.config.ts) com a versão desta página. Nunca recarrega sozinho — quem está assistindo
// perderia a transmissão; só oferece o botão.

const CHECK_INTERVAL_MS = 5 * 60_000;

async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

export function UpdateToast() {
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      const deployed = await fetchDeployedVersion();
      if (!stopped && deployed && deployed !== __APP_VERSION__) setNewVersion(deployed);
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!newVersion || dismissed === newVersion) return null;
  return (
    <div className="update-toast" role="status">
      <span>Nova versão do site disponível ({newVersion}).</span>
      <button className="update-toast-reload" onClick={() => window.location.reload()}>
        Recarregar
      </button>
      <button className="update-toast-close" aria-label="Fechar" onClick={() => setDismissed(newVersion)}>
        ×
      </button>
    </div>
  );
}
