// `playoutDelayHint` é extensão do Chromium, fora da spec padrão do TS DOM lib — controla o
// "colchão" de buffer que o WebRTC usa antes de mostrar o frame (absorve irregularidade de
// chegada/jitter às custas de um pouco de latência). Usado em useRoomStream.ts.
interface RTCRtpReceiver {
  playoutDelayHint?: number;
}

// `webkitEnterFullscreen` é a única forma de tela cheia que o Safari no iPhone aceita — a
// Fullscreen API padrão (`Element.requestFullscreen`) não funciona em elementos arbitrários no
// iOS (só no iPad), então containers/divs não conseguem ir fullscreen ali. Só existe em <video>.
// Usado em VideoPlayer.tsx.
interface HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

// `MediaStreamTrackGenerator` (Insertable Streams) não faz parte do lib.dom.d.ts padrão do TS
// ainda — usado em useNativeStream.ts pra transformar os `VideoFrame` decodificados pelo
// `VideoDecoder` (WebCodecs) numa MediaStreamTrack de verdade, anexável no <video>.
declare class MediaStreamTrackGenerator<T = VideoFrame> extends MediaStreamTrack {
  constructor(init: { kind: "video" | "audio" });
  readonly writable: WritableStream<T>;
}

// `avc.format` é suportado pelo Chromium (permite Annex-B — SPS/PPS embutido no bitstream, com
// start code — em vez de exigir AVCC com `description` separada) mas ainda não está no
// VideoDecoderConfig do lib.dom.d.ts desta versão do TS.
interface VideoDecoderConfig {
  avc?: { format: "annexb" | "avc" };
  // Mesmo caso do `avc` acima, mas pro HEVC (usado em useNativeStream.ts quando o host negocia
  // HEVC em vez de H.264 — ver docs/NATIVE_CAPTURE.md Fase 3 "HEVC").
  hevc?: { format: "annexb" | "hevc" };
}
