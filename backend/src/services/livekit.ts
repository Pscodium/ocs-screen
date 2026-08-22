import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { config } from "../config.js";

// RoomServiceClient fala com a API HTTP do LiveKit (não o endpoint WebSocket que os clientes
// usam pra mídia) — mesmo host, só troca o protocolo.
const httpUrl = config.livekit.url.replace(/^ws/, "http");
const roomService = new RoomServiceClient(httpUrl, config.livekit.apiKey, config.livekit.apiSecret);

// Salas que o LiveKit considera "vivas" agora (tem publisher e/ou ainda não expirou vazia). Serve
// pra filtrar o mapa em memória de `rooms.ts`, que só é limpo por chamada explícita de DELETE —
// se o host cair sem avisar (crash, queda de rede), o registro local fica órfão até isso rodar.
export async function getLiveRoomIds(): Promise<Set<string>> {
  const rooms = await roomService.listRooms();
  return new Set(rooms.map((room) => room.name));
}

export async function createHostToken(roomId: string, identity: string): Promise<string> {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    ttl: config.room.tokenTtlSeconds,
  });
  token.addGrant({
    room: roomId,
    roomJoin: true,
    roomCreate: true,
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
  });
  return token.toJwt();
}

export async function createViewerToken(roomId: string, identity: string): Promise<string> {
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    ttl: config.room.tokenTtlSeconds,
  });
  token.addGrant({
    room: roomId,
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    canPublishData: false,
  });
  return token.toJwt();
}
