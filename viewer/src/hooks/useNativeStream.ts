import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { fetchIceServers, openNativeSignalingSocket, type NativeVideoCodec } from "../services/backend";
import type { ConnectionPhase, StreamStats } from "./useRoomStream";
import { PLAYOUT_DELAY_MAX_MS } from "./useRoomStream";
import { PlayoutClock } from "../services/playoutClock";
import { NativeAudioPlayer } from "../services/nativeAudioPlayer";

const STATS_POLL_MS = 2000;
// Piso de "suavização" do caminho nativo — 0 = só o buffer adaptativo (`PlayoutClock` já cobre o
// jitter medido). O caminho LiveKit continua com o próprio padrão (`PLAYOUT_DELAY_DEFAULT_MS`).
const NATIVE_PLAYOUT_FLOOR_DEFAULT_MS = 0;
// Pedido de keyframe ao host (`'K'` no canal de vídeo, ver TransportCore.h "Controle de
// latência") — no máximo 1 a cada isso, o host também limita do lado dele.
const KEYFRAME_REQUEST_INTERVAL_MS = 1000;
// Erros de decoder seguidos (dentro da janela) antes de desistir e mostrar erro — um erro isolado
// é recuperado recriando o decoder + keyframe; vários seguidos = decoder/dispositivo incompatível.
const DECODER_ERROR_LIMIT = 3;
const DECODER_ERROR_WINDOW_MS = 10_000;

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

export function useNativeStream(roomId: string, password?: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Connecting);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [hasAudio, setHasAudio] = useState(false);
  const [playoutDelayMs, setPlayoutDelayMsState] = useState(NATIVE_PLAYOUT_FLOOR_DEFAULT_MS);
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
  // navegador pra ajustar; o relógio de apresentação é próprio (`PlayoutClock`). O valor do slider
  // vira o PISO do buffer adaptativo — o usuário pode pedir mais suavização, o automático ainda
  // pode subir mais sozinho se a rede pedir.
  const playoutClockRef = useRef(new PlayoutClock());
  const applyPlayoutDelay = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(PLAYOUT_DELAY_MAX_MS, ms));
    playoutClockRef.current.floorMs = clamped;
    setPlayoutDelayMsState(clamped);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let statsInterval: ReturnType<typeof setInterval> | null = null;

    // Bug real reportado pelo usuário: Safari (iPhone) ficava "conectando..." pra sempre, sem
    // erro nenhum visível. Causa: esse caminho depende de APIs que só existem de verdade no
    // Chromium — `MediaStreamTrackGenerator` (ainda sem suporte no WebKit/Safari até a versão
    // testada) e `VideoDecoder`/`AudioDecoder` (WebCodecs, suporte parcial/inconsistente fora do
    // Chromium). Sem essa checagem, `new MediaStreamTrackGenerator(...)` dentro do handler do
    // canal (`handleDataChannel` abaixo) lançava um `ReferenceError` não capturado — silencioso
    // pro usuário (só aparece no console), a UI nunca saía do estado "conectando". Falha cedo e
    // visível em vez de travar pra sempre.
    if (typeof MediaStreamTrackGenerator === "undefined" || typeof VideoDecoder === "undefined") {
      setError("Este navegador não suporta os recursos necessários (WebCodecs) para assistir a essa transmissão. Tente um Chrome/Edge recente.");
      setPhase("error");
      return () => {
        cancelled = true;
      };
    }

    let framesDecoded = 0;
    let bytesReceived = 0;
    let lastStatsAt = performance.now();

    // Vídeo e áudio apresentados pelo MESMO relógio (ver services/playoutClock.ts) — é o que
    // mantém os dois sincronizados: o host carimba os dois no mesmo relógio de captura.
    const playout = playoutClockRef.current;
    playout.reset();

    function presentVideoFrame(writer: WritableStreamDefaultWriter<VideoFrame>, frame: VideoFrame): void {
      const waitMs = playout.schedule(frame.timestamp, performance.now());
      const write = () => writer.write(frame).catch(() => frame.close());
      if (waitMs <= 1) write();
      else setTimeout(write, waitMs);
    }

    // Setado ANTES do canal de vídeo abrir de verdade (só abre depois do SDP fechar) — o handler
    // de `ondatachannel` mais abaixo lê essa variável já com o valor certo.
    let negotiatedCodec: NativeVideoCodec = "h264";

    // Compartilhado entre vídeo e áudio, e entre RECRIAÇÕES de `pc` (ver `setupPeerConnection`
    // abaixo) — os dois canais podem abrir em qualquer ordem (áudio é opcional, só existe se a
    // captura nativa do host tiver conseguido inicializar), então nenhum branch pode assumir que é
    // o primeiro a criar o `MediaStream` do `<video>`. Mantém a MESMA instância entre renegociações
    // pra não precisar reatribuir `videoRef.current.srcObject` de novo (evita um flash/reload do
    // elemento `<video>`) — só troca as TRACKS de dentro dela.
    const mediaStream = new MediaStream();
    let currentVideoTrack: MediaStreamTrack | null = null;
    // Áudio NÃO entra na MediaStream do `<video>` — vai por Web Audio, agendado no relógio de
    // apresentação (ver services/nativeAudioPlayer.ts). Criado sob demanda no 1º canal de áudio,
    // compartilhado entre renegociações (mesmo motivo da `mediaStream`).
    let audioPlayer: NativeAudioPlayer | null = null;

    // Bug real corrigido (achado testando com um dispositivo sem decode de hardware HEVC): o host
    // troca de codec e cria uma sessão `TransportCore` INTEIRAMENTE NOVA quando o espectador não
    // decodifica o codec pedido (`decoderOk:false`, ver handleWsMessage abaixo e
    // main/index.ts) — ICE ufrag/pwd e certificado DTLS ficam diferentes do offer original, não é
    // uma renegociação de verdade da MESMA conexão. Tentar `setRemoteDescription` desse offer novo
    // no `pc` antigo não funciona (credenciais ICE não batem). Antes disso, o hook só processava o
    // PRIMEIRO offer e ignorava qualquer um depois — o espectador ficava "conectando..." pra
    // sempre (o próprio bug reportado). Fix: cada offer novo recria o `RTCPeerConnection` do zero,
    // com os MESMOS handlers religados — mesma ideia do lado do host (sessão nova por completo).
    let pc: RTCPeerConnection | undefined;
    let latestIceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    fetchIceServers().then((iceServers) => {
      latestIceServers = iceServers;
      if (!cancelled) pc?.setConfiguration({ iceServers });
    });

    function setupPeerConnection(): RTCPeerConnection {
      const next = new RTCPeerConnection({ iceServers: latestIceServers });

      next.onconnectionstatechange = () => {
        if (pc !== next) return; // pc antigo sendo fechado/substituído — ignora eco tardio
        if (next.connectionState === "connected") everConnected = true;
        const map: Record<RTCPeerConnectionState, ConnectionState> = {
          new: ConnectionState.Connecting,
          connecting: ConnectionState.Connecting,
          connected: ConnectionState.Connected,
          disconnected: ConnectionState.Reconnecting,
          failed: ConnectionState.Disconnected,
          closed: ConnectionState.Disconnected,
        };
        setConnectionState(map[next.connectionState]);
        if (next.connectionState === "failed" || next.connectionState === "closed") {
          if (!cancelled) setPhase("ended");
        }
      };

      next.onicecandidate = (event) => {
        if (!event.candidate || pc !== next) return;
        sendWhenOpen({ type: "ice", candidate: event.candidate.candidate, mid: event.candidate.sdpMid ?? "0" });
      };

      next.ondatachannel = handleDataChannel;

      return next;
    }

    // WS de sinalização (ver backend/src/services/nativeWsRelay.ts e desktop/src/main/index.ts,
    // lado espelhado do host) — substitui o REST+polling anterior.
    //
    // Resiliência (item pendente do CLAUDE.md §Infraestrutura) — reconecta com backoff só ENQUANTO
    // a negociação inicial ainda não terminou (`everConnected` continua `false`): é a janela real
    // de risco (rede flakey bem no início). Depois de conectado, o DataChannel de mídia é
    // independente do WS — perder a sinalização não derruba o vídeo/áudio já fluindo. Não tenta
    // reagir a uma renegociação do host DEPOIS de já conectado (ex.: host caiu e voltou) — isso
    // continua exigindo remontar o player (mesma limitação documentada desde o Sprint 23), só a
    // fase de handshake inicial ficou resiliente.
    let ws = openNativeSignalingSocket(roomId, password);
    let everConnected = false;
    let wsReconnectAttempt = 0;
    let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const sendWhenOpen = (payload: Record<string, unknown>): void => {
      const json = JSON.stringify(payload);
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
      else ws.addEventListener("open", () => ws.send(json), { once: true });
    };
    sendMessageRef.current = sendWhenOpen;

    function attachWsHandlers(socket: WebSocket): void {
      socket.onopen = () => {
        wsReconnectAttempt = 0;
      };
      socket.onmessage = handleWsMessage;
      socket.onerror = () => {
        if (cancelled) return;
        setError("Erro na sinalização com o host.");
        setPhase("error");
      };
      socket.onclose = () => {
        if (cancelled || everConnected || wsReconnectTimer) return;
        const delayMs = Math.min(10_000, 1000 * 2 ** wsReconnectAttempt);
        wsReconnectAttempt++;
        wsReconnectTimer = setTimeout(() => {
          wsReconnectTimer = null;
          if (cancelled || everConnected) return;
          ws = openNativeSignalingSocket(roomId, password);
          attachWsHandlers(ws);
        }, delayMs);
      };
    }

    function handleDataChannel(event: RTCDataChannelEvent): void {
      if (event.channel.label === "audio") {
        const channel = event.channel;
        channel.binaryType = "arraybuffer";

        if (!audioPlayer) audioPlayer = new NativeAudioPlayer();
        const player = audioPlayer;
        if (videoRef.current) player.attachVideoElement(videoRef.current);
        setHasAudio(true);

        // Opus não tem conceito de keyframe/GOP como vídeo — todo pacote decodifica sozinho, por
        // isso `type: "key"` sempre. Apresentação pelo MESMO relógio do vídeo (`playout`).
        const decoder = new AudioDecoder({
          output: (audioData) => {
            // `videoRef` pode ter montado depois do canal abrir — liga o volume/mudo assim que der.
            if (videoRef.current) player.attachVideoElement(videoRef.current);
            const waitMs = playout.schedule(audioData.timestamp, performance.now());
            player.play(audioData, performance.now() + Math.max(0, waitMs));
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
      if (currentVideoTrack) mediaStream.removeTrack(currentVideoTrack);
      currentVideoTrack = generator;
      mediaStream.addTrack(generator);
      if (videoRef.current) videoRef.current.srcObject = mediaStream;

      let gotFirstFrame = false;
      let width = 0;
      let height = 0;

      // Watchdog — cobre falhas silenciosas que não passam pelo callback `error` do VideoDecoder
      // (ex.: `decode()` engolido no catch de `channel.onmessage` sem NUNCA chamar `output`, sem
      // nunca fechar o decoder de propósito). Sem isso, o único jeito de perceber que a tela
      // ficou preta pra sempre era o usuário reportar depois de esperar sem saber se ia carregar.
      const noFrameTimeout = setTimeout(() => {
        if (!cancelled && !gotFirstFrame) {
          setError("Não foi possível exibir o vídeo neste navegador/dispositivo. Tente um Chrome/Edge em Windows, Mac ou Android.");
          setPhase("error");
        }
      }, 12000);

      // Canal de volta pro host (ver TransportCore.h "Controle de latência"): ack de cada frame
      // recebido (8 bytes = o timestamp dele) — o host mede a fila real com isso e descarta frames
      // em vez de deixar a latência crescer quando a rede não dá conta —, e `'K'` pra pedir
      // keyframe (GOP infinito no host: sem IDR periódico pra se recuperar sozinho).
      let lastKeyframeRequestAt = -Infinity;
      const requestKeyframe = () => {
        const now = performance.now();
        if (channel.readyState !== "open" || now - lastKeyframeRequestAt < KEYFRAME_REQUEST_INTERVAL_MS) return;
        lastKeyframeRequestAt = now;
        try {
          channel.send(new Uint8Array([0x4b]));
        } catch {
          // canal fechando — a sessão vai ser recriada de qualquer jeito
        }
      };

      let waitingKeyframe = true;
      const decoderErrorTimes: number[] = [];

      const configureDecoder = (target: VideoDecoder) => {
        if (negotiatedCodec === "hevc") {
          // Codec string genérica (Main profile/tier, level 4.0) — assim como no H.264 abaixo, o
          // profile/level REAL vem do VPS/SPS embutido no bitstream Annex-B (`repeatSPSPPS`
          // equivalente do EncoderCore pro HEVC), essa string só é o feature-gate grosseiro que o
          // Chrome usa antes de sequer olhar os bytes.
          target.configure({ codec: "hev1.1.6.L120.B0", optimizeForLatency: true, hevc: { format: "annexb" } });
        } else if (negotiatedCodec === "av1") {
          // "av01.0.04M.08" = profile Main (0) + level 4.0 (04) + tier Main (M) + 8-bit (08) —
          // mesmo espírito de string genérica que HEVC/H.264 acima, o profile/level real vem do
          // Sequence Header embutido no bitstream (`repeatSeqHdr=1` no EncoderCore). Diferente de
          // avc/hevc, o WebCodecs não tem um sub-objeto `{format: "annexb"}` pro AV1 — o spec só
          // conhece o formato "low overhead" (OBUs crus concatenados), que é exatamente o que
          // `outputAnnexBFormat=0` no EncoderCore já produz.
          target.configure({ codec: "av01.0.04M.08", optimizeForLatency: true });
        } else {
          // `avc: { format: "annexb" }` — o encoder manda SPS/PPS embutido em CADA keyframe
          // (repeatSPSPPS=1 no EncoderCore), não precisa de `description` separada em AVCC.
          //
          // "avc1.64002a" = profile High (0x64) + level 4.2 (0x2a) — NÃO Baseline. O NVENC
          // (CreateDefaultEncoderParams com preset P4+LOW_LATENCY) escolhe High profile sozinho por
          // padrão; "avc1.42e01f" (Baseline) era resquício do SDP do caminho RTP antigo, nunca batia
          // com o bitstream real (confirmado via `ffprobe` no dump: `profile=High level=42`).
          target.configure({ codec: "avc1.64002a", optimizeForLatency: true, avc: { format: "annexb" } });
        }
      };

      const createDecoder = (): VideoDecoder => {
        const created = new VideoDecoder({
          output: (frame) => {
            if (!gotFirstFrame) {
              gotFirstFrame = true;
              clearTimeout(noFrameTimeout);
              width = frame.displayWidth;
              height = frame.displayHeight;
              setStats({ resolution: `${width} × ${height}`, fps: 0, bitrateKbps: 0, latencyMs: 0, packetLossPercent: 0 });
              setPhase("connected");
            } else if (frame.displayWidth !== width || frame.displayHeight !== height) {
              // Host trocou de fonte/redimensionou janela — atualiza o rótulo de resolução.
              width = frame.displayWidth;
              height = frame.displayHeight;
              setStats((prev) => (prev ? { ...prev, resolution: `${width} × ${height}` } : prev));
            }
            framesDecoded++;
            presentVideoFrame(writer, frame);
          },
          error: (e) => {
            // No WebCodecs, `error` = decoder FECHADO de vez (spec: irrecuperável) — todo
            // `decode()` seguinte falharia. Antes isso deixava a tela congelada pra sempre; agora
            // recria o decoder e pede keyframe pro host (GOP infinito: sem pedir, só viria no
            // próximo espectador entrando). Só desiste (erro visível) se repetir em sequência —
            // aí é incompatibilidade real do decoder/dispositivo (ex.: iPhone, ver histórico).
            // eslint-disable-next-line no-console
            console.error("[native-stream] erro no VideoDecoder:", e);
            const now = performance.now();
            decoderErrorTimes.push(now);
            while (decoderErrorTimes.length && now - decoderErrorTimes[0] > DECODER_ERROR_WINDOW_MS) decoderErrorTimes.shift();
            if (cancelled) return;
            if (decoderErrorTimes.length >= DECODER_ERROR_LIMIT) {
              setError(
                `Falha ao decodificar o vídeo neste navegador/dispositivo (${e instanceof Error ? e.message : String(e)}). Tente um Chrome/Edge em Windows, Mac ou Android.`,
              );
              setPhase("error");
              return;
            }
            decoder = createDecoder();
            waitingKeyframe = true;
            lastKeyframeRequestAt = -Infinity;
            requestKeyframe();
          },
        });
        configureDecoder(created);
        return created;
      };
      let decoder = createDecoder();

      channel.onmessage = (event) => {
        const buffer = event.data as ArrayBuffer;
        if (buffer.byteLength < 9) return;
        const view = new DataView(buffer);
        const isKeyframe = view.getUint8(0) === 0;
        const timestampUs = Number(view.getBigUint64(1, true));
        const payload = new Uint8Array(buffer, 9);
        bytesReceived += payload.byteLength;

        try {
          channel.send(new Uint8Array(buffer, 1, 8).slice());
        } catch {
          // canal fechando
        }

        if (waitingKeyframe) {
          // WebCodecs exige que o primeiro chunk depois de (re)configurar seja "key".
          if (!isKeyframe) {
            requestKeyframe();
            return;
          }
          waitingKeyframe = false;
        }
        if (decoder.state !== "configured") return;

        try {
          decoder.decode(new EncodedVideoChunk({ type: isKeyframe ? "key" : "delta", timestamp: timestampUs, data: payload }));
        } catch {
          // Chunk rejeitado — recupera no próximo keyframe.
          waitingKeyframe = true;
          requestKeyframe();
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
        setStats((prev) => (prev ? { ...prev, fps, bitrateKbps, latencyMs: playout.bufferMs } : prev));
      }, STATS_POLL_MS);
    };

    function handleWsMessage(event: MessageEvent): void {
      if (cancelled) return;
      let msg: { type?: string; sdp?: string; codec?: NativeVideoCodec; candidate?: string; mid?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "offer" && msg.sdp) {
        // Todo offer (o primeiro OU uma renegociação — ver comentário grande acima de
        // `setupPeerConnection`) recria o `RTCPeerConnection` do zero. Fecha o antigo primeiro:
        // sem isso, o `pc` velho ficaria pendurado gerando candidatos ICE e trocando estado sem
        // ninguém mais ouvir de verdade (só o novo é dono dos handlers).
        pc?.close();
        pc = setupPeerConnection();
        playout.reset();
        const activePc = pc;
        negotiatedCodec = msg.codec ?? "h264";
        (async () => {
          try {
            await activePc.setRemoteDescription({ type: "offer", sdp: msg.sdp! });

            // Checa suporte de DECODE antes de responder — Chrome só decodifica HEVC com hardware
            // disponível no dispositivo, inconsistente entre SO/GPU (diferente do H.264, ubíquo).
            // `false` aqui faz o host reiniciar o encoder em H.264 e renegociar (ver
            // beginNativeNegotiation em desktop/src/main/index.ts) — H.264 nunca precisa checar,
            // assumido sempre suportado.
            const decoderOk =
              negotiatedCodec === "hevc" ? await isHevcDecodeSupported()
              : negotiatedCodec === "av1" ? await isAv1DecodeSupported()
              : true;

            const answer = await activePc.createAnswer();
            await activePc.setLocalDescription(answer);
            if (!activePc.localDescription) throw new Error("Falha ao gerar resposta SDP.");
            sendWhenOpen({ type: "answer", sdp: activePc.localDescription.sdp, decoderOk });
          } catch (err) {
            if (cancelled || activePc !== pc) return; // sessão já foi substituída por outra renegociação — erro é do pc velho, ignora
            setError(err instanceof Error ? err.message : "Erro ao conectar na transmissão nativa.");
            setPhase("error");
          }
        })();
      } else if (msg.type === "ice" && msg.candidate) {
        pc?.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid ?? "0" }).catch(() => {});
      }
    }

    attachWsHandlers(ws);

    return () => {
      cancelled = true;
      sendMessageRef.current = null;
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      ws.close();
      if (statsInterval) clearInterval(statsInterval);
      pc?.close();
      audioPlayer?.close();
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

