import { config } from "../config.js";
import { getRedis } from "./redis.js";
import type { Room } from "../types/room.js";

// Bot do Discord só pra avisar por DM que uma transmissão começou. Sem login/OAuth: a pessoa se
// inscreve clicando num botão (ou /avisar) dentro do servidor do Discord e o único dado guardado é
// o ID do usuário do Discord, num SET do Redis. Botão "Parar" (ou /parar) remove — é também a
// "exclusão de dados".

const API = "https://discord.com/api/v10";
const SUBSCRIBERS_KEY = "discord:subscribers";
// Um aviso por sala nesse intervalo — reconexão do host / sala recriada com o mesmo slug não vira spam.
const NOTIFY_COOLDOWN_SECONDS = 10 * 60;
// Folga entre DMs pra ficar bem longe do rate limit global (50 req/s) — volume aqui é pequeno.
const DM_INTERVAL_MS = 250;

export const CUSTOM_ID_SUBSCRIBE = "notify:subscribe";
export const CUSTOM_ID_UNSUBSCRIBE = "notify:unsubscribe";

// Códigos de erro do Discord que significam "nunca vai dar pra mandar DM pra esse usuário" —
// remove da lista em vez de tentar de novo toda live.
const UNREACHABLE_CODES = new Set([
  50007, // Cannot send messages to this user (DM fechada / não divide servidor com o bot)
  10013, // Unknown User
]);

export function isDiscordConfigured(): boolean {
  return Boolean(config.discord.botToken && config.discord.publicKey && getRedis());
}

export async function subscribe(userId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.sadd(SUBSCRIBERS_KEY, userId)) === 1;
}

export async function unsubscribe(userId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.srem(SUBSCRIBERS_KEY, userId)) === 1;
}

export async function isSubscribed(userId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.sismember(SUBSCRIBERS_KEY, userId)) === 1;
}

class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

async function discordFetch(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bot ${config.discord.botToken}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.ceil((data.retry_after ?? 1) * 1000));
      continue;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
      throw new DiscordApiError(res.status, data.code, data.message ?? res.statusText);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new DiscordApiError(429, undefined, "rate limited");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RESOLUTION_LABEL: Record<Room["settings"]["resolution"], string> = {
  auto: "Automática",
  "720p": "720p",
  "1080p": "1080p",
  "1440p": "1440p",
  "2160p": "4K",
};

function buildMessage(room: Room): unknown {
  const viewerUrl = `${config.viewerUrl}/s/${room.id}`;
  const fps = room.settings.fps === "auto" ? "Automático" : `${room.settings.fps} FPS`;
  return {
    embeds: [
      {
        title: "🔴 Transmissão ao vivo",
        description: `Uma transmissão acabou de começar: **${room.id}**`,
        url: viewerUrl,
        color: 0xe5484d,
        fields: [
          { name: "Resolução", value: RESOLUTION_LABEL[room.settings.resolution], inline: true },
          { name: "FPS", value: fps, inline: true },
          ...(room.passwordHash ? [{ name: "Acesso", value: "🔒 Protegida por senha", inline: true }] : []),
        ],
        timestamp: new Date(room.createdAt).toISOString(),
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Assistir", url: viewerUrl },
          { type: 2, style: 2, label: "Parar de receber", custom_id: CUSTOM_ID_UNSUBSCRIBE, emoji: { name: "🔕" } },
        ],
      },
    ],
  };
}

async function sendDm(userId: string, message: unknown): Promise<void> {
  const channel = (await discordFetch("/users/@me/channels", {
    method: "POST",
    body: { recipient_id: userId },
  })) as { id: string };
  await discordFetch(`/channels/${channel.id}/messages`, { method: "POST", body: message });
}

// Chamado quando a transmissão começa de fato (routes/rooms.ts). Nunca lança — falha de aviso não
// pode afetar a transmissão; roda em segundo plano (não aguardar).
export async function notifyStreamStarted(room: Room): Promise<void> {
  try {
    if (!config.discord.notifyEnabled || !isDiscordConfigured() || room.isPrivate) return;
    const redis = getRedis()!;
    // SET NX: só o primeiro "começou" de cada sala dentro do cooldown avisa.
    const first = await redis.set(`discord:notified:${room.id}`, "1", "EX", NOTIFY_COOLDOWN_SECONDS, "NX");
    if (first !== "OK") return;

    const subscribers = await redis.smembers(SUBSCRIBERS_KEY);
    const message = buildMessage(room);
    for (const userId of subscribers) {
      try {
        await sendDm(userId, message);
      } catch (err) {
        if (err instanceof DiscordApiError && err.code !== undefined && UNREACHABLE_CODES.has(err.code)) {
          await unsubscribe(userId);
        } else {
          console.error(`[discord] falha ao avisar ${userId}:`, err);
        }
      }
      await sleep(DM_INTERVAL_MS);
    }
  } catch (err) {
    console.error("[discord] notifyStreamStarted:", err);
  }
}

// Slash commands do bot — registrados uma vez via `npm run discord:register`.
export const COMMANDS = [
  { name: "avisar", description: "Receber DM quando uma transmissão começar", dm_permission: true },
  { name: "parar", description: "Parar de receber DM das transmissões", dm_permission: true },
  {
    name: "painel-avisos",
    description: "Publica neste canal o botão para as pessoas se inscreverem nos avisos",
    // Só quem pode "Gerenciar servidor" vê o comando.
    default_member_permissions: "32",
    dm_permission: false,
  },
];

export async function registerCommands(): Promise<void> {
  if (!config.discord.applicationId || !config.discord.botToken) {
    throw new Error("DISCORD_APPLICATION_ID e DISCORD_BOT_TOKEN são obrigatórios");
  }
  await discordFetch(`/applications/${config.discord.applicationId}/commands`, { method: "PUT", body: COMMANDS });
}
