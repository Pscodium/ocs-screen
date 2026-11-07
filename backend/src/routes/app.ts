import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { compareVersions } from "../utils/version.js";

// O app desktop consulta isso ao abrir (e de tempos em tempos) pra saber se a versão instalada
// ainda é aceita. `minVersion` vem de MIN_APP_VERSION — subir esse valor bloqueia versões antigas
// (ver skill prod-changes antes de mudar).
export function isAppVersionSupported(appVersion: string | null): boolean {
  if (!config.minAppVersion) return true;
  // Desktop sem versão = anterior à 1.1.0 (começou a mandar ali) — sempre abaixo de qualquer mínimo.
  if (!appVersion) return false;
  return compareVersions(appVersion, config.minAppVersion) >= 0;
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.get("/app/version", async (_request, reply) => {
    return reply.send({ minVersion: config.minAppVersion });
  });
}
