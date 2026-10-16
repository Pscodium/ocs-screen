// WebCodecs (Insertable Streams) — não faz parte do lib.dom.d.ts padrão do TS ainda. Usado em
// nativeCapture.ts pra alimentar uma MediaStreamTrack a partir de frames vindos do addon nativo
// (ver docs/NATIVE_CAPTURE.md). Só os campos realmente usados aqui, não a spec inteira.
interface VideoFrameInit {
  format: string;
  codedWidth: number;
  codedHeight: number;
  timestamp: number;
}

declare class VideoFrame {
  constructor(data: BufferSource, init: VideoFrameInit);
  close(): void;
}

declare class MediaStreamTrackGenerator<T = VideoFrame> extends MediaStreamTrack {
  constructor(init: { kind: "video" | "audio" });
  readonly writable: WritableStream<T>;
}
