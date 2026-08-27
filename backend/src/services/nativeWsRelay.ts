import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { cancelRoomCleanup, scheduleRoomCleanup } from "./rooms.js";

// Sinalização do transporte nativo via WebSocket, multi-espectador (ver
// docs/NATIVE_CAPTURE.md Fase 4 — SFU do projeto: 1 sessão `TransportCore` por espectador, mesmo
// frame codificado mandado pra todas). Backend só faz relay (sem entender SDP/ICE de verdade),
// mas PRECISA rotear cada mensagem pro espectador certo — por isso, diferente do V1 (1 offer só
// pra sala), cada espectador tem seu próprio `viewerId` (gerado aqui, na conexão) e toda
// mensagem carrega esse id.
//
// Fluxo: espectador conecta → backend gera `viewerId`, avisa o host (`viewer-joined`) → host cria
// uma sessão NOVA (`transportCreateSession(viewerId, ...)`) e manda um offer PRÓPRIO pra esse
// espectador (`{type:"offer", viewerId, ...}`) → backend roteia pro espectador certo. Espectador
// nunca precisa saber o próprio `viewerId` (o backend estampa sozinho nas mensagens que o
// espectador manda, antes de repassar pro host).

export type NativeWsRole = "host" | "viewer";

interface RoomState {
  host: WebSocket | null;
  viewers: Map<string, WebSocket>;
}

const rooms = new Map<string, RoomState>();

function getOrCreate(roomId: string): RoomState {
  let state = rooms.get(roomId);
  if (!state) {
    state = { host: null, viewers: new Map() };
    rooms.set(roomId, state);
  }
  return state;
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

export function registerHostSocket(roomId: string, socket: WebSocket): void {
  const state = getOrCreate(roomId);
  // Substitui host anterior (app reaberto, reconexão) — fecha o antigo se ainda tiver vivo.
  if (state.host && state.host !== socket && state.host.readyState === state.host.OPEN) {
    state.host.close();
  }
  state.host = socket;
  // Host de verdade presente agora — cancela qualquer destruição pendente da sala (agendada na
  // criação, pra cobrir o caso de o host nunca aparecer, ou no "close" anterior, pra cobrir o
  // caso de o host ter caído e voltado). Ver comentário em `rooms.ts::createRoom`.
  cancelRoomCleanup(roomId);

  // Espectadores PERSISTEM entre reconexões de host (diferente do V1, onde qualquer troca de
  // conexão do host matava a sala inteira) — avisa de cada um já conectado pra esse host novo
  // criar sessão e negociar de novo com eles.
  for (const viewerId of state.viewers.keys()) {
    sendJson(socket, { type: "viewer-joined", viewerId });
  }

  socket.on("close", () => {
    if (state.host === socket) {
      state.host = null;
      // Host sumiu (crash, queda de rede sem voltar) — agenda a destruição da sala pra não ficar
      // "ativa" pra sempre sem transmissão real nenhuma por trás. O host já tenta reconectar
      // sozinho com backoff (main/index.ts, teto 10s) bem antes do TTL (5min por padrão,
      // `ROOM_EMPTY_TTL_SECONDS`) — reconexão de verdade cancela isso de novo lá em cima.
      scheduleRoomCleanup(roomId);
    }
  });

  // Sem isso, um erro de socket (reset de conexão, timeout, F5 repetido no espectador causando
  // aborts em sequência etc.) é um evento "error" sem listener — `ws`/Node relança como exceção
  // não tratada e derruba o PROCESSO INTEIRO do backend, matando toda transmissão ativa na
  // instância, não só a sessão desse espectador. `close` já é emitido em seguida de qualquer
  // forma (reconexão do host já trata isso), então aqui só precisa existir pra não deixar o erro
  // sem dono.
  socket.on("error", (err) => {
    console.warn(`[nativeWsRelay] erro no socket do host (sala ${roomId}):`, err);
  });

  // Mensagens do host (offer/ice) já vêm com `viewerId` — repassa cru pro espectador certo, sem
  // reserializar (o host é quem decide o conteúdo, backend só roteia pela chave).
  socket.on("message", (data) => {
    let msg: { viewerId?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg.viewerId) return;
    const viewerSocket = state.viewers.get(msg.viewerId);
    if (viewerSocket && viewerSocket.readyState === viewerSocket.OPEN) {
      viewerSocket.send(data.toString());
    }
  });
}

// Retorna o `viewerId` gerado — a rota chama isso só pra logging/depuração, o espectador em si
// nunca recebe nem precisa desse valor.
export function registerViewerSocket(roomId: string, socket: WebSocket): string {
  const state = getOrCreate(roomId);
  const viewerId = randomUUID();
  state.viewers.set(viewerId, socket);

  if (state.host) sendJson(state.host, { type: "viewer-joined", viewerId });

  socket.on("close", () => {
    state.viewers.delete(viewerId);
    if (state.host) sendJson(state.host, { type: "viewer-left", viewerId });
  });

  // Caso principal que motivou isso: espectador com carregamento lento apertando F5 repetido —
  // cada tentativa nova pode abortar a anterior com reset de conexão. Sem listener de "error"
  // aqui, isso derrubava o processo do backend inteiro (ver comentário equivalente em
  // `registerHostSocket` acima).
  socket.on("error", (err) => {
    console.warn(`[nativeWsRelay] erro no socket do espectador ${viewerId} (sala ${roomId}):`, err);
  });

  // Mensagens do espectador (answer/ice) NÃO carregam `viewerId` (ele não sabe o próprio id) —
  // o backend estampa antes de repassar pro host, que precisa saber de qual sessão é cada uma.
  socket.on("message", (data) => {
    if (!state.host || state.host.readyState !== state.host.OPEN) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    msg.viewerId = viewerId;
    state.host.send(JSON.stringify(msg));
  });

  return viewerId;
}

// Chamado junto com `deleteRoom` (mesmo ciclo de vida da sala) — fecha os sockets que sobrarem.
export function cleanupNativeSockets(roomId: string): void {
  const state = rooms.get(roomId);
  if (!state) return;
  state.host?.close();
  for (const socket of state.viewers.values()) socket.close();
  rooms.delete(roomId);
}
