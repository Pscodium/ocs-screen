// Catálogo dos motivos de telemetria pro painel (AdminPage): o que cada código quer dizer, de que
// lado acontece (transmissor/espectador), em que etapa do pipeline, e quão grave é. Fonte dos
// códigos: `report(...)` em viewer/src (hooks/useNativeStream.ts, services/webNativeHost.ts) e
// `sendNativeTelemetry(...)` em desktop/src/main/index.ts.

export type Severity = "error" | "warn" | "info";
export type Stage = "captura" | "encoder" | "rede" | "decoder" | "sinalização" | "navegador" | "sessão";

export interface ReasonInfo {
  label: string;
  stage: Stage;
  severity: Severity;
  hint: string;
}

const R: Record<string, ReasonInfo> = {
  // ---- Transmissor ----
  viewer_no_data: { label: "Espectador conectou e não recebeu vídeo", stage: "encoder", severity: "error", hint: "Host não produziu/mandou frame em 10s após o espectador conectar. Ver encodedSinceConnect: 0 = encoder travado; >0 = rede." },
  encoder_restart: { label: "Encoder reiniciado (sem saída)", stage: "encoder", severity: "warn", hint: "1º degrau da recuperação automática. Repetido na mesma sessão = encoder da GPU travando." },
  encoder_fallback_mf: { label: "NVENC falhou → encoder alternativo da GPU", stage: "encoder", severity: "warn", hint: "2º degrau da recuperação." },
  encoder_fallback_cpu: { label: "GPU falhou → encoder por CPU", stage: "encoder", severity: "warn", hint: "Último degrau. Transmissão segue, mais pesada. Ver mftDiag pra saber onde a GPU travou." },
  encoder_recovery_failed: { label: "Nenhum encoder respondeu", stage: "encoder", severity: "error", hint: "Toda a escada falhou — espectadores sem vídeo." },
  encoder_resize_failed: { label: "Encoder não reiniciou após redimensionar janela", stage: "encoder", severity: "error", hint: "Transmissão encerrada." },
  encoder_init_failed: { label: "Encoder não inicializou", stage: "encoder", severity: "error", hint: "Nenhum encoder disponível no início." },
  encoder_error: { label: "Erro no VideoEncoder do navegador", stage: "encoder", severity: "warn", hint: "Ver lastEncoderError. Recria sozinho." },
  encode_exception: { label: "Exceção ao codificar frame", stage: "encoder", severity: "warn", hint: "Ver lastEncodeException." },
  encoder_software_fallback: { label: "Encoder do navegador caiu pra software", stage: "encoder", severity: "warn", hint: "Hardware do navegador falhou." },
  capture_start_failed: { label: "Captura de tela não iniciou", stage: "captura", severity: "error", hint: "" },
  device_lost_fatal: { label: "GPU resetou e não voltou", stage: "captura", severity: "error", hint: "TDR/driver — recriação do dispositivo falhou." },
  viewer_failed: { label: "Conexão com um espectador falhou", stage: "rede", severity: "warn", hint: "Sessão WebRTC do lado do host caiu." },
  session_error: { label: "Erro na sessão WebRTC do host", stage: "rede", severity: "warn", hint: "" },
  negotiation_error: { label: "Falha ao negociar conexão", stage: "sinalização", severity: "error", hint: "" },
  room_closed_unhealthy: { label: "Sala encerrada pelo servidor (travada)", stage: "sessão", severity: "error", hint: "O próprio app (≥1.5.3) relatou ~90s seguidos de tela mudando, espectador conectado e encoder sem entregar nada." },
  room_closed_admin: { label: "Sala encerrada pelo painel", stage: "sessão", severity: "info", hint: "Encerramento manual." },
  // ---- Espectador ----
  no_data: { label: "Conectou mas nenhum vídeo chegou", stage: "rede", severity: "error", hint: "Quase sempre o transmissor não está mandando — ver eventos do host na mesma sala." },
  connection_lost: { label: "Conexão perdida", stage: "rede", severity: "warn", hint: "Não conta como falha: costuma ser o host encerrando. Falha de verdade vira recovery_failed." },
  recovery_failed: { label: "Não reconectou", stage: "rede", severity: "error", hint: "Conexão caiu com a sala ainda aberta e não voltou dentro do prazo." },
  ice_failed: { label: "ICE falhou (sem caminho de rede)", stage: "rede", severity: "error", hint: "NAT/firewall. Ver iceLocalType/iceRemoteType (relay = passou pelo TURN)." },
  not_connected: { label: "Nunca conectou", stage: "rede", severity: "error", hint: "Canal de vídeo não abriu." },
  signaling_error: { label: "Erro de sinalização", stage: "sinalização", severity: "error", hint: "WebSocket/backend." },
  decode_error: { label: "Erro no decoder de vídeo", stage: "decoder", severity: "error", hint: "Ver lastDecoderError, gpu e decoderHw." },
  unsupported: { label: "Navegador sem suporte", stage: "navegador", severity: "error", hint: "Sem WebCodecs/MediaStreamTrackGenerator (Firefox/Safari)." },
  reconnected: { label: "Reconectou", stage: "rede", severity: "info", hint: "Recuperação — não é falha." },
  recovered_after_error: { label: "Vídeo chegou depois de atraso", stage: "rede", severity: "info", hint: "1º frame depois de 12s. Recuperação — não é falha." },
  end: { label: "Fim da sessão", stage: "sessão", severity: "info", hint: "" },
};

export function reasonInfo(reason: string): ReasonInfo {
  return R[reason] ?? { label: reason, stage: "sessão", severity: "warn", hint: "Motivo sem descrição no painel." };
}

export type EventData = Record<string, string | number | boolean | null>;

export function roleLabel(role: string, source: string): string {
  const who = role === "host" ? "Transmissor" : "Espectador";
  const where = source === "desktop" ? "app" : "navegador";
  return `${who} (${where})`;
}

// "ANGLE (AMD, Radeon RX 6600 (0x...) Direct3D11 ...)" → "AMD Radeon RX 6600"
export function shortGpu(gpu: unknown): string | null {
  if (typeof gpu !== "string" || !gpu) return null;
  const m = /ANGLE \(([^,]+),\s*([^(,]+)/.exec(gpu);
  if (!m) return gpu.slice(0, 40);
  const vendor = m[1].trim();
  const model = m[2].trim();
  return model.toLowerCase().startsWith(vendor.toLowerCase()) ? model : `${vendor} ${model}`;
}

// Ambiente: GPU/encoder (host desktop) ou GPU/navegador (web).
export function envSummary(source: string, d: EventData): string {
  const parts: string[] = [];
  if (source === "desktop") {
    const enc = d.softwareEncoder === false ? "NVENC" : d.hardwareMft ? "GPU via MF (AMD/Intel)" : d.softwareEncoder ? "CPU" : null;
    if (enc) parts.push(enc);
    if (d.codec) parts.push(String(d.codec).toUpperCase());
    if (d.captureKind) parts.push(d.captureKind === "window" ? "janela" : "monitor");
  } else {
    const gpu = shortGpu(d.gpu);
    if (gpu) parts.push(gpu);
    // userAgentData traz marca "fake" (GREASE, ex.: "Not?A_Brand") — relatórios antigos guardaram ela.
    if (d.browser) parts.push(/brand/i.test(String(d.browser)) ? "Chromium" : String(d.browser));
    if (d.decoderHw === false) parts.push("decoder sem GPU");
    if (d.hardwareAccelerated === false) parts.push("encoder sem GPU");
  }
  return parts.join(" · ") || "—";
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

// O que o evento diz de concreto, em uma linha.
export function detailSummary(role: string, d: EventData): string {
  const parts: string[] = [];
  if (role === "host") {
    if (d.framesAcquired !== undefined) parts.push(`${num(d.encodedPackets)}/${num(d.framesAcquired)} frames codificados`);
    if (d.chunksEncoded !== undefined) parts.push(`${num(d.chunksEncoded)} frames codificados`);
    if (d.sendFail) parts.push(`${num(d.sendFail)} envios falharam`);
    if (d.viewersConnected !== undefined) parts.push(`${num(d.viewersConnected)} espectador(es)`);
    if (d.viewersNow !== undefined) parts.push(`${num(d.viewersNow)} espectador(es)`);
    if (d.lastEncoderError) parts.push(String(d.lastEncoderError));
    if (d.lastEncodeException) parts.push(String(d.lastEncodeException));
    if (d.mftDiag) parts.push(`mft: ${d.mftDiag}`);
  } else {
    parts.push(`${num(d.framesDecoded)} frames decodificados`);
    if (d.decoderErrors) parts.push(`${num(d.decoderErrors)} erros de decoder`);
    if (d.lastDecoderError) parts.push(String(d.lastDecoderError));
    if (d.lostReason) parts.push(`motivo: ${d.lostReason}`);
    if (d.iceLocalType) parts.push(`ICE ${d.iceLocalType}→${d.iceRemoteType ?? "?"}`);
    if (d.rttMs) parts.push(`RTT ${num(d.rttMs)}ms`);
  }
  if (d.visibility === "hidden") parts.push("aba em 2º plano");
  return parts.join(" · ");
}

export function fmtDuration(ms: unknown): string {
  const s = Math.round(num(ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
