import { TrayIcon } from "@tauri-apps/api/tray";

// A bandeja é criada no boot via tauri.conf.json (app.trayIcon, id padrão "main") — aqui só
// atualizamos o tooltip pra refletir o status da transmissão.
export async function setTrayStatus(isLive: boolean, viewerCount?: number): Promise<void> {
  const tray = await TrayIcon.getById("main");
  if (!tray) return;

  await tray.setTooltip(
    isLive ? `ScreenShare — ao vivo (${viewerCount ?? 0} espectador${viewerCount === 1 ? "" : "es"})` : "ScreenShare",
  );
}
