import type { VideoCodec } from "livekit-client";

// Prioridade CLAUDE.md §Codecs: AV1 > VP9 > H.264 > VP8. Espelha desktop/src/services/codecs.ts.
const CODEC_PRIORITY: { codec: VideoCodec; mimeType: string }[] = [
  { codec: "av1", mimeType: "video/AV1" },
  { codec: "vp9", mimeType: "video/VP9" },
  { codec: "h264", mimeType: "video/H264" },
  { codec: "vp8", mimeType: "video/VP8" },
];

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
