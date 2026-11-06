import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { fetchIceServers, openNativeSignalingSocket, roomExists, type NativeVideoCodec } from "../services/backend";
import type { ConnectionPhase, StreamStats } from "./useRoomStream";
import { PLAYOUT_DELAY_MAX_MS } from "./useRoomStream";
import { PlayoutClock } from "../services/playoutClock";
import { NativeAudioPlayer } from "../services/nativeAudioPlayer";
import { VideoPresenter } from "../services/videoPresenter";
import { newTelemetrySessionId, selectedCandidateInfo, sendTelemetry, type TelemetryData } from "../services/telemetry";

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
// Sem DataChannel de vídeo aberto depois disso = negociação/ICE travada — manda relatório (a UI
// continua "conectando", só o diagnóstico sai).
const NOT_CONNECTED_REPORT_MS = 20_000;
// Conexão com o host caiu depois de já estar assistindo: espera o host voltar (queda de rede,
// app reaberto na mesma sala) até isso antes de declarar "transmissão encerrada". Sala apagada
// (host encerrou de propósito) encerra na hora, sem esperar.
const RECOVERY_DEADLINE_MS = 60_000;

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
    // Setado ANTES do canal de vídeo abrir de verdade (só abre depois do SDP fechar) — o handler
    // de `ondatachannel` mais abaixo lê essa variável já com o valor certo.
    let negotiatedCodec: NativeVideoCodec = "h264";

    // Diagnóstico (ver services/telemetry.ts) — contadores acumulados da sessão inteira, mandados
    // pro backend só quando algo dá errado ou a sessão termina. Nada aqui gera tráfego por frame.
    const telemetrySessionId = newTelemetrySessionId();
    const sessionStartedAt = performance.now();
    const sinceStart = () => Math.round(performance.now() - sessionStartedAt);
    const tm = {
      wsOpens: 0,
      offers: 0,
      answersSent: 0,
      remoteCandidates: 0,
      pcState: "new" as string,
      iceState: "new" as string,
      connectedAtMs: null as number | null,
      videoChannelOpenAtMs: null as number | null,
      audioChannel: false,
      videoMessages: 0,
      videoBytes: 0,
      keyframesReceived: 0,
      framesDecoded: 0,
      firstFrameAtMs: null as number | null,
      decoderErrors: 0,
      lastDecoderError: null as string | null,
      recoveries: 0,
      ice: {} as TelemetryData,
    };
    const reportedReasons = new Set<string>();
    const report = (reason: string, extra: TelemetryData = {}) => {
      if (reportedReasons.has(reason)) return;
      reportedReasons.add(reason);
      const { ice, ...counters } = tm;
      sendTelemetry(roomId, "viewer", reason, telemetrySessionId, {
        ...counters,
        ...ice,
        codec: negotiatedCodec,
        elapsedMs: sinceStart(),
        webCodecs: typeof VideoDecoder !== "undefined",
        trackGenerator: typeof MediaStreamTrackGenerator !== "undefined",
        visibility: document.visibilityState,
        ...extra,
      });
    };

    if (typeof MediaStreamTrackGenerator === "undefined" || typeof VideoDecoder === "undefined") {
      report("unsupported");
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

    // Frames saem alinhados ao vsync (ver services/videoPresenter.ts), não por `setTimeout`.
    const presenter = new VideoPresenter();
    function presentVideoFrame(writer: WritableStreamDefaultWriter<VideoFrame>, frame: VideoFrame): void {
      const now = performance.now();
      const waitMs = playout.schedule(frame.timestamp, now, "video");
      presenter.enqueue(writer, frame, now + Math.max(0, waitMs));
    }


    // Compartilhado entre vídeo e áudio, e entre RECRIAÇÕES de `pc` (ver `setupPeerConnection`
    // abaixo) — os dois canais podem abrir em qualquer ordem (áudio é opcional, só existe se a
    // captura nativa do host tiver conseguido inicializar), então nenhum branch pode assumir que é
    // o primeiro a criar o `MediaStream` do `<video>`. Mantém a MESMA instância entre renegociações
    // pra não precisar reatribuir `videoRef.current.srcObject` de novo (evita um flash/reload do
    // elemento `<video>`) — só troca as TRACKS de dentro dela.
    //
    // Exceção (teste A6, tela preta depois do fallback de codec até dar F5): trocar a track DENTRO
    // da mesma MediaStream não garante que o `<video>` passe a renderizar a nova — cada canal de
    // vídeo novo ganha uma MediaStream nova + `srcObject` reatribuído + `play()`.
    let currentVideoTrack: MediaStreamTrack | null = null;
    // Limpa o canal de vídeo da sessão anterior (watchdog, stats, decoder) quando um offer novo
    // recria a conexão — antes ficavam pendurados (intervalo de stats duplicado, watchdog do canal
    // velho podendo marcar erro na sessão nova).
    let teardownVideoChannel: (() => void) | null = null;
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

      next.oniceconnectionstatechange = () => {
        if (pc === next) tm.iceState = next.iceConnectionState;
      };
      next.onconnectionstatechange = () => {
        if (pc !== next) return; // pc antigo sendo fechado/substituído — ignora eco tardio
        tm.pcState = next.connectionState;
        if (next.connectionState === "connected") {
          everConnected = true;
          if (tm.connectedAtMs === null) tm.connectedAtMs = sinceStart();
          void selectedCandidateInfo(next).then((info) => {
            tm.ice = info;
          });
        }
        if (next.connectionState === "failed") report("ice_failed");
        const map: Record<RTCPeerConnectionState, ConnectionState> = {
          new: ConnectionState.Connecting,
          connecting: ConnectionState.Connecting,
          connected: ConnectionState.Connected,
          disconnected: ConnectionState.Reconnecting,
          failed: ConnectionState.Disconnected,
          closed: ConnectionState.Disconnected,
        };
        // Durante a recuperação o estado fica "Reconectando..." até o vídeo voltar (o `pc` velho
        // chegando em "failed" no meio dela não pode tirar o aviso da tela).
        if (!recovering) setConnectionState(map[next.connectionState]);
        if (next.connectionState === "failed" || next.connectionState === "closed") {
          startRecovery(`pc_${next.connectionState}`);
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
    // Resiliência — reconecta o WS com backoff enquanto a negociação inicial não terminou
    // (`everConnected` false) OU durante uma recuperação (`recovering`, ver `startRecovery`).
    // Assistindo normalmente, o DataChannel de mídia é independente do WS — perder só a
    // sinalização não derruba o vídeo, então não reconecta à toa (reconectar = `viewerId` novo =
    // o host derrubaria a sessão que está funcionando).
    let ws = openNativeSignalingSocket(roomId, password);
    let everConnected = false;
    let wsReconnectAttempt = 0;
    let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Recuperação depois de já estar assistindo (host caiu e voltou, rede piscou): mantém o
    // `<video>` com o último frame + "Reconectando...", reabre a sinalização (o host ganha um
    // `viewer-joined` e manda um offer novo — cada offer já recria o `pc`, ver `handleWsMessage`)
    // e só desiste se a sala sumiu ou passou RECOVERY_DEADLINE_MS. O 1º frame do canal novo
    // encerra a recuperação (`finishRecovery`).
    let recovering = false;
    let recoveryDeadline: ReturnType<typeof setTimeout> | null = null;

    const endStream = () => {
      if (cancelled) return;
      recovering = false;
      if (recoveryDeadline) clearTimeout(recoveryDeadline);
      recoveryDeadline = null;
      report("end");
      setPhase("ended");
    };

    const reopenSignaling = () => {
      if (cancelled) return;
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
      const old = ws;
      old.onclose = null;
      old.onerror = null;
      old.onmessage = null;
      old.close();
      ws = openNativeSignalingSocket(roomId, password);
      attachWsHandlers(ws);
    };

    function startRecovery(reason: string): void {
      if (cancelled || recovering) return;
      recovering = true;
      tm.recoveries++;
      report("connection_lost", { lostReason: reason });
      setConnectionState(ConnectionState.Reconnecting);
      recoveryDeadline = setTimeout(endStream, RECOVERY_DEADLINE_MS);
      void roomExists(roomId).then((exists) => {
        if (cancelled || !recovering) return;
        if (exists === false) endStream();
        else reopenSignaling();
      });
    }

    function finishRecovery(): void {
      if (!recovering) return;
      recovering = false;
      if (recoveryDeadline) clearTimeout(recoveryDeadline);
      recoveryDeadline = null;
      reportedReasons.delete("connection_lost"); // próxima queda também é relatada
      report("reconnected");
      reportedReasons.delete("reconnected");
      setConnectionState(ConnectionState.Connected);
    }

    const sendWhenOpen = (payload: Record<string, unknown>): void => {
      const json = JSON.stringify(payload);
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
      else ws.addEventListener("open", () => ws.send(json), { once: true });
    };
    sendMessageRef.current = sendWhenOpen;

    function attachWsHandlers(socket: WebSocket): void {
      socket.onopen = () => {
        wsReconnectAttempt = 0;
        tm.wsOpens++;
      };
      socket.onmessage = handleWsMessage;
      socket.onerror = () => {
        if (cancelled) return;
        report("signaling_error");
        // Já assistindo/recuperando: o `onclose` seguinte cuida (reconexão ou fim) — não vira erro.
        if (everConnected) return;
        setError("Erro na sinalização com o host.");
        setPhase("error");
      };
      socket.onclose = () => {
        if (cancelled || (everConnected && !recovering) || wsReconnectTimer) return;
        const delayMs = Math.min(10_000, 1000 * 2 ** wsReconnectAttempt);
        wsReconnectAttempt++;
        wsReconnectTimer = setTimeout(async () => {
          wsReconnectTimer = null;
          if (cancelled || (everConnected && !recovering)) return;
          // Backend fecha o WS na hora quando a sala não existe mais — host encerrou.
          if (recovering && (await roomExists(roomId)) === false) {
            endStream();
            return;
          }
          if (cancelled) return;
          ws = openNativeSignalingSocket(roomId, password);
          attachWsHandlers(ws);
        }, delayMs);
      };
    }

    function handleDataChannel(event: RTCDataChannelEvent): void {
      if (event.channel.label === "audio") {
        const channel = event.channel;
        channel.binaryType = "arraybuffer";

        if (!audioPlayer) {
          audioPlayer = new NativeAudioPlayer();
          // Teste E2E (sincronia A/V): se a página definiu `window.__ocsAvSync = []`, registra o
          // atraso do áudio vs. o relógio do vídeo ao longo do tempo.
          audioPlayer.onSyncStats = (stats) => {
            const log = (window as unknown as { __ocsAvSync?: unknown[] }).__ocsAvSync;
            log?.push({ atMs: performance.now(), ...stats, bufferMs: playout.bufferMs });
          };
        }
        tm.audioChannel = true;
        const player = audioPlayer;
        if (videoRef.current) player.attachVideoElement(videoRef.current);
        setHasAudio(true);

        // Opus não tem conceito de keyframe/GOP como vídeo — todo pacote decodifica sozinho, por
        // isso `type: "key"` sempre. Apresentação pelo MESMO relógio do vídeo (`playout`).
        const decoder = new AudioDecoder({
          output: (audioData) => {
            // `videoRef` pode ter montado depois do canal abrir — liga o volume/mudo assim que der.
            if (videoRef.current) player.attachVideoElement(videoRef.current);
            const waitMs = playout.schedule(audioData.timestamp, performance.now(), "audio");
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
      teardownVideoChannel?.();
      if (tm.videoChannelOpenAtMs === null) tm.videoChannelOpenAtMs = sinceStart();
      // Canal fecha na hora quando o host encerra ou cai (o `pc` só vira "failed" ~30s depois) —
      // a recuperação confere se a sala ainda existe: não existe = encerrou de propósito.
      const channelPc = pc;
      channel.addEventListener("close", () => {
        if (!cancelled && pc === channelPc) startRecovery("channel_closed");
      });
      const generator = new MediaStreamTrackGenerator<VideoFrame>({ kind: "video" });
      const writer = generator.writable.getWriter();
      currentVideoTrack?.stop();
      currentVideoTrack = generator;
      if (videoRef.current) {
        videoRef.current.srcObject = new MediaStream([generator]);
        videoRef.current.play().catch(() => {});
      }

      let gotFirstFrame = false;
      let width = 0;
      let height = 0;

      // Watchdog — cobre falhas silenciosas que não passam pelo callback `error` do VideoDecoder
      // (ex.: `decode()` engolido no catch de `channel.onmessage` sem NUNCA chamar `output`, sem
      // nunca fechar o decoder de propósito). Sem isso, o único jeito de perceber que a tela
      // ficou preta pra sempre era o usuário reportar depois de esperar sem saber se ia carregar.
      //
      // A mensagem distingue "nada chegou" (conexão aberta, 0 bytes — o host não está mandando
      // vídeo: encoder/GPU ou rede de quem transmite) de "chegou mas não decodificou" (aí sim é o
      // navegador/dispositivo de quem assiste). Antes tudo virava "navegador não suporta" — caso
      // real: host com problema e espectadores no Chrome achando que o navegador deles era o culpado.
      const noFrameTimeout = setTimeout(() => {
        if (!cancelled && !gotFirstFrame) {
          const nothingArrived = tm.videoBytes === 0;
          report(nothingArrived ? "no_data" : "no_frame");
          setError(
            nothingArrived
              ? "A conexão com quem está transmitindo abriu, mas nenhum vídeo chegou. O problema provavelmente está do lado de quem transmite — peça para encerrar e iniciar a transmissão de novo."
              : tm.keyframesReceived === 0
                ? "O vídeo está chegando, mas sem nenhum quadro completo (keyframe) de quem transmite. Peça para encerrar e iniciar a transmissão de novo."
                : "Não foi possível exibir o vídeo neste navegador/dispositivo. Tente um Chrome/Edge em Windows, Mac ou Android.",
          );
          // Lado do host (nada chegou / sem keyframe): continua "conectando" com a mensagem por
          // cima — o `<video>` fica montado e, se o host se recuperar (paliativo do encoder), o 1º
          // frame limpa o erro sozinho. Só o caso de decode local vira erro definitivo.
          if (!nothingArrived && tm.keyframesReceived > 0) setPhase("error");
        }
      }, 12000);
      // Enquanto o 1º keyframe não chega, repete o pedido — o pedido feito na abertura do canal
      // pode se perder (sessão ainda conectando do lado do host) e, sem frame nenhum chegando, o
      // `requestKeyframe` do `onmessage` nunca roda.
      const keyframeRetry = setInterval(() => {
        if (waitingKeyframe) requestKeyframe();
      }, KEYFRAME_REQUEST_INTERVAL_MS);

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
            tm.framesDecoded++;
            if (!gotFirstFrame) {
              gotFirstFrame = true;
              finishRecovery();
              if (tm.firstFrameAtMs === null) tm.firstFrameAtMs = sinceStart();
              // Host pode se recuperar depois do watchdog já ter mostrado "nenhum vídeo chegou"
              // (paliativo de recriar o encoder, ver webNativeHost.ts/main) — o canal continua
              // aberto, então o 1º frame que chegar limpa o erro.
              if (tm.firstFrameAtMs > 12000) report("recovered_after_error");
              setError(null);
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
            tm.decoderErrors++;
            tm.lastDecoderError = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);
            const now = performance.now();
            decoderErrorTimes.push(now);
            while (decoderErrorTimes.length && now - decoderErrorTimes[0] > DECODER_ERROR_WINDOW_MS) decoderErrorTimes.shift();
            if (cancelled) return;
            if (decoderErrorTimes.length >= DECODER_ERROR_LIMIT) {
              report("decode_error");
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

      // Frame maior que o `max-message-size` do canal chega em pedaços (bit 0x80 no 1º byte = tem
      // mais pedaço deste frame — ver TransportCore::SendVideoFrame). Ack só do frame inteiro.
      let fragments: Uint8Array[] = [];
      let fragmentTimestampUs = -1;

      channel.onmessage = (event) => {
        const buffer = event.data as ArrayBuffer;
        if (buffer.byteLength < 9) return;
        const view = new DataView(buffer);
        const flags = view.getUint8(0);
        const isKeyframe = (flags & 0x7f) === 0;
        const timestampUs = Number(view.getBigUint64(1, true));
        let payload = new Uint8Array(buffer, 9);
        if ((flags & 0x80) !== 0 || fragments.length > 0) {
          if (fragments.length > 0 && timestampUs !== fragmentTimestampUs) fragments = [];
          fragmentTimestampUs = timestampUs;
          fragments.push(payload);
          if ((flags & 0x80) !== 0) return;
          const total = fragments.reduce((sum, part) => sum + part.byteLength, 0);
          payload = new Uint8Array(total);
          let offset = 0;
          for (const part of fragments) {
            payload.set(part, offset);
            offset += part.byteLength;
          }
          fragments = [];
        }
        bytesReceived += payload.byteLength;
        tm.videoMessages++;
        tm.videoBytes += payload.byteLength;
        if (isKeyframe) tm.keyframesReceived++;

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

      teardownVideoChannel = () => {
        clearTimeout(noFrameTimeout);
        clearInterval(keyframeRetry);
        if (statsInterval) clearInterval(statsInterval);
        statsInterval = null;
        channel.onmessage = null;
        if (decoder.state !== "closed") decoder.close();
      };

      if (statsInterval) clearInterval(statsInterval);
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
      let msg: { type?: string; sdp?: string; codec?: NativeVideoCodec; candidate?: string; mid?: string; tier?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "offer" && msg.sdp) {
        tm.offers++;
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
            tm.answersSent++;
          } catch (err) {
            if (cancelled || activePc !== pc) return; // sessão já foi substituída por outra renegociação — erro é do pc velho, ignora
            report("negotiation_error", { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
            setError(err instanceof Error ? err.message : "Erro ao conectar na transmissão nativa.");
            setPhase("error");
          }
        })();
      } else if (msg.type === "quality-changed" && (msg.tier === "high" || msg.tier === "low")) {
        // Host rebaixou este espectador sozinho (rede dele não aguentava o "high" enquanto os
        // outros estavam bem — ver `demoteCongestedHighViewers` em desktop/src/main/index.ts).
        setQualityState(msg.tier);
      } else if (msg.type === "ice" && msg.candidate) {
        tm.remoteCandidates++;
        pc?.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid ?? "0" }).catch(() => {});
      }
    }

    attachWsHandlers(ws);

    const notConnectedTimer = setTimeout(() => {
      if (!cancelled && tm.videoChannelOpenAtMs === null) report("not_connected");
    }, NOT_CONNECTED_REPORT_MS);

    // Fechar a aba não roda o cleanup do React — `pagehide` cobre esse caso (o `keepalive` do
    // fetch deixa o relatório sair mesmo com a página indo embora).
    const onPageHide = () => report("end");
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      if (recoveryDeadline) clearTimeout(recoveryDeadline);
      // Montagem descartada na hora (StrictMode em dev) não vira relatório.
      if (tm.wsOpens > 0 || sinceStart() > 2000) report("end");
      clearTimeout(notConnectedTimer);
      cancelled = true;
      sendMessageRef.current = null;
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      ws.close();
      teardownVideoChannel?.();
      if (statsInterval) clearInterval(statsInterval);
      pc?.close();
      audioPlayer?.close();
      presenter.close();
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

