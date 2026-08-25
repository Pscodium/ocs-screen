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
export function useNativeStream(roomId: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Connecting);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [playoutDelayMs, setPlayoutDelayMsState] = useState(PLAYOUT_DELAY_DEFAULT_MS);

  // Sem RTCRtpReceiver nesse caminho (DataChannel, não RTP) — não tem "playout delay" nativo do
  // navegador pra ajustar. Mantido só pra não quebrar a prop do VideoPlayer; vira um no-op aqui
  // (fora de escopo por ora — se precisar de colchão de jitter, seria um buffer próprio antes do
  // MediaStreamTrackGenerator).
  const applyPlayoutDelay = useCallback((ms: number) => {
    setPlayoutDelayMsState(Math.max(0, Math.min(PLAYOUT_DELAY_MAX_MS, ms)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let statsInterval: ReturnType<typeof setInterval> | null = null;

    let framesDecoded = 0;
    let bytesReceived = 0;
    let lastStatsAt = performance.now();

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

    pc.ondatachannel = (event) => {
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
      if (videoRef.current) {
        videoRef.current.srcObject = new MediaStream([generator]);
        videoRef.current.muted = true; // sem áudio nesse caminho, mesmo motivo do CaptureCore
      }

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
          writer.write(frame).catch(() => frame.close());
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
        setStats((prev) => (prev ? { ...prev, fps, bitrateKbps } : prev));
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
            const decoderOk = negotiatedCodec !== "hevc" || (await isHevcDecodeSupported());

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
    hasAudio: false,
    playoutDelayMs,
    setPlayoutDelayMs: applyPlayoutDelay,
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

