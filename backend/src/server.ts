import "./env.js"; // precisa ser o primeiro import — ver comentário em env.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { roomRoutes } from "./routes/rooms.js";
import { discordRoutes } from "./routes/discord.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { appRoutes } from "./routes/app.js";

const app = Fastify({
  logger: {
    serializers: {
      // Query string fora do log: carrega `hostSecret` e `password` do WebSocket de sinalização
      // (navegador não deixa mandar header no WebSocket).
      req: (req) => ({ method: req.method, url: req.url.split("?")[0], remoteAddress: req.ip }),
    },
  },
  // Confia só nos N saltos mais próximos (ver `trustProxyHops` em config.ts).
  trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
});

// Rede de segurança: um erro não tratado aqui derruba o processo inteiro (Node mata o processo em
// "uncaughtException"/"unhandledRejection" por padrão), o que mata TODA transmissão ativa na
// instância, não só a origem do erro. Nunca deveria acontecer (todo socket relevante já trata o
// próprio "error", ver nativeWsRelay.ts), mas loga em vez de deixar cair silenciosamente caso
// apareça algum caminho novo — objetivo é nada derrubar uma transmissão sozinho.
process.on("uncaughtException", (err) => {
  app.log.error(err, "[server] uncaughtException — processo continua de propósito");
});
process.on("unhandledRejection", (reason) => {
  app.log.error(reason, "[server] unhandledRejection — processo continua de propósito");
});

await app.register(cors, { origin: config.corsOrigins.includes("*") ? true : config.corsOrigins });
// Sinalização do transporte nativo (ver services/nativeWsRelay.ts) — substitui o REST+polling
// antigo (docs/NATIVE_CAPTURE.md Fase 4).
await app.register(websocket);
// Limites por rota (`config.rateLimit` em routes/rooms.ts). Global desligado: o endpoint do Discord
// recebe de IPs do próprio Discord e a telemetria já tem limite próprio.
await app.register(rateLimit, { global: false });

app.get("/health", async () => ({ status: "ok" }));

await app.register(roomRoutes);
await app.register(discordRoutes);
await app.register(telemetryRoutes);
await app.register(appRoutes);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
