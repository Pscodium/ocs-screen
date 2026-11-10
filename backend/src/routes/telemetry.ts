import type { FastifyInstance } from "fastify";
import { db } from "../services/db.js";

// Relatório de diagnóstico do pipeline nativo (vídeo vai direto host → espectador por DataChannel,
// o backend nunca vê os frames — sem isso, falha de transmissão não deixa rastro nenhum no
// servidor). Host e espectador mandam UM relatório por evento (falha detectada ou fim da sessão),
// nunca periódico — os contadores ficam em memória no cliente. Aqui só valida e grava 1 linha de
// log estruturado; nada de banco/Redis.
//
// Não exige a sala existir: o relatório de fim do host pode chegar depois do DELETE /rooms/:id.

const RATE_LIMIT_PER_MINUTE = 20;
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 10_000;

const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    // Limpeza preguiçosa — o mapa nunca cresce sem limite.
    if (hits.size >= MAX_TRACKED_IPS) {
      for (const [key, value] of hits) if (now - value.windowStart > RATE_WINDOW_MS) hits.delete(key);
      if (hits.size >= MAX_TRACKED_IPS) hits.clear();
    }
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_PER_MINUTE;
}

interface TelemetryBody {
  role: "host" | "viewer";
  source: "web" | "desktop";
  reason: string;
  sessionId?: string;
  data: Record<string, string | number | boolean | null>;
}

const bodySchema = {
  type: "object",
  required: ["role", "source", "reason", "data"],
  additionalProperties: false,
  properties: {
    role: { enum: ["host", "viewer"] },
    source: { enum: ["web", "desktop"] },
    reason: { type: "string", pattern: "^[a-z_]{1,40}$" },
    sessionId: { type: "string", maxLength: 64 },
    data: {
      type: "object",
      maxProperties: 60,
      propertyNames: { pattern: "^[A-Za-z0-9_]{1,40}$" },
      additionalProperties: { type: ["string", "number", "boolean", "null"], maxLength: 300 },
    },
  },
} as const;

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: TelemetryBody }>(
    "/rooms/:id/telemetry",
    {
      bodyLimit: 8 * 1024,
      schema: {
        params: { type: "object", properties: { id: { type: "string", pattern: "^[A-Za-z0-9-]{3,32}$" } } },
        body: bodySchema,
      },
      // Sem o log "incoming request/request completed" — a linha de telemetria abaixo já basta.
      logLevel: "warn",
    },
    async (request, reply) => {
      if (rateLimited(request.ip)) return reply.code(429).send({ error: "rate_limited" });
      const { role, source, reason, sessionId, data } = request.body;
      request.log.warn(
        {
          telemetry: { roomId: request.params.id, role, source, reason, sessionId, ...data },
          clientIp: request.ip,
          userAgent: request.headers["user-agent"]?.slice(0, 300),
        },
        "native telemetry",
      );
      const sql = db();
      if (sql) {
        const appVersion = typeof data.appVersion === "string" && /^\d+\.\d+\.\d+$/.test(data.appVersion) ? data.appVersion : null;
        // Fire-and-forget: banco lento/fora do ar nunca atrasa nem falha o relatório.
        sql`
          INSERT INTO ocs_telemetry_events (room_id, session_id, role, source, reason, app_version, data)
          VALUES (${request.params.id}, ${sessionId ?? null}, ${role}, ${source}, ${reason}, ${appVersion}, ${sql.json(data)})
        `.catch((err: Error) => request.log.error({ err: err.message }, "[db] falha ao gravar telemetria"));
      }
      return reply.code(204).send();
    },
  );
}
