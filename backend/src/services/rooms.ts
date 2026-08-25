import { config } from "../config.js";
import { generateRoomId } from "../utils/ids.js";
import { cleanupNativeSockets } from "./nativeWsRelay.js";
import type { Room, RoomSettings } from "../types/room.js";

const defaultSettings: RoomSettings = {
  resolution: "auto",
  fps: "auto",
  quality: "auto",
};

const rooms = new Map<string, Room>();
const emptyTimers = new Map<string, NodeJS.Timeout>();

export class SlugTakenError extends Error {}

export function createRoom(
  hostIdentity: string,
  settings?: Partial<RoomSettings>,
  slug?: string,
  nativeMode = false,
): Room {
  const id = slug ?? generateRoomId();
  if (slug && rooms.has(slug)) throw new SlugTakenError(`Sala "${slug}" já está em uso.`);

  const room: Room = {
    id,
    hostIdentity,
    createdAt: Date.now(),
    settings: { ...defaultSettings, ...settings },
    nativeMode,
  };
  rooms.set(room.id, room);
  return room;
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
