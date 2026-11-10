import { db } from "./db.js";
import { isConnectedIp, ROOM_CLOSED_CODE } from "./nativeWsRelay.js";
import { deleteRoom, getRoom } from "./rooms.js";

// Saúde das salas nativas a partir da telemetria. Uma sala só morre sozinha quando o host some
// (nativeWsRelay.ts agenda a limpeza no "close" do socket). Host com o app aberto e o encoder
// travado (GPU AMD que solta 1 frame e para — visto em produção) mantém o socket vivo e a sala
// fica "ao vivo" pra sempre sem vídeo nenhum. Aqui ela é encerrada quando há prova de que está
// quebrada — e SÓ com prova: sala aberta sem espectador nenhum nunca gera relatório, então nunca
// é tocada.
//
// Prova:
//   1. host relata `encoder_recovery_failed` (toda a escada de encoders falhou), ou
//   2. host relata `viewer_no_data` com `encodedSinceConnect: 0` (encoder não produz nada) E,
//      depois de dar tempo pra recuperação automática (CONFIRM_AFTER_MS), um espectador ainda
//      relata `no_data`, sem nenhum espectador ter assistido de verdade nesse meio tempo.
// Relatório só conta se vier do IP de quem está conectado na sala nesse papel (o endpoint de
// telemetria é público — ver `isConnectedIp`).

const CONFIRM_AFTER_MS = 60_000;
// Espectador que decodificou isso aqui assistiu de verdade — a sala funciona (recuperou).
const WATCHED_FRAMES = 60;

interface Health {
  hostStuckAt: number | null;
}
const health = new Map<string, Health>();

export function forgetRoomHealth(roomId: string): void {
  health.delete(roomId);
}

type Data = Record<string, string | number | boolean | null>;

export function onRoomTelemetry(roomId: string, role: string, reason: string, data: Data, ip: string): void {
  const room = getRoom(roomId);
  if (!room || !room.nativeMode) return;
  if ((role !== "host" && role !== "viewer") || !isConnectedIp(roomId, role, ip)) return;
  const now = Date.now();
  const h = health.get(roomId) ?? { hostStuckAt: null };
  health.set(roomId, h);

  if (role === "host") {
    if (reason === "encoder_recovery_failed") {
      closeBrokenRoom(roomId, "encoder_recovery_failed");
      return;
    }
    if (reason === "viewer_no_data" && Number(data.encodedSinceConnect ?? 1) === 0 && h.hostStuckAt === null) {
      h.hostStuckAt = now;
    }
    return;
  }

  if (h.hostStuckAt === null) return;
  if (Number(data.framesDecoded ?? 0) >= WATCHED_FRAMES) {
    h.hostStuckAt = null; // alguém assistiu depois do travamento — recuperou
    return;
  }
  if (reason === "no_data" && now - h.hostStuckAt >= CONFIRM_AFTER_MS) {
    closeBrokenRoom(roomId, "host_encoder_stuck");
  }
}

function closeBrokenRoom(roomId: string, cause: string): void {
  const room = getRoom(roomId);
  if (!room) return;
  console.warn(`[roomHealth] sala ${roomId} encerrada: transmissão travada (${cause}).`);
  recordClosure(roomId, room.source, room.appVersion, "room_closed_unhealthy", { cause });
  deleteRoom(roomId, ROOM_CLOSED_CODE, "stream_broken");
}

// Encerramento manual pelo painel (`DELETE /admin/rooms/:id`).
export function closeRoomByAdmin(roomId: string): boolean {
  const room = getRoom(roomId);
  if (!room) return false;
  recordClosure(roomId, room.source, room.appVersion, "room_closed_admin", {});
  deleteRoom(roomId, ROOM_CLOSED_CODE, "closed_by_admin");
  return true;
}

function recordClosure(roomId: string, source: string, appVersion: string | null, reason: string, data: Data): void {
  const sql = db();
  if (!sql) return;
  sql`
    INSERT INTO ocs_telemetry_events (room_id, session_id, role, source, reason, app_version, data)
    VALUES (${roomId}, ${null}, ${"host"}, ${source}, ${reason}, ${appVersion}, ${sql.json(data)})
  `.catch((err: Error) => console.error("[roomHealth] falha ao gravar encerramento:", err.message));
}

// Pro painel: sala com travamento detectado e ainda aguardando confirmação.
export function roomHealthState(roomId: string): "suspect" | null {
  return health.get(roomId)?.hostStuckAt != null ? "suspect" : null;
}
