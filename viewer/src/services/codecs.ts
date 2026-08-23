import type { VideoCodec } from "livekit-client";

// Prioridade revisada (era AV1 > VP9 > H.264 > VP8). Espelha desktop/src/services/codecs.ts —
// H.264 primeiro porque tem o encoder de hardware mais garantido em qualquer GPU, e
// getCapabilities não distingue codec com hardware de codec só em software (AV1/VP9 podem cair
// em libaom/libvpx, pesado e com mais latência). Ver docs/ROADMAP.md.
const CODEC_PRIORITY: { codec: VideoCodec; mimeType: string }[] = [
  { codec: "h264", mimeType: "video/H264" },
  { codec: "vp9", mimeType: "video/VP9" },
  { codec: "av1", mimeType: "video/AV1" },
  { codec: "vp8", mimeType: "video/VP8" },
];

// Nomes de encoder por software que os browsers reportam em `encoderImplementation` — o resto
// (ex.: "ExternalEncoder", nomes de vendor) é hardware. Compartilhado entre `publish.ts`
// (readPublishStats) e `LiveCard.tsx` (aviso visível) pra não duplicar a regex.
export function isSoftwareEncoder(name: string | null): boolean {
  if (!name) return false;
  return /libvpx|libaom|openh264|libx264/i.test(name);
}

let cachedCodec: VideoCodec | null = null;

export function detectBestVideoCodec(): VideoCodec {
  if (cachedCodec) return cachedCodec;

  const capabilities = (window.RTCRtpSender as typeof RTCRtpSender | undefined)?.getCapabilities?.("video");
  const supportedMimeTypes = new Set((capabilities?.codecs ?? []).map((c) => c.mimeType.toLowerCase()));

  for (const { codec, mimeType } of CODEC_PRIORITY) {
    if (supportedMimeTypes.has(mimeType.toLowerCase())) {
      cachedCodec = codec;
      return codec;
    }
  }

  cachedCodec = "vp8";
  return cachedCodec;
}

// Ver nota em desktop/src/renderer/src/services/codecs.ts e docs/INSIGHTS-ENCODER.md #15 — evita
// que uma escolha ruim de uma transmissão passada (caiu em software por motivo passageiro)
// contamine todas as próximas na mesma sessão do app.
export function resetCodecCache(): void {
  cachedCodec = null;
}
