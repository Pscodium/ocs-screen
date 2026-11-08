import { mkdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

// Minidumps do Crashpad ficam em disco (CRASH_DIR, volume em produção); o banco guarda só o nome.
// Nome do arquivo é sempre gerado aqui — nunca vem do cliente (sem path traversal).

const FILE_RE = /^[0-9a-f]{32}\.dmp$/;

export async function newDumpPath(): Promise<{ file: string; fullPath: string }> {
  await mkdir(config.crashDir, { recursive: true });
  const file = `${randomBytes(16).toString("hex")}.dmp`;
  return { file, fullPath: path.join(config.crashDir, file) };
}

export function dumpPath(file: string): string | null {
  return FILE_RE.test(file) ? path.join(config.crashDir, file) : null;
}

export async function dumpExists(file: string): Promise<boolean> {
  const full = dumpPath(file);
  if (!full) return false;
  return stat(full).then(() => true, () => false);
}

export async function deleteDump(file: string): Promise<void> {
  const full = dumpPath(file);
  if (full) await rm(full, { force: true }).catch(() => {});
}
