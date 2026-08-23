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
