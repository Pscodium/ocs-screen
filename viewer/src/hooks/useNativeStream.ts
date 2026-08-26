import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { openNativeSignalingSocket, type NativeVideoCodec } from "../services/backend";
import type { ConnectionPhase, StreamStats } from "./useRoomStream";
import { PLAYOUT_DELAY_MAX_MS, PLAYOUT_DELAY_DEFAULT_MS } from "./useRoomStream";

const STATS_POLL_MS = 2000;

// Espectador do transporte nativo (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase 4) —
// `RTCPeerConnection` cru do navegador (sem livekit-client) + vídeo por DATACHANNEL (não RTP
// media track). Decidido depois de achar um bug real no `PacingHandler` do libdatachannel
// vendorizado (condição invertida, trava ~1 a cada 2 frames — ver TransportCore.h/.cpp) — em vez
// de patchear a lib vendorizada, o vídeo passa a ir cru (H.264 Annex-B) por um DataChannel SCTP
// (confiável/ordenado por padrão, sem precisar configurar nada) e é decodificado aqui com
// `VideoDecoder` (WebCodecs), igual o projeto de referência SlipStream faz na mesma stack.
// "high"/"low" — os dois tiers fixos do simulcast (Sprint 27, ver docs/NATIVE_CAPTURE.md Fase 4
// "Simulcast"). Seleção manual nessa v1 (sem medição automática de rede do lado do espectador
// ainda) — ver `setQuality` abaixo.
export type NativeQualityTier = "high" | "low";

export function useNativeStream(roomId: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Connecting);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const [playoutDelayMs, setPlayoutDelayMsState] = useState(PLAYOUT_DELAY_DEFAULT_MS);
  const [quality, setQualityState] = useState<NativeQualityTier>("high");
  // `sendWhenOpen` de dentro do useEffect não é visível pro `setQuality` exposto no retorno do
  // hook (closures diferentes) — guarda a referência aqui pra poder mandar a troca de qualidade
  // a qualquer momento depois que o WS conectar.
  const sendMessageRef = useRef<((payload: Record<string, unknown>) => void) | null>(null);

  const setQuality = useCallback((tier: NativeQualityTier) => {
    setQualityState(tier);
    sendMessageRef.current?.({ type: "set-quality", tier });
  }, []);

  // Sem RTCRtpReceiver nesse caminho (DataChannel, não RTP) — não tem "playout delay" nativo do
  // navegador pra ajustar, por isso o buffer de jitter é implementado à mão abaixo (ver
  // `channel.onmessage`/`decoder.output`). O valor aqui vira o PISO mínimo do buffer adaptativo —
  // o usuário pode pedir "quero mais suavização" e o algoritmo nunca desce abaixo disso, mas ainda
  // pode subir mais sozinho se a rede pedir (ver `userFloorMsRef`).
  const userFloorMsRef = useRef(PLAYOUT_DELAY_DEFAULT_MS);
  const applyPlayoutDelay = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(PLAYOUT_DELAY_MAX_MS, ms));
    userFloorMsRef.current = clamped;
    setPlayoutDelayMsState(clamped);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let statsInterval: ReturnType<typeof setInterval> | null = null;

    let framesDecoded = 0;
    let bytesReceived = 0;
    let lastStatsAt = performance.now();

    // Buffer de jitter adaptativo (Sprint 29, ver docs/NATIVE_CAPTURE.md Fase 4 "Latência
    // adaptativa") — sem RTP nesse caminho, não existe jitter buffer nativo do navegador pra usar.
    // `anchorLocalMs`/`anchorStreamUs` ancoram o relógio de STREAM (timestampUs, gerado pelo host
    // como `Date.now()-startTime` — ver main/index.ts) no relógio LOCAL (`performance.now()`) a
    // partir do PRIMEIRO chunk recebido. Todo chunk seguinte compara "quando deveria ter chegado
    // se a rede fosse perfeitamente estável" (`expectedLocalMs`) com "quando chegou de verdade" —
    // a diferença é jitter de rede cru. `jitterEstimateMs` suaviza isso com EWMA (mesmo espírito da
    // fórmula de estimativa de jitter do RFC 3550/RTP, só que sobre o próprio timestamp de
    // aplicação em vez de RTP timestamp).
    let anchorLocalMs: number | null = null;
    let anchorStreamUs = 0;
    let jitterEstimateMs = 0;
    let autoDelayMs = 0;
    const JITTER_EWMA_ALPHA = 1 / 16; // mesmo peso que RFC 3550 usa pra estimativa de jitter RTP
    const JITTER_SAFETY_MULTIPLIER = 4; // margem de segurança sobre o jitter médio medido

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    // Setado ANTES do canal de vídeo abrir de verdade (só abre depois do SDP fechar) — o handler
    // de `ondatachannel` mais abaixo lê essa variável já com o valor certo.
    let negotiatedCodec: NativeVideoCodec = "h264";

    // WS de sinalização (ver backend/src/services/nativeWsRelay.ts e desktop/src/main/index.ts,
    // lado espelhado do host) — substitui o REST+polling anterior.
    const ws = openNativeSignalingSocket(roomId);
    const sendWhenOpen = (payload: Record<string, unknown>): void => {
      const json = JSON.stringify(payload);
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
      else ws.addEventListener("open", () => ws.send(json), { once: true });
    };
    sendMessageRef.current = sendWhenOpen;

    pc.onconnectionstatechange = () => {
      const map: Record<RTCPeerConnectionState, ConnectionState> = {
        new: ConnectionState.Connecting,
        connecting: ConnectionState.Connecting,
        connected: ConnectionState.Connected,
        disconnected: ConnectionState.Reconnecting,
        failed: ConnectionState.Disconnected,
        closed: ConnectionState.Disconnected,
      };
      setConnectionState(map[pc.connectionState]);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (!cancelled) setPhase("ended");
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendWhenOpen({ type: "ice", candidate: event.candidate.candidate, mid: event.candidate.sdpMid ?? "0" });
    };

    // Compartilhado entre vídeo e áudio — os dois canais podem abrir em qualquer ordem (áudio é
    // opcional, só existe se a captura nativa do host tiver conseguido inicializar, ver
    // AudioCaptureCore.h/main/index.ts), então nenhum dos dois branches abaixo pode assumir que é
    // o primeiro a criar o `MediaStream` do `<video>`.
    const mediaStream = new MediaStream();

    pc.ondatachannel = (event) => {
      if (event.channel.label === "audio") {
        const channel = event.channel;
        channel.binaryType = "arraybuffer";

        const generator = new MediaStreamTrackGenerator<AudioData>({ kind: "audio" });
        const writer = generator.writable.getWriter();
        mediaStream.addTrack(generator);
        if (videoRef.current) videoRef.current.srcObject = mediaStream;
        setHasAudio(true);

        // Opus não tem conceito de keyframe/GOP como vídeo — todo pacote decodifica sozinho a
        // partir do seguinte, por isso `type: "key"` sempre (é o único tipo que faz sentido pro
        // WebCodecs `EncodedAudioChunk` de áudio). Sem buffer de jitter próprio aqui (diferente do
        // vídeo) — escreve assim que decodifica; o pipeline de áudio do navegador já lida com o
        // ritmo de reprodução a partir do timestamp de cada `AudioData`.
        const decoder = new AudioDecoder({
          output: (audioData) => {
            writer.write(audioData).catch(() => audioData.close());
          },
          error: () => {
            // eslint-disable-next-line no-console
            console.error("[native-stream] erro no AudioDecoder");
          },
        });
        decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });

        channel.onmessage = (event) => {
          const buffer = event.data as ArrayBuffer;
          if (buffer.byteLength < 8) return;
          const view = new DataView(buffer);
          const timestampUs = Number(view.getBigUint64(0, true));
          const payload = new Uint8Array(buffer, 8);

          try {
            decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: timestampUs, data: payload }));
          } catch {
            // Pacote rejeitado (raro) — o próximo já se recupera sozinho, sem GOP pra esperar.
          }
        };
        return;
      }

      if (event.channel.label !== "video") return;
      const channel = event.channel;
      channel.binaryType = "arraybuffer";

      // `MediaStreamTrackGenerator` — canvas+captureStream piorou (drawImage() de VideoFrame é
      // caro na main thread) e o drop-on-backpressure também piorou (jogava frame demais fora em
      // fps alto, virou "câmera lenta"). Voltou pro escrever direto sem gating — o artefato
      // visual PERSISTIU mesmo com o canvas (zero fila possível, frame fechado na hora), o que
      // descarta fila/buffer do lado do espectador como causa — não vale a complexidade extra
      // aqui, o problema real tá em outro lugar (upstream: encoder/rate-control, ver notas em
      // EncoderCore.cpp sobre VBV).
      const generator = new MediaStreamTrackGenerator<VideoFrame>({ kind: "video" });
      const writer = generator.writable.getWriter();
      mediaStream.addTrack(generator);
      if (videoRef.current) videoRef.current.srcObject = mediaStream;

      let gotFirstFrame = false;
      let width = 0;
      let height = 0;

      const decoder = new VideoDecoder({
        output: (frame) => {
          if (!gotFirstFrame) {
            gotFirstFrame = true;
            width = frame.displayWidth;
            height = frame.displayHeight;
            setStats({ resolution: `${width} × ${height}`, fps: 0, bitrateKbps: 0, latencyMs: 0, packetLossPercent: 0 });
            setPhase("connected");
          }
          framesDecoded++;

          // `frame.timestamp` = o MESMO `timestampUs` que o chunk carregava (WebCodecs preserva
          // timestamp do chunk pro frame decodificado) — dá pra recalcular quando esse frame
          // "deveria" aparecer na tela usando a mesma âncora local/stream do onmessage abaixo.
          const effectiveDelayMs = Math.max(userFloorMsRef.current, autoDelayMs);
          if (anchorLocalMs === null) {
            writer.write(frame).catch(() => frame.close());
            return;
          }
          const targetLocalMs = anchorLocalMs + (frame.timestamp - anchorStreamUs) / 1000 + effectiveDelayMs;
          const waitMs = targetLocalMs - performance.now();
          if (waitMs <= 0) {
            writer.write(frame).catch(() => frame.close());
          } else {
            setTimeout(() => writer.write(frame).catch(() => frame.close()), waitMs);
          }
        },
        error: () => {
          // Frame corrompido/decoder num estado ruim — não é fatal (próximo keyframe do host
          // recupera sozinho, GOP de 2s), só loga.
          // eslint-disable-next-line no-console
          console.error("[native-stream] erro no VideoDecoder");
        },
      });
      if (negotiatedCodec === "hevc") {
        // Codec string genérica (Main profile/tier, level 4.0) — assim como no H.264 abaixo, o
        // profile/level REAL vem do VPS/SPS embutido no bitstream Annex-B (`repeatSPSPPS`
        // equivalente do EncoderCore pro HEVC), essa string só é o feature-gate grosseiro que o
        // Chrome usa antes de sequer olhar os bytes.
        decoder.configure({ codec: "hev1.1.6.L120.B0", optimizeForLatency: true, hevc: { format: "annexb" } });
      } else if (negotiatedCodec === "av1") {
        // "av01.0.04M.08" = profile Main (0) + level 4.0 (04) + tier Main (M) + 8-bit (08) —
        // mesmo espírito de string genérica que HEVC/H.264 acima, o profile/level real vem do
        // Sequence Header embutido no bitstream (`repeatSeqHdr=1` no EncoderCore). Diferente de
        // avc/hevc, o WebCodecs não tem um sub-objeto `{format: "annexb"}` pro AV1 — o spec só
        // conhece o formato "low overhead" (OBUs crus concatenados), que é exatamente o que
        // `outputAnnexBFormat=0` no EncoderCore já produz.
        decoder.configure({ codec: "av01.0.04M.08", optimizeForLatency: true });
      } else {
        // `avc: { format: "annexb" }` — o encoder manda SPS/PPS embutido em CADA keyframe
        // (repeatSPSPPS=1 no EncoderCore), não precisa de `description` separada em AVCC.
        //
        // "avc1.64002a" = profile High (0x64) + level 4.2 (0x2a) — NÃO Baseline. O NVENC
        // (CreateDefaultEncoderParams com preset P4+LOW_LATENCY) escolhe High profile sozinho por
        // padrão; "avc1.42e01f" (Baseline) era resquício do SDP do caminho RTP antigo, nunca batia
        // com o bitstream real (confirmado via `ffprobe` no dump: `profile=High level=42`). High
        // usa CABAC + transform 8x8, Baseline usa só CAVLC — inicializar o decoder de hardware
        // esperando Baseline enquanto os bytes são High não lança erro nenhum (o parser ainda lê a
        // SPS real embutida), mas pode decodificar alguns blocos errado — bate com o sintoma
        // medido em produção (bloco de cor errada, sem erro nenhum no VideoDecoder).
        decoder.configure({ codec: "avc1.64002a", optimizeForLatency: true, avc: { format: "annexb" } });
      }

      channel.onmessage = (event) => {
        const buffer = event.data as ArrayBuffer;
        if (buffer.byteLength < 9) return;
        const view = new DataView(buffer);
        const isKeyframe = view.getUint8(0) === 0;
        const timestampUs = Number(view.getBigUint64(1, true));
        const payload = new Uint8Array(buffer, 9);
        bytesReceived += payload.byteLength;

        // Âncora stream-time↔local-time no PRIMEIRO chunk (ver comentário no topo do effect) —
        // todo chunk seguinte atualiza a estimativa de jitter comparando chegada esperada (se a
        // rede fosse perfeitamente estável) com chegada real.
        const arrivalLocalMs = performance.now();
        if (anchorLocalMs === null) {
          anchorLocalMs = arrivalLocalMs;
          anchorStreamUs = timestampUs;
        } else {
          const expectedLocalMs = anchorLocalMs + (timestampUs - anchorStreamUs) / 1000;
          const delta = arrivalLocalMs - expectedLocalMs;
          // EWMA — só a MAGNITUDE do desvio importa (adiantado ou atrasado, os dois indicam rede
          // instável), não o sinal.
          jitterEstimateMs += (Math.abs(delta) - jitterEstimateMs) * JITTER_EWMA_ALPHA;
          autoDelayMs = Math.min(PLAYOUT_DELAY_MAX_MS, Math.max(0, Math.round(jitterEstimateMs * JITTER_SAFETY_MULTIPLIER)));
        }

        if (!gotFirstFrame && !isKeyframe) return; // WebCodecs exige que o primeiro chunk seja "key"

        try {
          decoder.decode(
            new EncodedVideoChunk({ type: isKeyframe ? "key" : "delta", timestamp: timestampUs, data: payload }),
          );
        } catch {
          // Chunk rejeitado (raro) — próximo keyframe recupera.
        }
      };

      statsInterval = setInterval(() => {
        const now = performance.now();
        const secondsDelta = (now - lastStatsAt) / 1000;
        const fps = secondsDelta > 0 ? Math.round(framesDecoded / secondsDelta) : 0;
        const bitrateKbps = secondsDelta > 0 ? Math.round((bytesReceived * 8) / secondsDelta / 1000) : 0;
        framesDecoded = 0;
        bytesReceived = 0;
        lastStatsAt = now;
        // `latencyMs` aqui é o buffer de jitter ADAPTATIVO efetivo (piso manual ou auto, o que for
        // maior) — reaproveita o campo que já existia na UI (rótulo "buffer" no painel de
        // estatísticas do VideoPlayer), sem precisar de UI nova.
        const effectiveDelayMs = Math.max(userFloorMsRef.current, autoDelayMs);
        setStats((prev) => (prev ? { ...prev, fps, bitrateKbps, latencyMs: effectiveDelayMs } : prev));
      }, STATS_POLL_MS);
    };

    // Só processa o PRIMEIRO offer que chegar (mesmo limite que o REST+polling anterior sempre
    // teve) — se o host renegociar depois (viewer caiu do lado dele, F5, etc.), esse hook não
    // reage a um offer novo sozinho; o componente que monta o player precisa remontar.
    let gotOffer = false;

    ws.onmessage = (event) => {
      if (cancelled) return;
      let msg: { type?: string; sdp?: string; codec?: NativeVideoCodec; candidate?: string; mid?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "offer" && msg.sdp && !gotOffer) {
        gotOffer = true;
        negotiatedCodec = msg.codec ?? "h264";
        (async () => {
          try {
            await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp! });

            // Checa suporte de DECODE antes de responder — Chrome só decodifica HEVC com hardware
            // disponível no dispositivo, inconsistente entre SO/GPU (diferente do H.264, ubíquo).
            // `false` aqui faz o host reiniciar o encoder em H.264 e renegociar (ver
            // beginNativeNegotiation em desktop/src/main/index.ts) — H.264 nunca precisa checar,
            // assumido sempre suportado.
            const decoderOk =
              negotiatedCodec === "hevc" ? await isHevcDecodeSupported()
              : negotiatedCodec === "av1" ? await isAv1DecodeSupported()
              : true;

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (!pc.localDescription) throw new Error("Falha ao gerar resposta SDP.");
            sendWhenOpen({ type: "answer", sdp: pc.localDescription.sdp, decoderOk });
          } catch (err) {
            if (cancelled) return;
            setError(err instanceof Error ? err.message : "Erro ao conectar na transmissão nativa.");
            setPhase("error");
          }
        })();
      } else if (msg.type === "ice" && msg.candidate) {
        pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid ?? "0" }).catch(() => {});
      }
    };

    ws.onerror = () => {
      if (cancelled) return;
      setError("Erro na sinalização com o host.");
      setPhase("error");
    };

    return () => {
      cancelled = true;
      sendMessageRef.current = null;
      ws.close();
      if (statsInterval) clearInterval(statsInterval);
      pc.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return {
    videoRef,
    phase,
    connectionState,
    error,
    stats,
    hasAudio,
    playoutDelayMs,
    setPlayoutDelayMs: applyPlayoutDelay,
    quality,
    setQuality,
  };
}

// Mesma codec string usada em `decoder.configure()` no `ondatachannel` — se checar suporte com
// uma string diferente da que de fato é usada pra configurar o decoder depois, o resultado não
// vale nada. `isConfigSupported` é opcional no TS lib.dom dependendo da versão — checa em runtime.
async function isHevcDecodeSupported(): Promise<boolean> {
  try {
    if (typeof VideoDecoder === "undefined" || !VideoDecoder.isConfigSupported) return false;
    const result = await VideoDecoder.isConfigSupported({
      codec: "hev1.1.6.L120.B0",
      hevc: { format: "annexb" },
    });
    return result.supported === true;
  } catch {
    // Navegador nem reconhece a config (erro em vez de {supported:false}) — trata como não
    // suportado, mais seguro que assumir suporte.
    return false;
  }
}

// Mesma lógica de isHevcDecodeSupported, codec string AV1 — decode por hardware ainda mais
// inconsistente que HEVC entre dispositivos (GPU mais recente que decode HEVC pode não ter decode
// AV1 de hardware; alguns navegadores/SO têm fallback por software libaom, outros não expõem nada).
async function isAv1DecodeSupported(): Promise<boolean> {
  try {
    if (typeof VideoDecoder === "undefined" || !VideoDecoder.isConfigSupported) return false;
    const result = await VideoDecoder.isConfigSupported({ codec: "av01.0.04M.08" });
    return result.supported === true;
  } catch {
    return false;
  }
}

