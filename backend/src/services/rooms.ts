import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { generateRoomId } from "../utils/ids.js";
import { cleanupNativeSockets } from "./nativeWsRelay.js";
import { getRedis, REDIS_PREFIX } from "./redis.js";
import type { Room, RoomSettings, RoomSource } from "../types/room.js";

const defaultSettings: RoomSettings = {
  resolution: "auto",
  fps: "auto",
  quality: "auto",
};

const rooms = new Map<string, Room>();
const emptyTimers = new Map<string, NodeJS.Timeout>();

export class SlugTakenError extends Error {}
export class RoomLimitError extends Error {}

// ---------- Persistência no Redis ----------
// O Map acima continua sendo a fonte de verdade em execução; o Redis só existe pra sala sobreviver a
// um restart/deploy do backend. Regra pra nunca acumular lixo: TODA chave de sala tem TTL curto e só
// é renovada pelo loop abaixo, e só pras salas que ainda estão no Map. Backend morto/travado = ninguém
// renova = tudo expira sozinho em ROOM_TTL_SECONDS. Os inscritos do Discord (sem TTL) ficam no mesmo
// Redis — com `maxmemory-policy volatile-*` só chaves com TTL (salas) podem ser descartadas.
const ROOM_KEY_PREFIX = "room:";
const ROOM_TTL_SECONDS = 180;
const ROOM_REFRESH_MS = 60_000;
// Teto absoluto: nenhum token de sala vale mais que isso, então sala mais velha não tem por que viver.
const MAX_ROOM_AGE_MS = config.room.tokenTtlSeconds * 1000;
// Teto global de salas simultâneas — protege memória/Redis de criação em massa que escape do rate limit.
const MAX_ROOMS = 500;

function roomRedis() {
  return config.roomPersistence ? getRedis() : null;
}

function roomKey(roomId: string): string {
  return `${ROOM_KEY_PREFIX}${roomId}`;
}

function persistRoom(room: Room): void {
  void roomRedis()
    ?.set(roomKey(room.id), JSON.stringify(room), "EX", ROOM_TTL_SECONDS)
    .catch((err: unknown) => console.error("[rooms] persist:", err));
}

function unpersistRoom(roomId: string): void {
  void roomRedis()
    ?.del(roomKey(roomId))
    .catch((err: unknown) => console.error("[rooms] unpersist:", err));
}

function isRoomTooOld(room: Room): boolean {
  return Date.now() - room.createdAt > MAX_ROOM_AGE_MS;
}

// Validação mínima do que volta do Redis — chave corrompida/de versão antiga é descartada, nunca
// derruba o boot.
function parseStoredRoom(raw: string): Room | null {
  try {
    const room = JSON.parse(raw) as Partial<Room>;
    if (typeof room.id !== "string" || typeof room.hostIdentity !== "string" || typeof room.createdAt !== "number") {
      return null;
    }
    if (!room.settings || typeof room.nativeMode !== "boolean") return null;
    return {
      id: room.id,
      hostIdentity: room.hostIdentity,
      createdAt: room.createdAt,
      settings: { ...defaultSettings, ...room.settings },
      nativeMode: room.nativeMode,
      isPrivate: room.isPrivate === true,
      passwordHash: typeof room.passwordHash === "string" ? room.passwordHash : null,
      source: room.source === "web" ? "web" : "desktop",
      appVersion: typeof room.appVersion === "string" ? room.appVersion : null,
      hostName: typeof room.hostName === "string" ? room.hostName : null,
      hostSecretHash: typeof room.hostSecretHash === "string" ? room.hostSecretHash : null,
    };
  } catch {
    return null;
  }
}

// Boot: recupera as salas que estavam vivas antes do restart. `liveKitRoomIds` = salas que o
// LiveKit diz que existem agora (null = LiveKit inacessível, não descarta nada por isso). Sala
// LiveKit que acabou durante o restart é descartada; sala nativa volta com o timer de limpeza
// armado — o host reconecta no WS e cancela, ou ela some como qualquer sala nativa abandonada.
export async function restoreRooms(liveKitRoomIds: Set<string> | null): Promise<number> {
  const redis = roomRedis();
  if (!redis) return 0;
  // SCAN não aplica o `keyPrefix` do ioredis no MATCH nem tira ele do resultado.
  const fullPrefix = `${REDIS_PREFIX}${ROOM_KEY_PREFIX}`;
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${fullPrefix}*`, "COUNT", 200);
    cursor = next;
    keys.push(...batch.map((key) => key.slice(REDIS_PREFIX.length)));
  } while (cursor !== "0");
  if (keys.length === 0) return 0;

  const values = await redis.mget(...keys);
  let restored = 0;
  values.forEach((raw, i) => {
    const room = raw ? parseStoredRoom(raw) : null;
    const gone = !room || isRoomTooOld(room) || (!room.nativeMode && liveKitRoomIds !== null && !liveKitRoomIds.has(room.id));
    if (gone || rooms.has(room.id)) {
      if (gone) unpersistRoom(keys[i].slice(ROOM_KEY_PREFIX.length));
      return;
    }
    rooms.set(room.id, room);
    if (room.nativeMode) scheduleRoomCleanup(room.id);
    restored++;
  });
  return restored;
}

let refreshTimer: NodeJS.Timeout | null = null;

// Renova o TTL das salas vivas e descarta as que passaram do teto de idade.
export function startRoomPersistence(): void {
  if (refreshTimer || !roomRedis()) return;
  refreshTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (isRoomTooOld(room)) deleteRoom(room.id);
      else persistRoom(room);
    }
  }, ROOM_REFRESH_MS);
  refreshTimer.unref();
}

export function createRoom(
  hostIdentity: string,
  settings?: Partial<RoomSettings>,
  slug?: string,
  nativeMode = false,
  access: { isPrivate?: boolean; password?: string } = {},
  origin: { source: RoomSource; appVersion: string | null; hostName?: string | null } = {
    source: "desktop",
    appVersion: null,
  },
  hostSecret: string | null = null,
): Room {
  const id = slug ?? generateRoomId();
  if (slug && rooms.has(slug)) throw new SlugTakenError(`Sala "${slug}" já está em uso.`);
  if (rooms.size >= MAX_ROOMS) throw new RoomLimitError("Limite de salas simultâneas atingido.");

  const room: Room = {
    id,
    hostIdentity,
    createdAt: Date.now(),
    settings: { ...defaultSettings, ...settings },
    nativeMode,
    isPrivate: access.isPrivate ?? false,
    passwordHash: access.password ? hashPassword(access.password) : null,
    source: origin.source,
    appVersion: origin.appVersion,
    hostName: origin.hostName ?? null,
    hostSecretHash: hostSecret ? sha256Hex(hostSecret) : null,
  };
  rooms.set(room.id, room);
  persistRoom(room);
  // Sala nativa nunca aparece no cruzamento de órfãs de `GET /rooms` (`isOrphan` em
  // routes/rooms.ts ignora `nativeMode` de propósito — LiveKit não tem visibilidade nenhuma do
  // transporte nativo, cruzar contra ele apagaria toda sala nativa ativa ~20s depois de criada).
  // Sem substituto, uma sala nativa cujo host nunca chega a conectar (crash entre o POST /rooms e
  // o WS de sinalização) ou cujo host cai e não volta ficava presa pra sempre — sala fantasma,
  // sem transmissão real nenhuma por trás. `registerHostSocket`/o "close" do socket do host
  // (nativeWsRelay.ts) cancelam/reagendam isso conforme o host aparece/some de verdade.
  if (nativeMode) scheduleRoomCleanup(room.id);
  return room;
}

export function generateHostSecret(): string {
  return randomBytes(32).toString("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Sala de cliente antigo (sem hash) libera — modo de transição. Segredo tem 256 bits aleatórios,
// então SHA-256 simples basta (não é senha escolhida por gente, não precisa de scrypt).
export function checkHostSecret(room: Room, secret: unknown): boolean {
  if (!room.hostSecretHash) return true;
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 128) return false;
  return timingSafeEqual(Buffer.from(room.hostSecretHash, "hex"), Buffer.from(sha256Hex(secret), "hex"));
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

// Sala sem senha sempre libera. Comparação em tempo constante pra não vazar timing.
export function checkRoomPassword(room: Room, password: string | undefined): boolean {
  if (!room.passwordHash) return true;
  if (!password) return false;
  const [saltHex, hashHex] = room.passwordHash.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

// Salas em memória, criadas via POST /rooms — cobre o caso normal (host encerra e chama DELETE).
// Se o host cair sem avisar (crash, queda de rede), a sala fica aqui até o TTL de limpeza; quem
// listar pode ver uma entrada morta por um tempo curto, que suma sozinha depois.
export function listRooms(): Room[] {
  return Array.from(rooms.values());
}

export function deleteRoom(roomId: string): void {
  rooms.delete(roomId);
  unpersistRoom(roomId);
  cleanupNativeSockets(roomId);
  const timer = emptyTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    emptyTimers.delete(roomId);
  }
}

// Chamado pelo webhook do LiveKit quando a sala fica vazia — destrói após TTL de graça.
export function scheduleRoomCleanup(roomId: string): void {
  const existing = emptyTimers.get(roomId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => deleteRoom(roomId), config.room.emptyRoomTtlSeconds * 1000);
  emptyTimers.set(roomId, timer);
}

export function cancelRoomCleanup(roomId: string): void {
  const timer = emptyTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    emptyTimers.delete(roomId);
  }
}
