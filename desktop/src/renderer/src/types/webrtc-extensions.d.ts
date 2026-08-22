// `playoutDelayHint` é extensão do Chromium, fora da spec padrão do TS DOM lib — controla o
// "colchão" de buffer que o WebRTC usa antes de mostrar o frame (absorve irregularidade de
// chegada/jitter às custas de um pouco de latência). Usado em useRoomViewer.ts.
interface RTCRtpReceiver {
  playoutDelayHint?: number;
}
