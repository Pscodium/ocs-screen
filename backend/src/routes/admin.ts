import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "../services/db.js";
import { getNativeViewerCount, isHostConnected } from "../services/nativeWsRelay.js";
import { closeRoomByAdmin, roomHealthState } from "../services/roomHealth.js";
import { listRooms } from "../services/rooms.js";

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
// próprio — contar de novo inflava a taxa de falha). `connection_lost` do espectador também não:
// dispara quando o host encerra (ou a aba fecha) — a queda que não volta vira `recovery_failed`
// (viewer ≥ 0.5.6).
const NON_FAILURE = ["end", "reconnected", "recovered_after_error", "connection_lost"];
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

      // Uma linha por sessão (session_id; relatório antigo sem sessão vira a própria linha) — base
      // das tabelas e dos gráficos de tendência. `duration_ms` = maior elapsedMs relatado.
      const sessions = sql`
        SELECT coalesce(session_id, id::text) AS sid, role, source,
               coalesce(min(app_version), 'desconhecida') AS version,
               min(created_at) AS started_at, max(created_at) AS last_at,
               bool_or(reason <> ALL(${NON_FAILURE})) AS failed,
               max((data->>'elapsedMs')::numeric) AS duration_ms,
               max((data->>'firstFrameAtMs')::numeric) AS first_frame_ms,
               max((data->>'recoveries')::numeric) AS recoveries
        FROM ocs_telemetry_events
        WHERE created_at >= ${since}
        GROUP BY 1, 2, 3
      `;
      const metrics = sql`
        count(*)                                              AS sessions,
        count(*) FILTER (WHERE failed)                        AS failed_sessions,
        round(avg(duration_ms) / 1000)                        AS avg_duration_s,
        round(sum(duration_ms) / 3600000.0, 2)                AS total_hours,
        round(avg(first_frame_ms))                            AS avg_first_frame_ms,
        round(avg(coalesce(recoveries, 0)), 2)                AS avg_recoveries
      `;

      const [daily, byVersion, trendDaily, reasons] = await Promise.all([
        sql`
          SELECT date_trunc('day', started_at)::date AS day,
                 count(*) FILTER (WHERE role = 'host')   AS host_sessions,
                 count(*) FILTER (WHERE role = 'viewer') AS viewer_sessions,
                 count(*) FILTER (WHERE failed)          AS failures
          FROM (${sessions}) s
          GROUP BY 1 ORDER BY 1
        `,
        sql`
          SELECT source, role, version, ${metrics},
                 min(started_at) AS first_seen, max(last_at) AS last_seen
          FROM (${sessions}) s
          GROUP BY 1, 2, 3 ORDER BY max(last_at) DESC
        `,
        sql`
          SELECT date_trunc('day', started_at)::date AS day, source, role, ${metrics}
          FROM (${sessions}) s
          GROUP BY 1, 2, 3 ORDER BY 1
        `,
        sql`
          SELECT reason, role, source, count(*) AS count, count(DISTINCT room_id) AS rooms,
                 max(created_at) AS last_seen
          FROM ocs_telemetry_events
          WHERE created_at >= ${since} AND reason <> ${END_REASON}
          GROUP BY 1, 2, 3 ORDER BY count DESC LIMIT 30
        `,
      ]);

      return { days, daily, byVersion, trendDaily, failureReasons: reasons, nonFailureReasons: NON_FAILURE };
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

  // Salas ativas agora (memória do backend) — com estado do host e saúde, pra achar sala presa.
  app.get("/admin/rooms", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const auth = isAdmin(request);
    if (auth !== "ok") return reply.code(auth === "disabled" ? 404 : 401).send({ error: auth });
    const rooms = listRooms().map((room) => ({
      roomId: room.id,
      createdAt: room.createdAt,
      source: room.source,
      appVersion: room.appVersion,
      nativeMode: room.nativeMode,
      isPrivate: room.isPrivate,
      hostConnected: room.nativeMode ? isHostConnected(room.id) : null,
      viewers: room.nativeMode ? getNativeViewerCount(room.id) : null,
      health: roomHealthState(room.id),
    }));
    return { rooms };
  });

  app.delete<{ Params: { id: string } }>(
    "/admin/rooms/:id",
    {
      schema: { params: { type: "object", properties: { id: { type: "string", pattern: "^[A-Za-z0-9-]{3,32}$" } } } },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const auth = isAdmin(request);
      if (auth !== "ok") return reply.code(auth === "disabled" ? 404 : 401).send({ error: auth });
      if (!closeRoomByAdmin(request.params.id)) return reply.code(404).send({ error: "room_not_found" });
      request.log.warn({ roomId: request.params.id }, "room closed by admin");
      return reply.code(204).send();
    },
  );
}
