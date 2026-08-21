import { config } from "../config.js";
import { generateRoomId } from "../utils/ids.js";
import type { Room, RoomSettings } from "../types/room.js";

const defaultSettings: RoomSettings = {
  resolution: "auto",
  fps: "auto",
  quality: "auto",
};

const rooms = new Map<string, Room>();
const emptyTimers = new Map<string, NodeJS.Timeout>();

export function createRoom(hostIdentity: string, settings?: Partial<RoomSettings>): Room {
  const room: Room = {
    id: generateRoomId(),
    hostIdentity,
    createdAt: Date.now(),
    settings: { ...defaultSettings, ...settings },
  };
  rooms.set(room.id, room);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function deleteRoom(roomId: string): void {
  rooms.delete(roomId);
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
