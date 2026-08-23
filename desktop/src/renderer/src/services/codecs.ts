import type { VideoCodec } from "livekit-client";

// Prioridade revisada (era AV1 > VP9 > H.264 > VP8 por padrão do CLAUDE.md): H.264 primeiro.
// RTCRtpSender.getCapabilities só diz que o codec É NEGOCIÁVEL, não se tem hardware por trás —
// Chromium anuncia AV1/VP9 mesmo só com encoder por software (libaom/libvpx), que é pesado e
// adiciona latência real. H.264 tem o encoder de hardware mais garantido em qualquer GPU
// (NVENC/QuickSync/AMF), o que importa mais pro objetivo de baixa latência (jogos/suporte
// remoto) do que a compressão melhor do AV1 — troca deliberada, ver docs/ROADMAP.md.
const CODEC_PRIORITY: { codec: VideoCodec; mimeType: string }[] = [
  { codec: "h264", mimeType: "video/H264" },
  { codec: "vp9", mimeType: "video/VP9" },
  { codec: "av1", mimeType: "video/AV1" },
  { codec: "vp8", mimeType: "video/VP8" },
];

// Nomes de encoder por software que os browsers reportam em `encoderImplementation` — o resto
// (ex.: "ExternalEncoder", nomes de vendor) é hardware. Compartilhado entre `livekit.ts`
// (readPublishStats) e `LiveCard.tsx` (aviso visível) pra não duplicar a regex.
export function isSoftwareEncoder(name: string | null): boolean {
  if (!name) return false;
  return /libvpx|libaom|openh264|libx264/i.test(name);
}

let cachedCodec: VideoCodec | null = null;

// Detecta o melhor codec que o navegador/SO realmente suporta para envio.
// Nunca assumir suporte (CLAUDE.md §Codecs) — sempre checar RTCRtpSender.getCapabilities.
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

// `cachedCodec` sobrevive entre transmissões na mesma sessão do app (é variável de módulo) — se a
// PRIMEIRA transmissão caiu em software por algum motivo passageiro (outro app segurando a GPU
// naquele momento, por exemplo), toda transmissão seguinte herdava essa escolha sem re-testar.
// Chamado ao encerrar uma transmissão (ver disconnect() em livekit.ts) pra cada sessão de live
// reavaliar do zero. Ver docs/INSIGHTS-ENCODER.md #15.
export function resetCodecCache(): void {
  cachedCodec = null;
}
