import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { detailSummary, envSummary, fmtDuration, reasonInfo, roleLabel, type EventData } from "./adminReasons";

// Painel interno: estatísticas da telemetria e crashes (backend/src/routes/admin.ts). O token fica
// só no navegador de quem administra; sem ele o backend responde 401/404 e nada é mostrado.

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:4000";
const TOKEN_KEY = "ocs-admin-token";

interface DailyRow {
  day: string;
  host_sessions: string;
  viewer_sessions: string;
  failures: string;
}
interface VersionRow {
  source: string;
  role: string;
  version: string;
  sessions: string;
  failed_sessions: string;
  avg_duration_s: string | null;
  last_seen: string;
}
interface ReasonRow {
  reason: string;
  role: string;
  source: string;
  count: string;
  rooms: string;
  last_seen: string;
}
interface EventRow {
  id: string;
  created_at: string;
  room_id: string;
  session_id: string | null;
  role: string;
  source: string;
  reason: string;
  app_version: string | null;
  data: EventData;
}
interface ActiveRoom {
  roomId: string;
  createdAt: number;
  source: string;
  appVersion: string | null;
  nativeMode: boolean;
  isPrivate: boolean;
  hostConnected: boolean | null;
  viewers: number | null;
  health: "suspect" | null;
}
// Filtro da lista de eventos: falhas recentes (padrão), um motivo, ou a linha do tempo de uma sala.
type EventFilter = { kind: "failures" } | { kind: "reason"; reason: string } | { kind: "room"; room: string };
interface Stats {
  days: number;
  daily: DailyRow[];
  byVersion: VersionRow[];
  failureReasons: ReasonRow[];
}
interface CrashRow {
  id: string;
  created_at: string;
  app_version: string;
  process_type: string | null;
  kind: string;
  message: string | null;
  dump_size: number | null;
}

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignora
  }
}

async function adminFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${backendUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error("Token inválido.");
  if (res.status === 404) throw new Error("Painel desligado no backend (falta POSTGRES_URL ou ADMIN_TOKEN).");
  if (!res.ok) throw new Error(`Erro ${res.status}`);
  return (await res.json()) as T;
}

const fmtDate = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const pct = (part: number, total: number) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—");

export function AdminPage() {
  const [token, setToken] = useState(readToken);
  const [draft, setDraft] = useState("");
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [crashes, setCrashes] = useState<CrashRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<EventFilter>({ kind: "failures" });
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [activeRooms, setActiveRooms] = useState<ActiveRoom[] | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [s, c] = await Promise.all([
        adminFetch<Stats>(`/admin/stats?days=${days}`, token),
        adminFetch<{ crashes: CrashRow[] }>(`/admin/crashes?days=${days}`, token).catch(() => ({ crashes: [] })),
      ]);
      setStats(s);
      setCrashes(c.crashes);
      const r = await adminFetch<{ rooms: ActiveRoom[] }>(`/admin/rooms`, token).catch(() => ({ rooms: [] }));
      setActiveRooms(r.rooms);
    } catch (err) {
      setError((err as Error).message);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [token, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadEvents = useCallback(async () => {
    if (!token) return;
    const q =
      filter.kind === "room" ? `&room=${encodeURIComponent(filter.room)}&limit=300` : filter.kind === "reason" ? `&reason=${filter.reason}` : "";
    try {
      const r = await adminFetch<{ events: EventRow[] }>(`/admin/events?days=${days}${q}`, token);
      setEvents(filter.kind === "room" ? [...r.events].reverse() : r.events);
    } catch {
      setEvents([]);
    }
  }, [token, days, filter]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  // Falha de espectador numa sala onde o transmissor também falhou = causa provável é o transmissor.
  const hostFailureByRoom = new Map<string, EventRow>();
  for (const e of events ?? []) {
    if (e.role === "host" && reasonInfo(e.reason).severity !== "info" && !hostFailureByRoom.has(e.room_id)) hostFailureByRoom.set(e.room_id, e);
  }
  const showEvents = (f: EventFilter) => {
    setFilter(f);
    document.getElementById("admin-events")?.scrollIntoView({ behavior: "smooth" });
  };

  async function closeRoom(roomId: string) {
    if (!window.confirm(`Encerrar a sala ${roomId}? O host e os espectadores são desconectados.`)) return;
    try {
      const res = await fetch(`${backendUrl}/admin/rooms/${encodeURIComponent(roomId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 404) throw new Error(`Erro ${res.status}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function downloadDump(id: string) {
    try {
      const res = await fetch(`${backendUrl}/admin/crashes/${id}/dump`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `crash-${id}.dmp`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!token) {
    return (
      <div className="admin-page">
        <h1>Painel</h1>
        <form
          className="admin-login"
          onSubmit={(e) => {
            e.preventDefault();
            const t = draft.trim();
            saveToken(t);
            setToken(t);
          }}
        >
          <input type="password" placeholder="ADMIN_TOKEN" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <button type="submit" disabled={!draft.trim()}>
            Entrar
          </button>
        </form>
        <p className="admin-back">
          <Link to="/">Voltar</Link>
        </p>
      </div>
    );
  }

  const maxDaily = Math.max(1, ...(stats?.daily.map((d) => Number(d.host_sessions) + Number(d.viewer_sessions)) ?? [1]));

  return (
    <div className="admin-page">
      <header className="admin-header">
        <h1>Painel</h1>
        <div className="admin-actions">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 dias</option>
            <option value={30}>30 dias</option>
            <option value={90}>90 dias</option>
          </select>
          <button
            onClick={() => {
              void load();
              void loadEvents();
            }}
            disabled={loading}
          >
            {loading ? "Carregando…" : "Atualizar"}
          </button>
          <button
            className="admin-logout"
            onClick={() => {
              saveToken("");
              setToken("");
              setStats(null);
            }}
          >
            Sair
          </button>
        </div>
      </header>

      {error && <p className="admin-error">{error}</p>}

      {stats && (
        <>
          <section>
            <h2>Sessões por dia</h2>
            {stats.daily.length === 0 ? (
              <p className="admin-empty">Sem dados no período.</p>
            ) : (
              <div className="admin-chart">
                {stats.daily.map((d) => {
                  const host = Number(d.host_sessions);
                  const viewer = Number(d.viewer_sessions);
                  return (
                    <div
                      key={d.day}
                      className="admin-bar"
                      title={`${new Date(d.day).toLocaleDateString("pt-BR", { timeZone: "UTC" })}: ${host} host, ${viewer} espectador, ${d.failures} falhas`}
                    >
                      <div className="admin-bar-viewer" style={{ height: `${(viewer / maxDaily) * 100}%` }} />
                      <div className="admin-bar-host" style={{ height: `${(host / maxDaily) * 100}%` }} />
                    </div>
                  );
                })}
              </div>
            )}
            <p className="admin-legend">
              <span className="admin-dot admin-dot-host" /> host <span className="admin-dot admin-dot-viewer" /> espectador
            </p>
          </section>

          <section>
            <h2>Salas ativas agora</h2>
            {!activeRooms || activeRooms.length === 0 ? (
              <p className="admin-empty">Nenhuma sala ativa.</p>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Sala</th>
                    <th>Transmissor</th>
                    <th>Aberta há</th>
                    <th>Host conectado</th>
                    <th>Espectadores</th>
                    <th>Saúde</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {activeRooms.map((r) => (
                    <tr key={r.roomId}>
                      <td>
                        <button className="admin-link" onClick={() => showEvents({ kind: "room", room: r.roomId })}>
                          {r.roomId}
                        </button>
                        {r.isPrivate && <span className="admin-sub"> privada</span>}
                      </td>
                      <td>
                        {roleLabel("host", r.source)} <span className="admin-sub">{r.appVersion ?? ""}</span>
                      </td>
                      <td>{fmtDuration(Date.now() - r.createdAt)}</td>
                      <td>{r.hostConnected === null ? "— (LiveKit)" : r.hostConnected ? "sim" : "não (aguardando volta)"}</td>
                      <td>{r.viewers ?? "—"}</td>
                      <td>
                        {r.health === "suspect" ? (
                          <>
                            <span className="admin-sev admin-sev-warn" />
                            encoder travou, aguardando confirmação
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <button className="admin-link admin-danger" onClick={() => void closeRoom(r.roomId)}>
                          Encerrar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="admin-note">
              Sala nativa travada (encoder do host sem saída e espectador ainda sem vídeo 1 min depois) é encerrada sozinha. Sala aberta sem espectador nunca é
              tocada.
            </p>
          </section>

          <section>
            <h2>Por versão</h2>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Quem</th>
                  <th>Versão</th>
                  <th>Sessões</th>
                  <th>Com falha</th>
                  <th>Duração média</th>
                  <th>Última vez</th>
                </tr>
              </thead>
              <tbody>
                {stats.byVersion.map((v) => (
                  <tr key={`${v.source}-${v.role}-${v.version}`}>
                    <td>{roleLabel(v.role, v.source)}</td>
                    <td>{v.version}</td>
                    <td>{v.sessions}</td>
                    <td>
                      {v.failed_sessions} ({pct(Number(v.failed_sessions), Number(v.sessions))})
                    </td>
                    <td>{v.avg_duration_s !== null ? `${Math.round(Number(v.avg_duration_s) / 60)} min` : "—"}</td>
                    <td>{fmtDate(v.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="admin-note">Falha = qualquer relatório exceto fim normal e recuperações (reconectou / vídeo chegou atrasado).</p>
          </section>

          <section>
            <h2>Motivos</h2>
            {stats.failureReasons.length === 0 ? (
              <p className="admin-empty">Nenhuma falha no período.</p>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>O que aconteceu</th>
                    <th>Quem</th>
                    <th>Etapa</th>
                    <th>Total</th>
                    <th>Salas</th>
                    <th>Última vez</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.failureReasons.map((r) => {
                    const info = reasonInfo(r.reason);
                    return (
                      <tr
                        key={`${r.reason}-${r.role}-${r.source}`}
                        className="admin-clickable"
                        title={info.hint}
                        onClick={() => showEvents({ kind: "reason", reason: r.reason })}
                      >
                        <td>
                          <span className={`admin-sev admin-sev-${info.severity}`} />
                          {info.label} <code className="admin-code">{r.reason}</code>
                        </td>
                        <td>{roleLabel(r.role, r.source)}</td>
                        <td>{info.stage}</td>
                        <td>{r.count}</td>
                        <td>{r.rooms}</td>
                        <td>{fmtDate(r.last_seen)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="admin-note">Clique num motivo pra ver os eventos. Passe o mouse pra ver a dica de diagnóstico.</p>
          </section>

          <section id="admin-events">
            <h2>
              {filter.kind === "failures"
                ? "Falhas recentes"
                : filter.kind === "reason"
                  ? `Eventos: ${reasonInfo(filter.reason).label}`
                  : `Sala ${filter.room} — linha do tempo`}
              {filter.kind !== "failures" && (
                <button className="admin-link admin-clear" onClick={() => setFilter({ kind: "failures" })}>
                  ver todas as falhas
                </button>
              )}
            </h2>
            {!events || events.length === 0 ? (
              <p className="admin-empty">Nenhum evento.</p>
            ) : (
              <table className="admin-table admin-events">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Sala</th>
                    <th>Quem</th>
                    <th>O que aconteceu</th>
                    <th>Ambiente</th>
                    <th>Detalhe</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => {
                    const info = reasonInfo(e.reason);
                    const hostCause = e.role === "viewer" && info.severity !== "info" ? hostFailureByRoom.get(e.room_id) : undefined;
                    return (
                      <tr key={e.id}>
                        <td>
                          {fmtDate(e.created_at)}
                          <div className="admin-sub">após {fmtDuration(e.data.elapsedMs)}</div>
                        </td>
                        <td>
                          <button className="admin-link" onClick={() => showEvents({ kind: "room", room: e.room_id })}>
                            {e.room_id}
                          </button>
                          {e.session_id && <div className="admin-sub">sessão {e.session_id}</div>}
                        </td>
                        <td>
                          {roleLabel(e.role, e.source)}
                          <div className="admin-sub">{e.app_version ?? "?"}</div>
                        </td>
                        <td title={info.hint}>
                          <span className={`admin-sev admin-sev-${info.severity}`} />
                          {info.label}
                          {hostCause && <div className="admin-cause">provável causa: transmissor — {reasonInfo(hostCause.reason).label}</div>}
                        </td>
                        <td>{envSummary(e.source, e.data)}</td>
                        <td className="admin-message">
                          {detailSummary(e.role, e.data)}
                          <details>
                            <summary>dados</summary>
                            <pre>{JSON.stringify(e.data, null, 2)}</pre>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h2>Crashes</h2>
            {!crashes || crashes.length === 0 ? (
              <p className="admin-empty">Nenhum crash no período.</p>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Versão</th>
                    <th>Tipo</th>
                    <th>Detalhe</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {crashes.map((c) => (
                    <tr key={c.id}>
                      <td>{fmtDate(c.created_at)}</td>
                      <td>{c.app_version}</td>
                      <td>
                        {c.kind}
                        {c.process_type ? ` / ${c.process_type}` : ""}
                      </td>
                      <td className="admin-message">{c.message ?? "—"}</td>
                      <td>
                        {c.dump_size !== null && (
                          <button className="admin-link" onClick={() => void downloadDump(c.id)}>
                            .dmp ({Math.round(c.dump_size / 1024)} KB)
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
