import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "../services/db.js";

// Estatísticas agregadas da telemetria (Postgres). Protegido por `ADMIN_TOKEN` (Bearer). Sem token
// ou sem banco configurado, as rotas respondem 404 — como se não existissem.

export function isAdmin(request: FastifyRequest): "ok" | "disabled" | "unauthorized" {
  if (!config.adminToken) return "disabled";
  const header = request.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(config.adminToken);
  return given.length === expected.length && timingSafeEqual(given, expected) ? "ok" : "unauthorized";
}

// Relatórios que NÃO são falha: fim normal e recuperações (a falha que as causou já tem relatório
// próprio — contar de novo inflava a taxa de falha).
const NON_FAILURE = ["end", "reconnected", "recovered_after_error"];
const END_REASON = "end";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { days?: number } }>(
    "/admin/stats",
    {
      schema: {
        querystring: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 365 } } },
      },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const sql = db();
      if (!sql) return reply.code(404).send({ error: "not_found" });
      const auth = isAdmin(request);
      if (auth !== "ok") return reply.code(auth === "disabled" ? 404 : 401).send({ error: auth });
      const days = request.query.days ?? 30;
      const since = sql`now() - make_interval(days => ${days})`;

      const [daily, byVersion, reasons] = await Promise.all([
        sql`
          SELECT date_trunc('day', created_at)::date AS day,
                 count(DISTINCT session_id) FILTER (WHERE role = 'host')   AS host_sessions,
                 count(DISTINCT session_id) FILTER (WHERE role = 'viewer') AS viewer_sessions,
                 count(*) FILTER (WHERE reason <> ALL(${NON_FAILURE}))     AS failures
          FROM ocs_telemetry_events
          WHERE created_at >= ${since}
          GROUP BY 1 ORDER BY 1
        `,
        sql`
          SELECT source, role, coalesce(app_version, 'desconhecida') AS version,
                 count(DISTINCT session_id)                                  AS sessions,
                 count(DISTINCT session_id) FILTER (WHERE reason <> ALL(${NON_FAILURE})) AS failed_sessions,
                 round(avg((data->>'elapsedMs')::numeric) FILTER (WHERE reason = ${END_REASON}) / 1000) AS avg_duration_s,
                 max(created_at)                                             AS last_seen
          FROM ocs_telemetry_events
          WHERE created_at >= ${since}
          GROUP BY 1, 2, 3 ORDER BY max(created_at) DESC
        `,
        sql`
          SELECT reason, role, source, count(*) AS count, count(DISTINCT room_id) AS rooms,
                 max(created_at) AS last_seen
          FROM ocs_telemetry_events
          WHERE created_at >= ${since} AND reason <> ${END_REASON}
          GROUP BY 1, 2, 3 ORDER BY count DESC LIMIT 30
        `,
      ]);

      return { days, daily, byVersion, failureReasons: reasons };
    },
  );

  // Eventos crus (com `data`) — o que de fato aconteceu em cada sessão: sala, GPU, navegador,
  // contadores. `room` traz TODOS os eventos da sala (host + espectadores), pra correlacionar
  // "espectador sem vídeo" com a falha do transmissor que causou.
  app.get<{ Querystring: { days?: number; reason?: string; room?: string; limit?: number } }>(
    "/admin/events",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            days: { type: "integer", minimum: 1, maximum: 365 },
            reason: { type: "string", pattern: "^[a-z_]{1,40}$" },
            room: { type: "string", pattern: "^[A-Za-z0-9-]{3,32}$" },
            limit: { type: "integer", minimum: 1, maximum: 500 },
          },
        },
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const sql = db();
      if (!sql) return reply.code(404).send({ error: "not_found" });
      const auth = isAdmin(request);
      if (auth !== "ok") return reply.code(auth === "disabled" ? 404 : 401).send({ error: auth });
      const { days = 7, reason, room, limit = 150 } = request.query;
      const since = sql`now() - make_interval(days => ${days})`;
      const events = await sql`
        SELECT id, created_at, room_id, session_id, role, source, reason, app_version, data
        FROM ocs_telemetry_events
        WHERE created_at >= ${since}
          ${room ? sql`AND room_id = ${room}` : reason ? sql`AND reason = ${reason}` : sql`AND reason <> ALL(${NON_FAILURE})`}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return { events };
    },
  );
}
