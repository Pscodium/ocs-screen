import { RESOLUTION_CONSTRAINTS, type StreamSettings } from "../types/stream";

export interface CaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
  hasAudio: boolean;
}

export async function captureScreen(settings: StreamSettings): Promise<CaptureResult> {
  const resolution = settings.resolution === "auto" ? undefined : RESOLUTION_CONSTRAINTS[settings.resolution];
  const frameRate = settings.fps === "auto" ? undefined : settings.fps;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: resolution ? { ideal: resolution.width } : undefined,
      height: resolution ? { ideal: resolution.height } : undefined,
      frameRate: frameRate ? { ideal: frameRate } : undefined,
    },
    // Sempre pede áudio — o navegador exige confirmação separada (switch no próprio diálogo de
    // seleção), então não tem custo pedir por padrão.
    audio: true,
  });

  const [track] = stream.getVideoTracks();

  // Não fixo por padrão (testado em produção: piora stutter/frame drop em jogos — ver
  // docs/INSIGHTS-ENCODER.md #1) — vira opt-in via toggle "Melhorar texto" nas configurações.
  if (settings.sharpText) {
    track.contentHint = "text";
  }

  const actualSettings = track.getSettings();

  return { stream, settings: actualSettings, hasAudio: stream.getAudioTracks().length > 0 };
}

export function stopCapture(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}
