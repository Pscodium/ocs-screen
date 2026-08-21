import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { roomRoutes } from "./routes/rooms.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: config.corsOrigin === "*" ? true : config.corsOrigin });

app.get("/health", async () => ({ status: "ok" }));

await app.register(roomRoutes);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
