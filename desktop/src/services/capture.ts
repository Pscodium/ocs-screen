import { RESOLUTION_CONSTRAINTS, type StreamSettings } from "../types/stream";

export interface CaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
  hasAudio: boolean;
  stopAll: () => void;
}

// getDisplayMedia no MVP; captura nativa Rust fica p/ Fase 4 (CLAUDE.md §Captura de tela).
// `onSourceEnded` dispara quando o usuário clica em "Parar compartilhamento" no diálogo nativo
// do navegador/SO.
export async function captureScreen(
  settings: StreamSettings,
  onSourceEnded?: () => void,
): Promise<CaptureResult> {
  const resolution = settings.resolution === "auto" ? undefined : RESOLUTION_CONSTRAINTS[settings.resolution];
  const frameRate = settings.fps === "auto" ? undefined : settings.fps;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: resolution ? { ideal: resolution.width } : undefined,
      height: resolution ? { ideal: resolution.height } : undefined,
      frameRate: frameRate ? { ideal: frameRate } : undefined,
    },
    // Sempre pede áudio — o navegador exige confirmação separada (switch no próprio diálogo de
    // seleção), então não tem custo pedir por padrão; só disponível de fato ao compartilhar "Tela
    // inteira" na maioria dos navegadores/SO, janela específica pode não entregar a track.
    audio: true,
  });

  const [videoTrack] = stream.getVideoTracks();
  // Parâmetros solicitados não são garantia — sempre checar capacidades reais (CLAUDE.md §Captura de tela).
  const actualSettings = videoTrack.getSettings();
  const hasAudio = stream.getAudioTracks().length > 0;
  if (onSourceEnded) videoTrack.onended = onSourceEnded;

  return {
    stream,
    settings: actualSettings,
    hasAudio,
    stopAll: () => {
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
