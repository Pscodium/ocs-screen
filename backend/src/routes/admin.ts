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

// "Falha" = qualquer relatório que não seja o de fim normal da sessão.
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
                 count(*) FILTER (WHERE reason <> ${END_REASON})           AS failures
          FROM ocs_telemetry_events
          WHERE created_at >= ${since}
          GROUP BY 1 ORDER BY 1
        `,
        sql`
          SELECT source, coalesce(app_version, 'desconhecida') AS version,
                 count(DISTINCT session_id)                                  AS sessions,
                 count(DISTINCT session_id) FILTER (WHERE reason <> ${END_REASON}) AS failed_sessions,
                 round(avg((data->>'elapsedMs')::numeric) FILTER (WHERE reason = ${END_REASON}) / 1000) AS avg_duration_s,
                 max(created_at)                                             AS last_seen
          FROM ocs_telemetry_events
          WHERE created_at >= ${since}
          GROUP BY 1, 2 ORDER BY max(created_at) DESC
        `,
        sql`
          SELECT reason, role, source, count(*) AS count
          FROM ocs_telemetry_events
          WHERE created_at >= ${since} AND reason <> ${END_REASON}
          GROUP BY 1, 2, 3 ORDER BY count DESC LIMIT 30
        `,
      ]);

      return { days, daily, byVersion, failureReasons: reasons };
    },
  );
}
