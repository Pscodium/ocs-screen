import { RESOLUTION_CONSTRAINTS, type StreamSettings } from "../types/stream";
import type { CaptureSource } from "../../../preload/index";

export interface CaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
  hasAudio: boolean;
  stopAll: () => void;
}

// Constraints com `mandatory`/`chromeMediaSource` são uma extensão proprietária do Chromium/
// Electron, fora da spec padrão de MediaTrackConstraints — por isso o cast. É o que o Electron
// expõe no lugar do getDisplayMedia() pra resolver o stream a partir de um id do desktopCapturer.
//
// Sem maxWidth/maxHeight/maxFrameRate de propósito: o backend WGC (Windows.Graphics.Capture, é
// o que o Chromium usa por baixo do desktopCapturer hoje) trava em retry infinito com
// E_INVALIDARG quando esses limites não batem exatamente com a fonte (ex.: monitor com refresh
// rate diferente do fps pedido) — a promise do getUserMedia nunca resolve nem rejeita, sem erro
// visível. Resolução/FPS de destino continuam controlados no publish (screenShareEncoding em
// livekit.ts), não na captura.
interface ElectronDesktopConstraints {
  video: {
    mandatory: {
      chromeMediaSource: "desktop";
      chromeMediaSourceId: string;
    };
  };
  audio:
    | false
    | {
        mandatory: {
          chromeMediaSource: "desktop";
        };
      };
}

const CAPTURE_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// `onSourceEnded` dispara quando a track para inesperadamente (ex.: usuário fecha a janela
// compartilhada). Sem diálogo nativo aqui — a fonte já foi escolhida via SourcePicker.
export async function captureScreen(
  settings: StreamSettings,
  source: CaptureSource,
  onSourceEnded?: () => void,
): Promise<CaptureResult> {
  const constraints: ElectronDesktopConstraints = {
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: source.id,
      },
    },
    // `chromeMediaSource: "desktop"` no áudio pede o loopback do SISTEMA INTEIRO — não é isolado
    // por janela (a Windows não expõe captura de áudio de um app específico por essa API), mas
    // nada impede de pedir independente do tipo de fonte de vídeo escolhida. Antes isso ficava
    // bloqueado pra janela achando que não funcionava — nunca foi testado de verdade.
    audio: { mandatory: { chromeMediaSource: "desktop" } },
  };

  const stream = await withTimeout(
    navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints),
    CAPTURE_TIMEOUT_MS,
    `Não foi possível capturar "${source.name}" (o Windows recusou essa fonte — tenta escolher outra tela/janela).`,
  );

  const [videoTrack] = stream.getVideoTracks();

  // Sem constraint na captura, o WGC costuma cair num FPS conservador (30) e sempre entrega a
  // resolução nativa do monitor. Pede FPS/resolução reais pelo caminho PADRÃO (applyConstraints,
  // não `mandatory`) depois que a track já existe — esse caminho é negociado, não trava o app se
  // o SO recusar (só ignora, sem hang, diferente do `mandatory` que travava em loop).
  const desiredConstraints: MediaTrackConstraints = {};
  if (settings.fps !== "auto") {
    desiredConstraints.frameRate = { ideal: settings.fps, max: settings.fps };
  }
  if (settings.resolution !== "auto") {
    const { width, height } = RESOLUTION_CONSTRAINTS[settings.resolution];
    desiredConstraints.width = { ideal: width, max: width };
    desiredConstraints.height = { ideal: height, max: height };
  }
  if (Object.keys(desiredConstraints).length > 0) {
    try {
      await videoTrack.applyConstraints(desiredConstraints);
    } catch {
      // Sem sorte — segue com o que a captura já entregou (resolução/fps nativos).
    }
  }

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
