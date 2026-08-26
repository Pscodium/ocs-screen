import type { NativeTransportStartArgs } from "../../../preload/index";
import { getMaxBitrate, AUTO_FPS_TARGET, type StreamSettings } from "../types/stream";
import { listNativeMonitors } from "./nativeCapture";

// Publish via transporte nativo (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase 4) — pula
// LiveKit inteiro pro vídeo (captura → NVENC → RTP acontece 100% no processo main, em C++). Ver
// ipcMain.handle("native-transport:*") em main/index.ts.

// Fallback se o backend não responder (offline, versão antiga sem a rota) — mesmo STUN público
// que era hardcoded antes do TURN existir.
const FALLBACK_STUN_URLS = ["stun:stun.l.google.com:19302"];

interface IceServerDescriptor {
  urls: string;
  username?: string;
  credential?: string;
}

// libdatachannel entende URL única no formato "turn:user:pass@host:port" (constructor de string
// do `rtc::IceServer`, ver TransportCore.cpp) — diferente do formato estruturado
// `{urls, username, credential}` que `RTCPeerConnection` do navegador usa (viewer, ver
// services/backend.ts). O USERNAME gerado pelo backend (`services/turn.ts`) tem um ':' literal
// dentro dele (formato REST API do coturn, "<timestamp>:id") — sem escapar, o parser de URL do
// libdatachannel quebraria ali pensando que é o separador user:pass. `encodeURIComponent` (e o
// `url_decode` correspondente do lado do libdatachannel) resolve isso.
function toLibdatachannelUrl(server: IceServerDescriptor): string {
  if (!server.username || !server.credential) return server.urls;
  const match = server.urls.match(/^(turns?):(.+)$/);
  if (!match) return server.urls;
  const [, scheme, rest] = match;
  return `${scheme}:${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@${rest}`;
}

// Busca STUN+TURN de verdade (infra própria, ver docker-compose.yml/backend `services/turn.ts`)
// — cai pro STUN público se o backend não tiver TURN configurado ou estiver inacessível (nunca
// bloqueia o início da transmissão por causa disso, mesmo espírito de qualquer outro fallback
// deste projeto).
async function fetchIceServerUrls(backendUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${backendUrl}/ice-servers`);
    if (!res.ok) return FALLBACK_STUN_URLS;
    const data = (await res.json()) as { iceServers: IceServerDescriptor[] };
    if (!data.iceServers?.length) return FALLBACK_STUN_URLS;
    return data.iceServers.map(toLibdatachannelUrl);
  } catch {
    return FALLBACK_STUN_URLS;
  }
}

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
  const stunUrls = await fetchIceServerUrls(backendUrl);

  const args: NativeTransportStartArgs = {
    roomId,
    backendUrl,
    monitorIndex: source.monitorIndex,
    hwnd: source.hwnd,
    targetFps,
    bitrateBps,
    stunUrls,
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
