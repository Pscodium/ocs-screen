import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createHostToken, createViewerToken, getLiveRoomViewerCounts } from "../services/livekit.js";
import { cancelRoomCleanup, checkRoomPassword, createRoom, deleteRoom, getRoom, listRooms, SlugTakenError } from "../services/rooms.js";
import { getNativeViewerCount, registerHostSocket, registerViewerSocket } from "../services/nativeWsRelay.js";
import { getIceServers } from "../services/turn.js";
import { generateIdentity, isValidSlug, normalizeSlug } from "../utils/ids.js";
import type {
  CreateRoomRequest,
  CreateRoomResponse,
  ListRoomsResponse,
  ViewerTokenResponse,
} from "../types/room.js";

const MAX_PASSWORD_LENGTH = 128;

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.get("/rooms", async (_request, reply) => {
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
      })),
    };
    return reply.send(response);
  });

  app.post<{ Body: CreateRoomRequest }>("/rooms", async (request, reply) => {
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
    let room;
    try {
      room = createRoom(hostIdentity, request.body?.settings, slug, request.body?.nativeMode, {
        isPrivate: request.body?.isPrivate === true,
        password: password || undefined,
      });
    } catch (err) {
      if (err instanceof SlugTakenError) return reply.code(409).send({ error: "slug_taken" });
      throw err;
    }
    const hostToken = await createHostToken(room.id, hostIdentity);

    const response: CreateRoomResponse = {
      roomId: room.id,
      hostToken,
      livekitUrl: config.livekit.url,
      viewerUrl: `${config.viewerUrl}/s/${room.id}`,
      nativeMode: room.nativeMode,
    };
    return reply.code(201).send(response);
  });

  app.get<{ Params: { id: string } }>("/rooms/:id", async (request, reply) => {
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
    });
  });

  // Viewer valida a senha antes de montar o player — o token/WS checam de novo, isso aqui é só
  // pra UI dar feedback imediato de senha errada.
  app.post<{ Params: { id: string }; Body: { password?: string } }>("/rooms/:id/auth", async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    if (!checkRoomPassword(room, request.body?.password)) return reply.code(401).send({ error: "invalid_password" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { password?: string } }>("/rooms/:id/token", async (request, reply) => {
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
  app.get("/ice-servers", async (_request, reply) => {
    return reply.send({ iceServers: getIceServers() });
  });

  app.delete<{ Params: { id: string } }>("/rooms/:id", async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    deleteRoom(room.id);
    return reply.code(204).send();
  });

  // Sinalização do transporte nativo via WebSocket, multi-espectador (libdatachannel, ver
  // docs/NATIVE_CAPTURE.md Fase 4) — host conecta uma vez (`?role=host`), cada espectador conecta
  // a própria vez (`?role=viewer`) e ganha um `viewerId` (gerado em nativeWsRelay.ts). Backend
  // roteia mensagens por `viewerId`, não faz broadcast — cada espectador negocia sua própria
  // sessão `TransportCore` com o host.
  app.get<{ Params: { id: string }; Querystring: { role?: string; password?: string } }>(
    "/rooms/:id/native/ws",
    { websocket: true },
    (socket, request) => {
      const roomId = request.params.id;
      const role = request.query.role;
      const room = getRoom(roomId);
      if (!room || (role !== "host" && role !== "viewer")) {
        socket.close();
        return;
      }
      if (role === "viewer" && !checkRoomPassword(room, request.query.password)) {
        socket.close();
        return;
      }
      if (role === "host") registerHostSocket(roomId, socket);
      else registerViewerSocket(roomId, socket);
    },
  );
}
