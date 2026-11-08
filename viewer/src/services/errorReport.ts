// Erros JS não tratados do site → backend (POST /crash/js, backend/src/routes/crash.ts), listados
// no painel /admin como "js / web". Limite por aba pra um erro em loop não inundar o banco.
// Nunca lança.

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";
const MAX_REPORTS_PER_PAGE = 3;

let sent = 0;
const seen = new Set<string>();

function report(message: string): void {
  if (import.meta.env.DEV || sent >= MAX_REPORTS_PER_PAGE) return;
  const key = message.slice(0, 200);
  if (seen.has(key)) return;
  seen.add(key);
  sent++;
  try {
    void fetch(`${backendUrl}/crash/js`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appVersion: __APP_VERSION__,
        processType: "web",
        message: `${message}\n\nURL: ${location.pathname}\nUA: ${navigator.userAgent}`.slice(0, 8000),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignora
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return String(value);
}

export function installErrorReporting(): void {
  window.addEventListener("error", (event) => {
    // Erro de carregamento de recurso (img/script) não tem `error` — ignora, não é bug do código.
    if (!event.error && !event.message) return;
    report(describe(event.error ?? event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    report(`[unhandledRejection] ${describe(event.reason)}`);
  });
}
