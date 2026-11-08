import postgres from "postgres";
import { config } from "../config.js";
import { deleteDump } from "./crashStore.js";

// Postgres opcional: null quando POSTGRES_URL não está configurado — quem chama trata como
// "recurso desligado" (mesmo padrão do Redis em services/redis.ts).
export type Sql = postgres.Sql;

let client: Sql | null = null;
// true se a inicialização falhou — recurso desligado até reiniciar o processo.
let disabled = false;

export function getDb(): Sql | null {
  if (!config.postgresUrl) return null;
  if (!client) {
    client = postgres(config.postgresUrl, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return client;
}

// Migrations embutidas no código (não arquivos .sql) — o Dockerfile só copia `dist/`. Cada entrada
// roda UMA vez, em ordem, dentro de transação; nunca editar uma já publicada, só acrescentar.
// Mesmo assim, toda DDL usa IF NOT EXISTS: se a tabela já existir sem o registro da migration
// (criada à mão, ou registro perdido), a migration só é registrada em vez de derrubar o recurso.
// Tabelas com prefixo `ocs_` — o banco pode ser compartilhado com outros projetos.
const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "telemetry_events",
    sql: `
      CREATE TABLE IF NOT EXISTS ocs_telemetry_events (
        id          bigserial PRIMARY KEY,
        created_at  timestamptz NOT NULL DEFAULT now(),
        room_id     text NOT NULL,
        session_id  text,
        role        text NOT NULL,
        source      text NOT NULL,
        reason      text NOT NULL,
        app_version text,
        data        jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ocs_telemetry_events_created_at_idx ON ocs_telemetry_events (created_at);
      CREATE INDEX IF NOT EXISTS ocs_telemetry_events_version_idx ON ocs_telemetry_events (app_version, created_at);
    `,
  },
  {
    id: 2,
    name: "crash_reports",
    sql: `
      CREATE TABLE IF NOT EXISTS ocs_crash_reports (
        id           bigserial PRIMARY KEY,
        created_at   timestamptz NOT NULL DEFAULT now(),
        app_version  text NOT NULL,
        process_type text,
        kind         text NOT NULL,
        message      text,
        dump_file    text,
        dump_size    int
      );
      CREATE INDEX IF NOT EXISTS ocs_crash_reports_created_at_idx ON ocs_crash_reports (created_at);
    `,
  },
];

async function runMigrations(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ocs_schema_migrations (
      id         int PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Lock de sessão: duas instâncias subindo juntas não aplicam a mesma migration duas vezes.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ocs_schema_migrations'))`;
    const rows = await tx<{ id: number }[]>`SELECT id FROM ocs_schema_migrations`;
    const applied = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await tx.unsafe(m.sql);
      await tx`INSERT INTO ocs_schema_migrations (id, name) VALUES (${m.id}, ${m.name})`;
      console.log(`[db] migration ${m.id} (${m.name}) aplicada`);
    }
  });
}

async function purgeOld(sql: Sql): Promise<void> {
  const days = config.telemetryRetentionDays;
  const result = await sql`
    DELETE FROM ocs_telemetry_events WHERE created_at < now() - make_interval(days => ${days})
  `;
  if (result.count > 0) console.log(`[db] retenção: ${result.count} eventos com mais de ${days} dias apagados`);
  const crashes = await sql<{ dump_file: string | null }[]>`
    DELETE FROM ocs_crash_reports WHERE created_at < now() - make_interval(days => ${days}) RETURNING dump_file
  `;
  for (const row of crashes) if (row.dump_file) await deleteDump(row.dump_file);
}

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Chamado no boot. Falha aqui NÃO derruba o backend (transmissão não depende do banco) — só loga
// e desliga o recurso, igual Redis fora do ar.
export async function initDb(): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  try {
    await runMigrations(sql);
    await purgeOld(sql);
    setInterval(() => void purgeOld(sql).catch((err) => console.error("[db] retenção:", err.message)), PURGE_INTERVAL_MS).unref();
    console.log("[db] Postgres pronto");
  } catch (err) {
    console.error("[db] falha ao inicializar Postgres — telemetria só no log:", (err as Error).message);
    await sql.end({ timeout: 2 }).catch(() => {});
    client = null;
    disabled = true;
  }
}

// Cliente pronto pra uso (null se não configurado ou se a inicialização falhou).
export function db(): Sql | null {
  return disabled ? null : getDb();
}
