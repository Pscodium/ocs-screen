import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createHostToken, createViewerToken } from "../services/livekit.js";
import { cancelRoomCleanup, createRoom, deleteRoom, getRoom } from "../services/rooms.js";
import { generateIdentity } from "../utils/ids.js";
import type { CreateRoomRequest, CreateRoomResponse, ViewerTokenResponse } from "../types/room.js";

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateRoomRequest }>("/rooms", async (request, reply) => {
    const hostIdentity = generateIdentity();
    const room = createRoom(hostIdentity, request.body?.settings);
    const hostToken = await createHostToken(room.id, hostIdentity);

    const response: CreateRoomResponse = {
      roomId: room.id,
      hostToken,
      livekitUrl: config.livekit.url,
      viewerUrl: `${config.viewerUrl}/s/${room.id}`,
    };
    return reply.code(201).send(response);
  });

  app.get<{ Params: { id: string } }>("/rooms/:id", async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    return reply.send({ roomId: room.id, settings: room.settings, createdAt: room.createdAt });
  });

  app.post<{ Params: { id: string } }>("/rooms/:id/token", async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });

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

  app.delete<{ Params: { id: string } }>("/rooms/:id", async (request, reply) => {
    const room = getRoom(request.params.id);
    if (!room) return reply.code(404).send({ error: "room_not_found" });
    deleteRoom(room.id);
    return reply.code(204).send();
  });
}
