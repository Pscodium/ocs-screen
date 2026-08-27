import "./env.js"; // precisa ser o primeiro import — ver comentário em env.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { roomRoutes } from "./routes/rooms.js";

const app = Fastify({ logger: true });

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

app.get("/health", async () => ({ status: "ok" }));

await app.register(roomRoutes);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
