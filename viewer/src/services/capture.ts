import { AUTO_FPS_TARGET, RESOLUTION_CONSTRAINTS, type StreamSettings } from "../types/stream";

export interface CaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
  hasAudio: boolean;
}

export async function captureScreen(settings: StreamSettings): Promise<CaptureResult> {
  const resolution = settings.resolution === "auto" ? undefined : RESOLUTION_CONSTRAINTS[settings.resolution];
  // "Automático" manda um alvo real (AUTO_FPS_TARGET) em vez de nenhum hint — mesmo raciocínio
  // do capture.ts do desktop: "automático" deve ser "um bom padrão", não "sem controle nenhum".
  const frameRate = settings.fps === "auto" ? AUTO_FPS_TARGET : settings.fps;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: resolution ? { ideal: resolution.width } : undefined,
      height: resolution ? { ideal: resolution.height } : undefined,
      frameRate: { ideal: frameRate },
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
