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

// Exatamente um de `monitorIndex`/`hwnd` — monitor inteiro (DXGI) ou janela específica (WGC, ver
// docs/NATIVE_CAPTURE.md §Backend Abstrato / WindowCaptureCore.h). `capture.ts`/`SourcePicker`
// decidem qual mandar (`nativeMonitorIndex` só existe em fonte tipo "screen", `nativeWindowHandle`
// só em "window").
export async function startNativeTransport(
  roomId: string,
  backendUrl: string,
  source: { monitorIndex?: number; hwnd?: number },
  settings: StreamSettings,
): Promise<boolean> {
  const targetFps = settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps;
  // Bitrate calculado pela resolução real só é possível pra monitor (dá pra listar antes de
  // iniciar); janela não tem tamanho conhecido de antemão no lado do renderer — usa o mesmo
  // fallback 1920×1080 que monitor não-encontrado já usava.
  let width = 1920;
  let height = 1080;
  if (source.monitorIndex !== undefined) {
    const monitors = await listNativeMonitors();
    const monitor = monitors.find((m) => m.index === source.monitorIndex);
    if (monitor) {
      width = monitor.width;
      height = monitor.height;
    }
  }
  const bitrateBps = getMaxBitrate(width, height, settings);

  const args: NativeTransportStartArgs = {
    roomId,
    backendUrl,
    monitorIndex: source.monitorIndex,
    hwnd: source.hwnd,
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

export async function setNativeCursorEnabled(enabled: boolean): Promise<void> {
  await window.screenshare.nativeTransport.setCursorEnabled(enabled);
}

// Troca de fonte ao vivo — `source` é o mesmo formato de `startNativeTransport` (monitor OU
// janela). `showCursor` reaplica a preferência atual (a fonte nova começa sem cursor configurado).
export async function swapNativeTransportSource(
  source: { monitorIndex?: number; hwnd?: number },
  showCursor: boolean,
): Promise<boolean> {
  return window.screenshare.nativeTransport.swapSource({ ...source, showCursor });
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
