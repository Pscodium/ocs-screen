import { customAlphabet } from "nanoid";

// Sem caracteres ambíguos (0/O, 1/I/l) — link legível para digitar/ler em voz alta.
const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

export const generateRoomId = customAlphabet(alphabet, 8);
export const generateIdentity = customAlphabet(alphabet, 12);

const SLUG_PATTERN = /^[a-z0-9-]{3,32}$/;

// Slug escolhido pelo usuário vira o ID da sala (link fica `/s/meu-nome` em vez de `/s/AbC123`).
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
