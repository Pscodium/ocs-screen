import { AccessToken } from "livekit-server-sdk";
import { config } from "../config.js";

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
