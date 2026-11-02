import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  CUSTOM_ID_SUBSCRIBE,
  CUSTOM_ID_UNSUBSCRIBE,
  isDiscordConfigured,
  isSubscribed,
  subscribe,
  unsubscribe,
} from "../services/discordNotify.js";

// Endpoint de interações do Discord ("Interactions Endpoint URL" no Developer Portal, apontando pra
// https://<backend>/discord/interactions). Recebe slash commands e cliques de botão por HTTP — sem
// bot conectado no gateway, sem processo separado.

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 } as const;
const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4 } as const;
const EPHEMERAL = 64;

interface Interaction {
  type: number;
  data?: { name?: string; custom_id?: string };
  // Em servidor vem `member.user`; em DM vem `user`.
  member?: { user: { id: string } };
  user?: { id: string };
  guild_id?: string;
}

// Chave pública do app vem em hex (32 bytes Ed25519 cru); o Node precisa dela em SPKI/DER.
function loadPublicKey(hex: string): KeyObject {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
}

function reply(content: string, ephemeral = true) {
  return { type: ResponseType.CHANNEL_MESSAGE, data: { content, flags: ephemeral ? EPHEMERAL : 0 } };
}

const SUBSCRIBED_TEXT =
  "🔔 Pronto! Vou te mandar uma DM sempre que uma transmissão começar. Use **/parar** ou o botão da DM pra parar.\n" +
  "_Se a DM não chegar, ative \"Mensagens diretas de membros do servidor\" nas configurações de privacidade._";
const UNSUBSCRIBED_TEXT = "🔕 Feito, você não vai mais receber avisos (seu ID foi apagado).";

export async function discordRoutes(app: FastifyInstance): Promise<void> {
  if (!isDiscordConfigured()) {
    app.log.info("[discord] bot desligado (DISCORD_* ou REDIS_URL ausentes)");
    return;
  }
  const publicKey = loadPublicKey(config.discord.publicKey!);

  // A assinatura cobre o corpo CRU — por isso este plugin (encapsulado, não afeta as outras rotas)
  // lê JSON como string e só faz o parse depois de validar.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post<{ Body: string }>("/discord/interactions", async (request, response) => {
    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];
    const rawBody = request.body;
    if (typeof signature !== "string" || typeof timestamp !== "string" || typeof rawBody !== "string") {
      return response.code(401).send({ error: "invalid_signature" });
    }
    const valid = verify(null, Buffer.from(timestamp + rawBody), publicKey, Buffer.from(signature, "hex"));
    if (!valid) return response.code(401).send({ error: "invalid_signature" });

    const interaction = JSON.parse(rawBody) as Interaction;
    if (interaction.type === InteractionType.PING) return { type: ResponseType.PONG };

    const userId = interaction.member?.user.id ?? interaction.user?.id;
    if (!userId) return reply("Não consegui identificar seu usuário.");

    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      switch (interaction.data?.name) {
        case "avisar":
          await subscribe(userId);
          return reply(SUBSCRIBED_TEXT);
        case "parar":
          return reply((await unsubscribe(userId)) ? UNSUBSCRIBED_TEXT : "Você não estava inscrito.");
        case "painel-avisos":
          return {
            type: ResponseType.CHANNEL_MESSAGE,
            data: {
              content: "**Avisos de transmissão**\nQuer receber uma DM sempre que alguém começar a transmitir?",
              components: [
                {
                  type: 1,
                  components: [
                    { type: 2, style: 1, label: "Me avise", custom_id: CUSTOM_ID_SUBSCRIBE, emoji: { name: "🔔" } },
                    { type: 2, style: 2, label: "Parar", custom_id: CUSTOM_ID_UNSUBSCRIBE, emoji: { name: "🔕" } },
                  ],
                },
              ],
            },
          };
      }
    }

    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      switch (interaction.data?.custom_id) {
        case CUSTOM_ID_SUBSCRIBE:
          if (await isSubscribed(userId)) return reply("Você já está inscrito 🔔");
          await subscribe(userId);
          return reply(SUBSCRIBED_TEXT);
        case CUSTOM_ID_UNSUBSCRIBE:
          return reply((await unsubscribe(userId)) ? UNSUBSCRIBED_TEXT : "Você não estava inscrito.");
      }
    }

    return reply("Comando desconhecido.");
  });
}
