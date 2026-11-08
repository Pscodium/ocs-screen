import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { db } from "../services/db.js";
import { deleteDump, dumpExists, dumpPath, newDumpPath } from "../services/crashStore.js";
import { isAdmin } from "./admin.js";

// Relatórios de crash do app desktop (só com consentimento do usuário — ver desktop/src/main).
// - POST /crash      → upload do Crashpad (multipart, campo `upload_file_minidump` + anotações
//                       `ver`, `process_type`, ...). Formato fixo do Crashpad, não escolhido aqui.
// - POST /crash/js   → exceção JS não tratada no processo principal (JSON).
// Sem Postgres configurado, as duas respondem 204 e descartam — o app não precisa saber.

const MAX_DUMP_BYTES = 10 * 1024 * 1024;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const rateLimit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

export async function crashRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: MAX_DUMP_BYTES, files: 1, fields: 40, fieldSize: 2048 } });

  app.post("/crash", { config: rateLimit(5), logLevel: "warn" }, async (request, reply) => {
    const sql = db();
    if (!sql) return reply.code(204).send();

    const fields: Record<string, string> = {};
    let saved: { file: string; size: number } | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "upload_file_minidump" || saved) {
            part.file.resume();
            continue;
          }
          const { file, fullPath } = await newDumpPath();
          await pipeline(part.file, createWriteStream(fullPath));
          if (part.file.truncated) {
            await deleteDump(file);
            return reply.code(413).send({ error: "too_large" });
          }
          saved = { file, size: part.file.bytesRead };
        } else if (typeof part.value === "string") {
          fields[part.fieldname] = part.value.slice(0, 500);
        }
      }
    } catch (err) {
      if (saved) await deleteDump(saved.file);
      request.log.warn({ err: (err as Error).message }, "[crash] upload inválido");
      return reply.code(400).send({ error: "bad_request" });
    }

    const version = VERSION_RE.test(fields.ver ?? "") ? fields.ver! : null;
    if (!saved || !version) {
      if (saved) await deleteDump(saved.file);
      return reply.code(400).send({ error: "bad_request" });
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO ocs_crash_reports (app_version, process_type, kind, message, dump_file, dump_size)
      VALUES (${version}, ${fields.process_type ?? null}, 'native', ${fields.ptype ?? null}, ${saved.file}, ${saved.size})
      RETURNING id
    `;
    request.log.warn({ crash: { id: row?.id, version, processType: fields.process_type, size: saved.size } }, "crash report");
    // Crashpad espera o id do relatório no corpo da resposta.
    return reply.type("text/plain").send(String(row?.id ?? ""));
  });

  app.post<{ Body: { appVersion: string; processType: string; message: string } }>(
    "/crash/js",
    {
      bodyLimit: 16 * 1024,
      config: rateLimit(10),
      logLevel: "warn",
      schema: {
        body: {
          type: "object",
          required: ["appVersion", "processType", "message"],
          additionalProperties: false,
          properties: {
            appVersion: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
            processType: { type: "string", pattern: "^[a-z-]{1,20}$" },
            message: { type: "string", maxLength: 8000 },
          },
        },
      },
    },
    async (request, reply) => {
      const sql = db();
      if (!sql) return reply.code(204).send();
      const { appVersion, processType, message } = request.body;
      await sql`
        INSERT INTO ocs_crash_reports (app_version, process_type, kind, message)
        VALUES (${appVersion}, ${processType}, 'js', ${message})
      `;
      request.log.warn({ crash: { version: appVersion, processType, kind: "js" } }, "crash report");
      return reply.code(204).send();
    },
  );

  app.get<{ Querystring: { days?: number } }>(
    "/admin/crashes",
    {
      config: rateLimit(30),
      schema: { querystring: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 365 } } } },
    },
    async (request, reply) => {
      const sql = db();
      if (!sql) return reply.code(404).send({ error: "not_found" });
      const auth = isAdmin(request);
      if (auth !== "ok") return reply.code(auth === "disabled" ? 404 : 401).send({ error: auth });
      const days = request.query.days ?? 30;
      const crashes = await sql`
        SELECT id, created_at, app_version, process_type, kind, message, dump_size
        FROM ocs_crash_reports
        WHERE created_at >= now() - make_interval(days => ${days})
        ORDER BY created_at DESC LIMIT 200
      `;
      return { crashes };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/crashes/:id/dump",
    {
      config: rateLimit(30),
      schema: { params: { type: "object", properties: { id: { type: "string", pattern: "^\\d{1,18}$" } } } },
    },
    async (request, reply) => {
      const sql = db();
      if (!sql) return reply.code(404).send({ error: "not_found" });
      const auth = isAdmin(request);
      if (auth !== "ok") return reply.code(auth === "disabled" ? 404 : 401).send({ error: auth });
      const [row] = await sql<{ dump_file: string | null }[]>`SELECT dump_file FROM ocs_crash_reports WHERE id = ${request.params.id}`;
      const full = row?.dump_file ? dumpPath(row.dump_file) : null;
      if (!full || !row?.dump_file || !(await dumpExists(row.dump_file))) return reply.code(404).send({ error: "not_found" });
      return reply
        .type("application/octet-stream")
        .header("Content-Disposition", `attachment; filename="crash-${request.params.id}.dmp"`)
        .send(createReadStream(full));
    },
  );
}
