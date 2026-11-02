import { Redis } from "ioredis";
import { config } from "../config.js";

// Prefixo em toda chave — o Redis é compartilhado com outros serviços da VPS.
export const REDIS_PREFIX = "ocs-screen:";

let client: Redis | null = null;

// null quando REDIS_URL não está configurado — quem chama trata como "recurso desligado".
export function getRedis(): Redis | null {
  if (!config.redisUrl) return null;
  if (!client) {
    client = new Redis(config.redisUrl, { keyPrefix: REDIS_PREFIX, maxRetriesPerRequest: 3 });
    // Sem listener, erro de conexão vira "error" sem dono e derruba o processo (ver server.ts).
    client.on("error", (err) => console.error("[redis]", err.message));
  }
  return client;
}
