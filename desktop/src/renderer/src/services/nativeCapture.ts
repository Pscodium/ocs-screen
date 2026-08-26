import type { StreamSettings } from "../types/stream";
import type { NativeMonitor, NativeCaptureStats } from "../../../preload/index";

export type { NativeMonitor, NativeCaptureStats };

export async function isNativeCaptureAvailable(): Promise<boolean> {
  return window.screenshare.nativeCapture.isAvailable();
}

export async function listNativeMonitors(): Promise<NativeMonitor[]> {
  return window.screenshare.nativeCapture.listMonitors();
}

export interface NativeCaptureResult {
  stream: MediaStream;
  settings: MediaTrackSettings;
  stopAll: () => void;
  // Repassa fps de captura (medido no main process, antes do encoder) 1x/segundo — só existe pra
  // esse caminho, `desktopCapturer` não reporta nada equivalente.
  onCaptureStats: (callback: (stats: NativeCaptureStats) => void) => () => void;
}

interface RawFrame {
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

// Captura via DXGI Desktop Duplication (addon nativo em C++, ver docs/NATIVE_CAPTURE.md) em vez
// do `desktopCapturer`/WGC do Chromium — alimenta um `MediaStreamTrackGenerator` com os frames
// que chegam pelo MessagePort do main process. Dali pra frente segue o pipeline normal do
// projeto: a track resultante entra no LiveKit exatamente como a do desktopCapturer entraria
// (publish/simulcast/encode continuam 100% LiveKit, só a origem do frame muda).
export async function captureNative(monitorIndex: number, settings: StreamSettings): Promise<NativeCaptureResult> {
  const fpsTarget = settings.fps === "auto" ? 30 : settings.fps;

  const generator = new MediaStreamTrackGenerator<VideoFrame>({ kind: "video" });
  const writer = generator.writable.getWriter();
  let closed = false;

  // O MessagePort chega via `window.postMessage` do preload (não pelo contextBridge — ver nota
  // em preload/index.ts), então escuta no `window` normal do mundo principal, não em algo exposto
  // por `window.screenshare`.
  const port = await new Promise<MessagePort>((resolve) => {
    const onWindowMessage = (event: MessageEvent) => {
      if (event.data === "native-capture:port" && event.ports[0]) {
        window.removeEventListener("message", onWindowMessage);
        resolve(event.ports[0]);
      }
    };
    window.addEventListener("message", onWindowMessage);
    window.screenshare.nativeCapture.setCursorEnabled(settings.showCursor);
    window.screenshare.nativeCapture.start(monitorIndex, fpsTarget);
  });

  const { width, height } = await new Promise<{ width: number; height: number }>((resolveFirstFrame, reject) => {
    let gotFirstFrame = false;

    const timeout = setTimeout(() => {
      if (!gotFirstFrame) reject(new Error("Captura nativa não entregou nenhum frame a tempo."));
    }, 8000);

    port.onmessage = (event: MessageEvent<RawFrame>) => {
      if (closed) return;
      const { width: w, height: h, buffer } = event.data;
      writeFrame(writer, w, h, buffer);

      if (!gotFirstFrame) {
        gotFirstFrame = true;
        clearTimeout(timeout);
        resolveFirstFrame({ width: w, height: h });
      }
    };
  });

  return {
    stream: new MediaStream([generator]),
    settings: { width, height, frameRate: fpsTarget },
    stopAll: () => {
      closed = true;
      window.screenshare.nativeCapture.stop();
      port.close();
      writer.close().catch(() => {});
    },
    onCaptureStats: (callback) => window.screenshare.nativeCapture.onStats(callback),
  };
}

function writeFrame(writer: WritableStreamDefaultWriter<VideoFrame>, width: number, height: number, buffer: ArrayBuffer): void {
  // "BGRX" (não "BGRA") de propósito — o canal alfa que sai do DXGI Desktop Duplication não é
  // confiável (frequentemente vem 0 = transparente total), e "BGRA" trata esse byte como alfa de
  // verdade — resultado: vídeo inteiro transparente, aparece preto. "BGRX" ignora o 4º byte e
  // assume sempre opaco, que é o comportamento certo pra captura de tela (não tem "transparência
  // de desktop" nenhuma que faça sentido preservar aqui).
  let frame: VideoFrame;
  try {
    frame = new VideoFrame(new Uint8Array(buffer), {
      format: "BGRX",
      codedWidth: width,
      codedHeight: height,
      timestamp: performance.now() * 1000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[native-capture] falha ao construir VideoFrame", err, { width, height, byteLength: buffer.byteLength });
    return;
  }

  writer
    .write(frame)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[native-capture] falha ao escrever frame no writer", err);
    })
    .finally(() => frame.close());
}
