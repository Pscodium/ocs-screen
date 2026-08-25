import type { NativeTransportStartArgs } from "../../../preload/index";
import { getMaxBitrate, AUTO_FPS_TARGET, type StreamSettings } from "../types/stream";
import { listNativeMonitors } from "./nativeCapture";

// Publish via transporte nativo (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase 4) — pula
// LiveKit inteiro pro vídeo (captura → NVENC → RTP acontece 100% no processo main, em C++). Ver
// ipcMain.handle("native-transport:*") em main/index.ts.

// STUN público só pra validar o pipeline (mesmo usado nos testes isolados da Fase 4) — TURN e o
// STUN de infra própria do projeto ainda não plugados aqui (CLAUDE.md §Infraestrutura).
const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

export async function isNativeTransportAvailable(): Promise<boolean> {
  return window.screenshare.nativeTransport.isAvailable();
}

export async function startNativeTransport(
  roomId: string,
  backendUrl: string,
  monitorIndex: number,
  settings: StreamSettings,
): Promise<boolean> {
  const targetFps = settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps;
  const monitors = await listNativeMonitors();
  const monitor = monitors.find((m) => m.index === monitorIndex);
  const bitrateBps = getMaxBitrate(monitor?.width ?? 1920, monitor?.height ?? 1080, settings);

  const args: NativeTransportStartArgs = {
    roomId,
    backendUrl,
    monitorIndex,
    targetFps,
    bitrateBps,
    stunUrls: DEFAULT_STUN_URLS,
    showCursor: settings.showCursor,
    codec: settings.preferAv1 ? "av1" : settings.preferHevc ? "hevc" : "h264",
  };
  return window.screenshare.nativeTransport.start(args);
}

export async function stopNativeTransport(): Promise<void> {
  await window.screenshare.nativeTransport.stop();
}

export function onNativeTransportEnded(callback: () => void): () => void {
  return window.screenshare.nativeTransport.onEnded(callback);
}

export function onNativeTransportState(
  callback: (info: { viewerId: string; state: string; connectedCount: number }) => void,
): () => void {
  return window.screenshare.nativeTransport.onState(callback);
}

export function onNativeTransportError(callback: (message: string) => void): () => void {
  return window.screenshare.nativeTransport.onError(callback);
}

export function onNativeTransportEncoderInfo(
  callback: (info: { software: boolean; codec: "h264" | "hevc" | "av1" }) => void,
): () => void {
  return window.screenshare.nativeTransport.onEncoderInfo(callback);
}
