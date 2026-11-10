import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createHostToken, createViewerToken, getLiveRoomViewerCounts } from "../services/livekit.js";
import {
  cancelRoomCleanup,
  checkHostSecret,
  checkRoomPassword,
  createRoom,
  deleteRoom,
  generateHostSecret,
  getRoom,
  listRooms,
  RoomLimitError,
  SlugTakenError,
} from "../services/rooms.js";
import { isAppVersionSupported } from "./app.js";
import { getNativeViewerCount, registerHostSocket, registerViewerSocket, ROOM_CLOSED_CODE } from "../services/nativeWsRelay.js";
import { getIceServers } from "../services/turn.js";
import { notifyStreamStarted } from "../services/discordNotify.js";
import { generateIdentity, isValidSlug, normalizeSlug } from "../utils/ids.js";
import type {
  CreateRoomRequest,
  RoomSource,
  CreateRoomResponse,
  ListRoomsResponse,
  ViewerTokenResponse,
} from "../types/room.js";

const MAX_PASSWORD_LENGTH = 128;

// Limites por IP por minuto (@fastify/rate-limit, registrado em server.ts com `global: false`).
// Folgados pro uso normal — várias pessoas atrás do mesmo IP (LAN, CGNAT) não podem ser bloqueadas
// assistindo; o alvo é script martelando criação de sala, senha ou credencial TURN.
const perMinute = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

// Segredo do host: header no HTTP; no WebSocket vai na query (navegador não deixa setar header no
// WebSocket) — o logger do server.ts tira a query string dos logs por causa disso.
function hostSecretFromHeader(headers: Record<string, unknown>): string | undefined {
  const value = headers["x-host-secret"];
  return typeof value === "string" ? value : undefined;
}
const APP_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;

// `source` novo tem prioridade; sem ele, `isWebLive` (web publicado até a 1.0.15) e, sem nenhum
// dos dois, desktop — o app desktop já publicado não manda nada.
const MAX_HOST_NAME_LENGTH = 32;

// Nome livre vindo do cliente — vai parar numa DM do Discord, então: sem caractere de controle, sem
// markdown/menção (`@everyone`, `**`, links) e com tamanho curto. Vazio depois de limpar = null.
export function sanitizeHostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[`*_~|>#@<\[\]()\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = Array.from(clean).slice(0, MAX_HOST_NAME_LENGTH).join("").trim();
  return name.length > 0 ? name : null;
}

function resolveRoomOrigin(body: CreateRoomRequest | undefined): {
  source: RoomSource;
  appVersion: string | null;
  hostName: string | null;
} {
  const source: RoomSource =
    body?.source === "web" || body?.source === "desktop" ? body.source : body?.isWebLive === true ? "web" : "desktop";
  const appVersion = typeof body?.appVersion === "string" && APP_VERSION_PATTERN.test(body.appVersion) ? body.appVersion : null;
  return { source, appVersion, hostName: sanitizeHostName(body?.hostName) };
}

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.get("/rooms", perMinute(300), async (_request, reply) => {
    // O mapa local só sabe de salas criadas (POST /rooms) e destruídas por chamada explícita
    // (DELETE) — se o host caiu sem avisar, a sala fica presa lá pra sempre. O LiveKit é a fonte
    // de verdade de quem tá realmente ao vivo; cruza os dois e já aproveita pra descartar o que
    // sobrou órfão, sem precisar de ação manual nenhuma.
    let liveCounts: Map<string, number> | null = null;
    try {
      liveCounts = await getLiveRoomViewerCounts();
    } catch {
      // LiveKit inacessível não pode derrubar a listagem inteira — cai pra mostrar tudo que o
      // backend tem registrado, sem filtrar.
    }

    // Dá uma folga pras salas recém-criadas — entre o POST /rooms e o host efetivamente conectar
    // no LiveKit (captura + rede) passa um tempo curto em que a sala ainda não aparece lá; sem
    // essa folga, cairia bem nessa janela e purgaria uma sala que só está começando.
    const GRACE_MS = 20_000;
    const localRooms = listRooms();
    // Sala em modo nativo (libdatachannel, ver docs/NATIVE_CAPTURE.md Fase 4) nunca entra no
    // LiveKit — vídeo não passa por lá. Sem essa exceção, TODA sala nativa vira "órfã" pro cruzamento
    // abaixo e se autodestrói ~20s depois de criada mesmo transmitindo ativamente (bug real: apagava
    // offer/answer da sinalização nativa e sumia da lista de salas ativas em pleno vivo).
    const isOrphan = (room: (typeof localRooms)[number]) =>
      !room.nativeMode && liveCounts !== null && !liveCounts.has(room.id) && Date.now() - room.createdAt > GRACE_MS;

    const rooms = localRooms.filter((room) => !isOrphan(room) && !room.isPrivate);
    for (const room of localRooms) {
      if (isOrphan(room)) deleteRoom(room.id);
    }

    const response: ListRoomsResponse = {
      rooms: rooms.map((room) => ({
        roomId: room.id,
        createdAt: room.createdAt,
        settings: room.settings,
        hasPassword: room.passwordHash !== null,
        viewerCount: room.nativeMode ? getNativeViewerCount(room.id) : (liveCounts?.get(room.id) ?? null),
        viewerUrl: `${config.viewerUrl}/s/${room.id}`,
        source: room.source,
      })),
    };
    return reply.send(response);
  });

  app.post<{ Body: CreateRoomRequest }>("/rooms", perMinute(10), async (request, reply) => {
    const origin = resolveRoomOrigin(request.body);
    if (origin.source === "desktop" && !isAppVersionSupported(origin.appVersion)) {
      return reply.code(426).send({ error: "update_required", minVersion: config.minAppVersion });
    }

    let slug: string | undefined;
    if (request.body?.slug) {
      slug = normalizeSlug(request.body.slug);
      if (!isValidSlug(slug)) {
        return reply.code(400).send({ error: "invalid_slug" });
      }
    }

    const password = request.body?.password;
    if (password !== undefined && (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH)) {
      return reply.code(400).send({ error: "invalid_password" });
    }

    const hostIdentity = generateIdentity();
    const hostSecret = request.body?.hostAuth === true ? generateHostSecret() : null;
    let room;
    try {
      room = createRoom(hostIdentity, request.body?.settings, slug, request.body?.nativeMode, {
        isPrivate: request.body?.isPrivate === true,
        password: password || undefined,
      }, origin, hostSecret);
    } catch (err) {
      if (err instanceof SlugTakenError) return reply.code(409).send({ error: "slug_taken" });
      if (err instanceof RoomLimitError) return reply.code(503).send({ error: "room_limit" });
      throw err;
    }
    request.log.info(
      {
        roomId: room.id,
        source: room.source,
        appVersion: room.appVersion,
        nativeMode: room.nativeMode,
        hostAuth: hostSecret !== null,
        clientIp: request.ip,
      },
      "room created",
    );
    const hostToken = await createHostToken(room.id, hostIdentity);
    // Sala LiveKit: host publica logo em seguida, então "sala criada" ≈ "transmissão começou".
    // Sala nativa avisa só quando o host conecta de verdade no WS de sinalização (abaixo).
    if (!room.nativeMode) void notifyStreamStarted(room);

    const response: CreateRoomResponse = {
      roomId: room.id,
      hostToken,
      livekitUrl: config.livekit.url,
      viewerUrl: `${config.viewerUrl}/s/${room.id}`,
      nativeMode: room.nativeMode,
      ...(hostSecret ? { hostSecret } : {}),
    };
    return reply.code(201).send(response);
  });

  app.get<{ Params: { id: string } }>("/rooms/:id", perMinute(300), async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });

    // Player do espectador consulta isso periodicamente pro contador de quem tá assistindo.
    let viewerCount: number | null = null;
    if (room.nativeMode) {
      viewerCount = getNativeViewerCount(room.id);
    } else {
      try {
        viewerCount = (await getLiveRoomViewerCounts([room.id])).get(room.id) ?? 0;
      } catch {
        // LiveKit inacessível — player só esconde o contador.
      }
    }

    return reply.send({
      roomId: room.id,
      settings: room.settings,
      createdAt: room.createdAt,
      nativeMode: room.nativeMode,
      hasPassword: room.passwordHash !== null,
      viewerCount,
      source: room.source,
    });
  });

  // Viewer valida a senha antes de montar o player — o token/WS checam de novo, isso aqui é só
  // pra UI dar feedback imediato de senha errada.
  app.post<{ Params: { id: string }; Body: { password?: string } }>("/rooms/:id/auth", perMinute(20), async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (!checkRoomPassword(room, request.body?.password)) return reply.code(401).send({ error: "invalid_password" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>("/rooms/:id/token", perMinute(20), async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (!checkRoomPassword(room, request.body?.password)) return reply.code(401).send({ error: "invalid_password" });

    cancelRoomCleanup(room.id);
    const identity = generateIdentity();
    const token = await createViewerToken(room.id, identity);
    const response: ViewerTokenResponse = {
      token,
      livekitUrl: config.livekit.url,
      roomId: room.id,
    };
    return reply.send(response);
  });

  // ICE servers (STUN + TURN, ver services/turn.ts) — não é específico de sala nenhuma
  // (credencial TURN é curta, sem vínculo com o ID da sala), mas host e viewer só pedem isso
  // quando já estão prestes a negociar uma conexão de verdade (native transport), não antes.
  app.get("/ice-servers", perMinute(30), async (_request, reply) => {
    return reply.send({ iceServers: getIceServers() });
  });

  app.delete<{ Params: { id: string } }>("/rooms/:id", perMinute(30), async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (!checkHostSecret(room, hostSecretFromHeader(request.headers))) {
      return reply.code(403).send({ error: "invalid_host_secret" });
    }
    deleteRoom(room.id);
    return reply.code(204).send();
  });

  // Sinalização do transporte nativo via WebSocket, multi-espectador (libdatachannel, ver
  // docs/NATIVE_CAPTURE.md Fase 4) — host conecta uma vez (`?role=host`), cada espectador conecta
  // a própria vez (`?role=viewer`) e ganha um `viewerId` (gerado em nativeWsRelay.ts). Backend
  // roteia mensagens por `viewerId`, não faz broadcast — cada espectador negocia sua própria
  // sessão `TransportCore` com o host.
  app.get<{ Params: { id: string }; Querystring: { role?: string; password?: string; hostSecret?: string } }>(
    "/rooms/:id/native/ws",
    { websocket: true, ...perMinute(60) },
    (socket, request) => {
      const roomId = request.params.id;
      const role = request.query.role;
      const room = getRoom(roomId);
      if (role !== "host" && role !== "viewer") {
        socket.close();
        return;
      }
      // Sala não existe mais (encerrada, ou derrubada por estar travada): 4410 faz o app novo parar
      // de reconectar e avisar o host, em vez de ficar "ao vivo" sozinho pra sempre.
      if (!room) {
        socket.close(ROOM_CLOSED_CODE, "room_closed");
        return;
      }
      if (role === "viewer" && !checkRoomPassword(room, request.query.password)) {
        socket.close();
        return;
      }
      // Sem isso qualquer um conectava como host, derrubava o host real (registerHostSocket troca o
      // socket) e recebia/transmitia pros espectadores. 4403 = código de aplicação, o cliente para
      // de reconectar.
      if (role === "host" && !checkHostSecret(room, request.query.hostSecret)) {
        request.log.warn({ roomId, clientIp: request.ip }, "native ws host rejected");
        socket.close(4403, "invalid_host_secret");
        return;
      }
      // Rastro mínimo de quem entrou/saiu (IP real via trustProxy, ver config.ts) — a mídia não
      // passa pelo backend, então isso + POST /rooms/:id/telemetry é tudo que fica pra investigar
      // uma transmissão que falhou.
      const openedAt = Date.now();
      let viewerId: string | undefined;
      if (role === "host") {
        registerHostSocket(roomId, socket, request.ip);
        // Reconexões do host caem no cooldown por sala (discordNotify.ts) — só avisa uma vez.
        void notifyStreamStarted(room);
      } else viewerId = registerViewerSocket(roomId, socket, request.ip);
      request.log.info({ roomId, role, viewerId, clientIp: request.ip }, "native ws open");
      socket.on("close", (code) => {
        request.log.info({ roomId, role, viewerId, clientIp: request.ip, code, durationMs: Date.now() - openedAt }, "native ws close");
      });
    },
  );
}
