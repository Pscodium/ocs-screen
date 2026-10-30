import type { VideoCodec } from "livekit-client";

// Só o host WEB usa isso — o desktop tem a própria escolha (desktop/src/renderer/src/services/codecs.ts).
//
// Conteúdo com movimento: VP9 primeiro, diferente do desktop. Medido em E2E (Chrome → LiveKit local,
// 1080p60, 2026-10-29): H.264 no navegador — tanto o MFT de hardware quanto o OpenH264 — trava o QP
// em 35 e DESCARTA frames quando falta bitrate (1-11 fps, congelamentos de vários segundos), mas
// reporta `qualityLimitationReason: none`, então o WebRTC nunca reduz a resolução e a estimativa de
// banda não sobe. VP9 SVC (libvpx) reporta `bandwidth`/`cpu` direito, adapta resolução e entregou
// 34-38 fps sem congelar. Custa CPU (encode por software), mas degrada perdendo nitidez, não fluidez.
//
// Conteúdo parado ("Melhorar texto"): H.264 continua primeiro — sem movimento o problema acima não
// aparece (55 fps no mesmo teste) e o encoder de hardware poupa CPU.
const MOTION_PRIORITY: { codec: VideoCodec; mimeType: string }[] = [
  { codec: "vp9", mimeType: "video/VP9" },
  { codec: "h264", mimeType: "video/H264" },
  { codec: "av1", mimeType: "video/AV1" },
  { codec: "vp8", mimeType: "video/VP8" },
];

const TEXT_PRIORITY: { codec: VideoCodec; mimeType: string }[] = [
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

const cachedCodec: Record<"motion" | "text", VideoCodec | null> = { motion: null, text: null };

export function detectBestVideoCodec(content: "motion" | "text"): VideoCodec {
  const cached = cachedCodec[content];
  if (cached) return cached;

  const capabilities = (window.RTCRtpSender as typeof RTCRtpSender | undefined)?.getCapabilities?.("video");
  const supportedMimeTypes = new Set((capabilities?.codecs ?? []).map((c) => c.mimeType.toLowerCase()));

  for (const { codec, mimeType } of content === "text" ? TEXT_PRIORITY : MOTION_PRIORITY) {
    if (supportedMimeTypes.has(mimeType.toLowerCase())) {
      cachedCodec[content] = codec;
      return codec;
    }
  }

  cachedCodec[content] = "vp8";
  return "vp8";
}

// Ver nota em desktop/src/renderer/src/services/codecs.ts e docs/INSIGHTS-ENCODER.md #15 — evita
// que uma escolha ruim de uma transmissão passada (caiu em software por motivo passageiro)
// contamine todas as próximas na mesma sessão do app.
export function resetCodecCache(): void {
  cachedCodec.motion = null;
  cachedCodec.text = null;
}
