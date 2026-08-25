import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface CaptureSource {
  id: string;
  name: string;
  type: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  // Preenchido no renderer (SourcePicker), não aqui — índice do monitor equivalente pra captura
  // nativa via DXGI (ver services/nativeCapture.ts). DXGI Desktop Duplication só captura monitor
  // inteiro, nunca janela, por isso isso nunca é setado pra type: "window".
  nativeMonitorIndex?: number;
}

export interface UpdateAvailableInfo {
  version: string;
  releaseNotes: string | null;
}

export interface UpdateDownloadProgress {
  percent: number;
}

export interface NativeMonitor {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeTransportStartArgs {
  roomId: string;
  backendUrl: string;
  monitorIndex: number;
  targetFps: number;
  bitrateBps: number;
  stunUrls: string[];
  showCursor: boolean;
  // Opcional (padrão "h264") — PEDIDO, não garantia (cascata de fallback interna pode degradar
  // pra H.264, e o viewer pode não conseguir decodificar HEVC/AV1 — ver `onEncoderInfo`).
  codec?: "h264" | "hevc" | "av1";
}

export interface NativeCaptureStats {
  // Frames de fato entregues no último segundo — distinto do fps que o LiveKit reporta (esse é
  // do lado de captura, antes do encoder; útil pra diferenciar "captura tá lenta" de "encoder tá
  // gargalando" quando o fps geral cai).
  fps: number;
  // Tentativas de `AcquireNextFrame` que estouraram o timeout sem frame novo — normal em tela
  // parada, só vira sinal de problema se aparecer junto com fps baixo em tela em movimento.
  timeouts: number;
}

const api = {
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
    close: () => ipcRenderer.send("window:close"),
    setWidgetMode: (isLive: boolean) => ipcRenderer.send("window:set-widget-mode", isLive),
    setPickerMode: (open: boolean) => ipcRenderer.send("window:set-picker-mode", open),
    setWatchMode: (watching: boolean) => ipcRenderer.send("window:set-watch-mode", watching),
  },
  tray: {
    setStatus: (isLive: boolean, viewerCount: number) => ipcRenderer.send("tray:set-status", isLive, viewerCount),
  },
  clipboard: {
    writeText: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write-text", text),
  },
  capture: {
    listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke("capture:list-sources"),
  },
  updater: {
    onAvailable: (callback: (info: UpdateAvailableInfo) => void) => {
      const listener = (_event: IpcRendererEvent, info: UpdateAvailableInfo) => callback(info);
      ipcRenderer.on("update:available", listener);
      return () => ipcRenderer.removeListener("update:available", listener);
    },
    onDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => {
      const listener = (_event: IpcRendererEvent, progress: UpdateDownloadProgress) => callback(progress);
      ipcRenderer.on("update:download-progress", listener);
      return () => ipcRenderer.removeListener("update:download-progress", listener);
    },
    onDownloaded: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("update:downloaded", listener);
      return () => ipcRenderer.removeListener("update:downloaded", listener);
    },
    onError: (callback: (message: string) => void) => {
      const listener = (_event: IpcRendererEvent, message: string) => callback(message);
      ipcRenderer.on("update:error", listener);
      return () => ipcRenderer.removeListener("update:error", listener);
    },
    download: () => ipcRenderer.send("update:download"),
    install: () => ipcRenderer.send("update:install"),
  },
  // Captura nativa (DXGI Desktop Duplication) — ver docs/NATIVE_CAPTURE.md. Frames não passam
  // pela ponte de IPC normal — só start/stop/listMonitors. O `MessagePort` em si NÃO atravessa o
  // contextBridge como argumento de callback (não é confiável fazer isso, mesmo sendo um dos
  // tipos "especiais"); em vez disso, `window.postMessage` mais abaixo entrega o port direto pro
  // mundo principal via `transfer`, que é o jeito documentado pelo Electron de fazer essa ponte.
  nativeCapture: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke("native-capture:available"),
    listMonitors: (): Promise<NativeMonitor[]> => ipcRenderer.invoke("native-capture:list-monitors"),
    start: (monitorIndex: number, targetFps: number) => ipcRenderer.send("native-capture:start", monitorIndex, targetFps),
    stop: () => ipcRenderer.send("native-capture:stop"),
    setCursorEnabled: (enabled: boolean) => ipcRenderer.send("native-capture:set-cursor-enabled", enabled),
    onError: (callback: (message: string) => void) => {
      const listener = (_event: IpcRendererEvent, message: string) => callback(message);
      ipcRenderer.on("native-capture:error", listener);
      return () => ipcRenderer.removeListener("native-capture:error", listener);
    },
    onStats: (callback: (stats: NativeCaptureStats) => void) => {
      const listener = (_event: IpcRendererEvent, stats: NativeCaptureStats) => callback(stats);
      ipcRenderer.on("native-capture:stats", listener);
      return () => ipcRenderer.removeListener("native-capture:stats", listener);
    },
  },
  // Transporte nativo (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase 4) — publish opt-in que
  // pula LiveKit pro vídeo. Ver ipcMain.handle("native-transport:*") em main/index.ts.
  nativeTransport: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke("native-transport:available"),
    start: (args: NativeTransportStartArgs): Promise<boolean> => ipcRenderer.invoke("native-transport:start", args),
    stop: (): Promise<void> => ipcRenderer.invoke("native-transport:stop"),
    // `viewerId` identifica de qual sessão é o evento (1 por espectador, ver
    // docs/NATIVE_CAPTURE.md Fase 4 "SFU"); `connectedCount` é quantos espectadores estão
    // conectados AGORA no total — usado pro contador no LiveCard.
    onState: (callback: (info: { viewerId: string; state: string; connectedCount: number }) => void) => {
      const listener = (_event: IpcRendererEvent, info: { viewerId: string; state: string; connectedCount: number }) =>
        callback(info);
      ipcRenderer.on("native-transport:state", listener);
      return () => ipcRenderer.removeListener("native-transport:state", listener);
    },
    onEnded: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on("native-transport:ended", listener);
      return () => ipcRenderer.removeListener("native-transport:ended", listener);
    },
    onError: (callback: (message: string) => void) => {
      const listener = (_event: IpcRendererEvent, message: string) => callback(message);
      ipcRenderer.on("native-transport:error", listener);
      return () => ipcRenderer.removeListener("native-transport:error", listener);
    },
    // Avisa se o encoder caiu pro fallback de software (Media Foundation) por NVENC indisponível
    // e/ou o codec ativo (pode ter degradado de HEVC pra H.264, ver docs/NATIVE_CAPTURE.md Fase 3
    // "Fallback de encoder por software"/"HEVC"). Dispara de novo se reiniciar em H.264 porque o
    // viewer não conseguiu decodificar HEVC.
    onEncoderInfo: (callback: (info: { software: boolean; codec: "h264" | "hevc" | "av1" }) => void) => {
      const listener = (_event: IpcRendererEvent, info: { software: boolean; codec: "h264" | "hevc" | "av1" }) =>
        callback(info);
      ipcRenderer.on("native-transport:encoder", listener);
      return () => ipcRenderer.removeListener("native-transport:encoder", listener);
    },
  },
};

// Fora do objeto exposto por contextBridge de propósito — encaminha o MessagePort recebido do
// main process pro mundo principal (onde o React roda) via `window.postMessage` com transfer
// list. `window.postMessage` é uma API de DOM padrão, atravessa o isolamento de contexto do
// Electron de verdade (diferente de tentar devolver o port como argumento de uma função exposta
// pelo contextBridge, que não entrega o port utilizável do outro lado).
ipcRenderer.on("native-capture:port", (event) => {
  window.postMessage("native-capture:port", "*", event.ports);
});

export type ScreenShareApi = typeof api;

contextBridge.exposeInMainWorld("screenshare", api);
