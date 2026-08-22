import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface CaptureSource {
  id: string;
  name: string;
  type: "screen" | "window";
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

export interface UpdateAvailableInfo {
  version: string;
  releaseNotes: string | null;
}

export interface UpdateDownloadProgress {
  percent: number;
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
};

export type ScreenShareApi = typeof api;

contextBridge.exposeInMainWorld("screenshare", api);
