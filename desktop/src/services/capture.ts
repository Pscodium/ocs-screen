import { RESOLUTION_CONSTRAINTS, type StreamSettings } from "../types/stream";

export interface CaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
}

// getDisplayMedia no MVP; captura nativa Rust fica p/ Fase 4 (CLAUDE.md §Captura de tela).
export async function captureScreen(settings: StreamSettings): Promise<CaptureResult> {
  const resolution = settings.resolution === "auto" ? undefined : RESOLUTION_CONSTRAINTS[settings.resolution];
  const frameRate = settings.fps === "auto" ? undefined : settings.fps;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: resolution ? { ideal: resolution.width } : undefined,
      height: resolution ? { ideal: resolution.height } : undefined,
      frameRate: frameRate ? { ideal: frameRate } : undefined,
    },
    audio: false,
  });

  const [track] = stream.getVideoTracks();
  // Parâmetros solicitados não são garantia — sempre checar capacidades reais (CLAUDE.md §Captura de tela).
  const actualSettings = track.getSettings();

  return { stream, settings: actualSettings };
}

export function stopCapture(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}
