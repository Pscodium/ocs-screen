import { app, crashReporter } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync } from "fs";

// Relatórios de crash enviados ao backend (backend/src/routes/crash.ts):
// - crash NATIVO (Crashpad: access violation no addon/GPU/renderer) → minidump via POST /crash
// - exceção JS não tratada no processo main → POST /crash/js
// Preferência "Enviar relatórios de erro" no menu da bandeja, ligada por padrão (avisado na
// política de privacidade). Só envia em build empacotado — dev nunca polui os números de produção.
// Com o envio desligado, o dump continua salvo localmente (`app.getPath("crashDumps")`).

// `envPrefix` do main em electron.vite.config.ts expõe essa variável aqui.
const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";
const canUpload = app.isPackaged;

function settingsPath(): string {
  return join(app.getPath("userData"), "crash-settings.json");
}

let uploadEnabled = loadUploadEnabled();

function loadUploadEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf-8")) as { uploadEnabled?: unknown };
    if (typeof parsed.uploadEnabled === "boolean") return parsed.uploadEnabled;
  } catch {
    // primeira execução ou arquivo corrompido — padrão ligado
  }
  return true;
}

// Precisa rodar antes de app.whenReady() (Crashpad tem que estar de pé antes dos processos filhos).
export function startCrashReporter(): void {
  crashReporter.start({
    submitURL: `${backendUrl}/crash`,
    uploadToServer: canUpload && uploadEnabled,
    // Backend recebe multipart puro — sem gzip no corpo.
    compress: false,
  });
  console.log("[crash-reporter] dumps salvos em:", app.getPath("crashDumps"), "| envio:", canUpload && uploadEnabled);
}

export function isCrashUploadEnabled(): boolean {
  return uploadEnabled;
}

export function setCrashUploadEnabled(enabled: boolean): void {
  uploadEnabled = enabled;
  crashReporter.setUploadToServer(canUpload && enabled);
  try {
    writeFileSync(settingsPath(), JSON.stringify({ uploadEnabled: enabled }, null, 2));
  } catch (err) {
    console.error("[crash-reporter] falha ao salvar preferência:", err);
  }
}

// Melhor esforço, com prazo curto: chamado logo antes de `app.exit(1)`, não pode segurar o
// fechamento do app. Nunca lança.
export async function reportJsCrash(message: string): Promise<void> {
  if (!canUpload || !uploadEnabled) return;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 1500);
  try {
    await fetch(`${backendUrl}/crash/js`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appVersion: app.getVersion(), processType: "browser", message: message.slice(0, 8000) }),
      signal: abort.signal,
    });
  } catch {
    // ignora
  } finally {
    clearTimeout(timeout);
  }
}
