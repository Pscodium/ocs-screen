import { contextBridge, ipcRenderer } from "electron";

export interface CaptureSource {
  id: string;
  name: string;
  type: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

const api = {
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
    close: () => ipcRenderer.send("window:close"),
    setWidgetMode: (isLive: boolean) => ipcRenderer.send("window:set-widget-mode", isLive),
    setPickerMode: (open: boolean) => ipcRenderer.send("window:set-picker-mode", open),
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
};

export type ScreenShareApi = typeof api;

contextBridge.exposeInMainWorld("screenshare", api);
