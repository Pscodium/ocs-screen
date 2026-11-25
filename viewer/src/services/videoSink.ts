// Destino dos `VideoFrame` decodificados → uma track que o `<video>` toca.
//
// Chromium: `MediaStreamTrackGenerator` (caminho rápido, sem cópia na main thread).
// Sem ele (Safari/WebKit — todo navegador no iPhone —, Firefox): desenha cada frame num canvas e
// usa `canvas.captureStream()` como track. Mesma ideia do polyfill de jan-ivar
// (https://github.com/jan-ivar/polyfills/blob/f471fed0fb148bd2cfff2b404ba7e77ea5efb7d6/mediastreamtrackgenerator.js),
// reimplementado aqui. NÃO usar no Chrome: já foi medido que `drawImage` de VideoFrame na main
// thread piora o ritmo (ver comentário no `ondatachannel` de useNativeStream.ts). Mantém o `<video>`
// (e o fullscreen/PiP dele) nos dois caminhos — só muda de onde vem a track.

export interface VideoSink {
  track: MediaStreamTrack;
  writer: WritableStreamDefaultWriter<VideoFrame>;
  kind: "generator" | "canvas";
}

export function canUseCanvasSink(): boolean {
  return typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype;
}

export function createVideoSink(): VideoSink {
  if (typeof MediaStreamTrackGenerator !== "undefined") {
    const generator = new MediaStreamTrackGenerator<VideoFrame>({ kind: "video" });
    return { track: generator, writer: generator.writable.getWriter(), kind: "generator" };
  }

  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("canvas 2d indisponível");
  const [track] = canvas.captureStream().getVideoTracks();
  const writable = new WritableStream<VideoFrame>({
    write(frame) {
      try {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      } finally {
        frame.close();
      }
    },
  });
  return { track, writer: writable.getWriter(), kind: "canvas" };
}
