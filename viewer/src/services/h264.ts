// Prepara o H.264 Annex-B do host nativo pro `VideoDecoder` (WebCodecs).
//
// 1. Codec string tirada do SPS real (profile/constraints/level), não fixa. Antes era sempre
//    "avc1.64002a" (High 4.2 = até 1080p60) — transmissão 1440p/4K declarava level menor que o
//    bitstream, e decoder de celular (limite de level mais rígido) podia recusar.
// 2. Safari/WebKit não decodifica H.264 com SPS/PPS só dentro do stream (Annex-B / "avc3").
//    Lá converte pra AVCC: SPS/PPS vão na `description` (AVCDecoderConfigurationRecord) e cada
//    NAL vira [tamanho de 4 bytes][NAL]. Mesmo problema e mesma saída documentados no mediamtx
//    (MIT): https://github.com/bluenviron/mediamtx/issues/6004 (fix no PR #6460). Implementação
//    própria a partir da spec ISO/IEC 14496-15 §5.3.3.1.

const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

export type H264Format = "annexb" | "avcc";

// WebKit (Safari em qualquer plataforma + TODO navegador no iOS, que é obrigado a usar WebKit).
// Detecção por UA, igual o mediamtx: não existe feature-detect confiável — `isConfigSupported`
// aceita "annexb" no Safari e o decode falha depois.
export function preferredH264Format(): H264Format {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const isDesktopSafari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua);
  return isIos || isDesktopSafari ? "avcc" : "annexb";
}

// Quebra um access unit Annex-B nos NALs (sem o start code 00 00 01 / 00 00 00 01).
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) nals.push(data.subarray(start, trimZeros(data, start, i)));
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) nals.push(data.subarray(start));
  return nals.filter((n) => n.length > 0);
}

// Zeros antes de um start code pertencem ao start code de 4 bytes (ou são trailing_zero_8bits).
function trimZeros(data: Uint8Array, from: number, end: number): number {
  let e = end;
  while (e > from && data[e - 1] === 0) e--;
  return e;
}

const hex2 = (b: number) => b.toString(16).padStart(2, "0");

// "avc1.PPCCLL" a partir dos bytes 1..3 do SPS (profile_idc, constraint flags, level_idc).
export function codecStringFromSps(sps: Uint8Array): string {
  return `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`;
}

function avcDecoderConfigurationRecord(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = sps[1]; // AVCProfileIndication
  out[o++] = sps[2]; // profile_compatibility
  out[o++] = sps[3]; // AVCLevelIndication
  out[o++] = 0xff; // reserved(6) + lengthSizeMinusOne = 3 (tamanho de 4 bytes)
  out[o++] = 0xe1; // reserved(3) + numOfSequenceParameterSets = 1
  out[o++] = sps.length >> 8;
  out[o++] = sps.length & 0xff;
  out.set(sps, o);
  o += sps.length;
  out[o++] = 1; // numOfPictureParameterSets
  out[o++] = pps.length >> 8;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  // High (100+) tem campos extras opcionais (chroma_format etc.) — omitidos: 4:2:0 8-bit é o
  // padrão e decoders aceitam o record sem eles.
  return out;
}

function toAvcc(nals: Uint8Array[]): Uint8Array {
  const kept = nals.filter((n) => {
    const type = n[0] & 0x1f;
    return type !== NAL_SPS && type !== NAL_PPS && type !== NAL_AUD;
  });
  const out = new Uint8Array(kept.reduce((sum, n) => sum + 4 + n.length, 0));
  const view = new DataView(out.buffer);
  let o = 0;
  for (const n of kept) {
    view.setUint32(o, n.length);
    out.set(n, o + 4);
    o += 4 + n.length;
  }
  return out;
}

export interface PreparedChunk {
  data: Uint8Array;
  // Não-nulo quando o decoder precisa ser (re)configurado ANTES deste chunk (1º keyframe, SPS
  // mudou — host trocou resolução/encoder — ou depois de `reset()`).
  config: VideoDecoderConfig | null;
}

export class H264Adapter {
  private configKey: string | null = null;

  constructor(readonly format: H264Format) {}

  // Decoder recriado (erro) → força reconfigurar no próximo keyframe.
  reset(): void {
    this.configKey = null;
  }

  // Retorna null se ainda não dá pra decodificar (delta antes do 1º keyframe com SPS/PPS).
  prepare(payload: Uint8Array, isKeyframe: boolean): PreparedChunk | null {
    // Chrome com o decoder já configurado e frame delta: caminho quente, zero cópia/parse.
    if (this.format === "annexb" && !isKeyframe) {
      return this.configKey ? { data: payload, config: null } : null;
    }

    const nals = splitAnnexB(payload);
    let config: VideoDecoderConfig | null = null;
    if (isKeyframe) {
      const sps = nals.find((n) => (n[0] & 0x1f) === NAL_SPS);
      const pps = nals.find((n) => (n[0] & 0x1f) === NAL_PPS);
      if (sps && pps && sps.length >= 4) {
        const codec = codecStringFromSps(sps);
        const description = this.format === "avcc" ? avcDecoderConfigurationRecord(sps, pps) : null;
        const key = `${codec}|${description ? Array.from(description, hex2).join("") : ""}`;
        if (key !== this.configKey) {
          this.configKey = key;
          config = description
            ? { codec, optimizeForLatency: true, description }
            : { codec, optimizeForLatency: true, avc: { format: "annexb" } };
        }
      }
    }
    if (!this.configKey) return null;
    return { data: this.format === "avcc" ? toAvcc(nals) : payload, config };
  }
}
