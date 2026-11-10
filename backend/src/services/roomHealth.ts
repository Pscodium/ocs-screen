import { db } from "./db.js";
import { ROOM_CLOSED_CODE } from "./nativeWsRelay.js";
import { deleteRoom, getRoom } from "./rooms.js";

// Saúde das salas nativas. Uma sala só morre sozinha quando o host some (nativeWsRelay.ts agenda a
// limpeza no "close" do socket). Host com o app aberto e o encoder travado (GPU AMD que solta 1
// frame e para — visto em produção) mantém o socket vivo e a sala fica "ao vivo" pra sempre sem
// vídeo nenhum.
//
// Fonte da verdade: o PRÓPRIO host (app ≥ 1.5.3), que manda pelo WebSocket de sinalização a cada
// ~30s quanto capturou, codificou e entregou nesse intervalo (`host-health`). Telemetria de
// espectador NÃO serve pra isso — é por evento: um espectador que relatou "sem vídeo" e depois
// recuperou não manda mais nada até sair, e a sala parecia quebrada estando boa (medido).
//
// Fecha só quando, por STUCK_INTERVALS heartbeats seguidos (~90s), TUDO isso vale:
//   - tem espectador conectado (sala sem espectador nunca é tocada);
//   - a tela mudou (capturou ≥ MIN_ACQUIRED frames — tela parada não produz frame nenhum);
//   - o encoder não entregou NENHUM pacote e nenhum envio deu certo.
// Encoder lento (CPU em 4K) entrega pouco, mas não zero — não fecha. App antigo não manda
// heartbeat — nunca é fechado automaticamente (sobra o botão do painel).

const STUCK_INTERVALS = 3;
const MIN_ACQUIRED = 30;

export interface HostHealthReport {
  acquired: number;
  encoded: number;
  sendOk: number;
  viewers: number;
}

const stuckStreak = new Map<string, number>();

export function forgetRoomHealth(roomId: string): void {
  stuckStreak.delete(roomId);
}

export function onHostHealth(roomId: string, report: HostHealthReport): void {
  const room = getRoom(roomId);
  if (!room || !room.nativeMode) return;
  const stuck = report.viewers > 0 && report.acquired >= MIN_ACQUIRED && report.encoded === 0 && report.sendOk === 0;
  if (!stuck) {
    stuckStreak.delete(roomId);
    return;
  }
  const streak = (stuckStreak.get(roomId) ?? 0) + 1;
  stuckStreak.set(roomId, streak);
  if (streak >= STUCK_INTERVALS) closeBrokenRoom(roomId, report);
}

function closeBrokenRoom(roomId: string, report: HostHealthReport): void {
  const room = getRoom(roomId);
  if (!room) return;
  console.warn(`[roomHealth] sala ${roomId} encerrada: encoder do host sem saída há ${STUCK_INTERVALS} heartbeats com ${report.viewers} espectador(es).`);
  recordClosure(roomId, room.source, room.appVersion, "room_closed_unhealthy", { ...report });
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

function recordClosure(roomId: string, source: string, appVersion: string | null, reason: string, data: Record<string, number>): void {
  const sql = db();
  if (!sql) return;
  sql`
    INSERT INTO ocs_telemetry_events (room_id, session_id, role, source, reason, app_version, data)
    VALUES (${roomId}, ${null}, ${"host"}, ${source}, ${reason}, ${appVersion}, ${sql.json(data)})
  `.catch((err: Error) => console.error("[roomHealth] falha ao gravar encerramento:", err.message));
}

// Pro painel: heartbeats seguidos com encoder sem saída (0 = saudável ou sem dado).
export function roomHealthState(roomId: string): "suspect" | null {
  return (stuckStreak.get(roomId) ?? 0) > 0 ? "suspect" : null;
}
