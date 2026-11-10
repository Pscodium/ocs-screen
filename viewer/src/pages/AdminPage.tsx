import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TrendChart, type TrendSeries } from "../components/TrendChart";
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
// Métricas agregadas por sessão (backend: CTE `sessions` em routes/admin.ts). Postgres manda
// numeric como string.
interface Metrics {
  source: string;
  role: string;
  sessions: string;
  failed_sessions: string;
  avg_duration_s: string | null;
  total_hours?: string | null;
  avg_first_frame_ms?: string | null;
  avg_recoveries?: string | null;
}
interface VersionRow extends Metrics {
  version: string;
  last_seen: string;
}
interface TrendDailyRow extends Metrics {
  day: string;
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
  trendDaily?: TrendDailyRow[];
  failureReasons: ReasonRow[];
}

// Grupos fixos (cor segue o grupo, nunca a posição) — app e viewer têm numeração de versão própria.
const GROUPS = [
  { key: "web-viewer", source: "web", role: "viewer", color: "#23a55a" },
  { key: "desktop-host", source: "desktop", role: "host", color: "#5865f2" },
  { key: "web-host", source: "web", role: "host", color: "#d0682a" },
] as const;
type GroupKey = (typeof GROUPS)[number]["key"];

const num = (v: string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

type MetricKey = "failRate" | "sessions" | "avgDuration" | "totalHours" | "firstFrame" | "recoveries";
const METRICS: { key: MetricKey; label: string; format: (v: number) => string; get: (m: Metrics) => number | null }[] = [
  {
    key: "failRate",
    label: "Taxa de falha",
    format: (v) => `${v.toFixed(0)}%`,
    get: (m) => (Number(m.sessions) > 0 ? (Number(m.failed_sessions) / Number(m.sessions)) * 100 : null),
  },
  { key: "sessions", label: "Sessões", format: (v) => v.toFixed(0), get: (m) => Number(m.sessions) },
  { key: "avgDuration", label: "Duração média", format: (v) => `${v.toFixed(0)} min`, get: (m) => (num(m.avg_duration_s) ?? NaN) / 60 || null },
  { key: "totalHours", label: "Horas totais", format: (v) => `${v.toFixed(1)} h`, get: (m) => num(m.total_hours) },
  { key: "firstFrame", label: "Tempo até 1º quadro (espectador)", format: (v) => `${(v / 1000).toFixed(1)} s`, get: (m) => num(m.avg_first_frame_ms) },
  { key: "recoveries", label: "Quedas por sessão", format: (v) => v.toFixed(2), get: (m) => num(m.avg_recoveries) },
];

const groupOf = (m: { source: string; role: string }): GroupKey | null =>
  GROUPS.find((g) => g.source === m.source && g.role === m.role)?.key ?? null;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" });

function Trends({ stats }: { stats: Stats }) {
  const [metricKey, setMetricKey] = useState<MetricKey>("failRate");
  const [versionGroup, setVersionGroup] = useState<GroupKey>("web-viewer");
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];

  // Por versão: só versões com sessão no período, em ordem semântica.
  const versions = stats.byVersion
    .filter((v) => groupOf(v) === versionGroup && v.version !== "desconhecida")
    .sort((a, b) => compareVersions(a.version, b.version));
  const vGroup = GROUPS.find((g) => g.key === versionGroup) ?? GROUPS[0];
  const versionSeries: TrendSeries[] = [{ label: vGroup.key, color: vGroup.color, values: versions.map(metric.get) }];

  // Por dia: uma linha por grupo; dia sem sessão do grupo = sem ponto.
  const trend = stats.trendDaily ?? [];
  const days = [...new Set(trend.map((r) => r.day))].sort();
  const cell = (g: GroupKey, day: string) => trend.find((r) => r.day === day && groupOf(r) === g);
  const dayGroups = GROUPS.filter((g) => trend.some((r) => groupOf(r) === g.key));
  const daySeries: TrendSeries[] = dayGroups.map((g) => ({
    label: roleLabel(g.role, g.source),
    color: g.color,
    values: days.map((d) => {
      const row = cell(g.key, d);
      return row ? metric.get(row) : null;
    }),
  }));

  return (
    <section>
      <h2>Tendências</h2>
      <div className="trend-controls">
        <label>
          Métrica{" "}
          <select value={metricKey} onChange={(e) => setMetricKey(e.target.value as MetricKey)}>
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="trend-title">
        {metric.label} por versão —{" "}
        <select value={versionGroup} onChange={(e) => setVersionGroup(e.target.value as GroupKey)}>
          {GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {roleLabel(g.role, g.source)}
            </option>
          ))}
        </select>
      </h3>
      <TrendChart
        xLabels={versions.map((v) => v.version)}
        series={versionSeries}
        format={metric.format}
        detail={(_, i) => `${versions[i].sessions} sessões, ${versions[i].failed_sessions} com falha`}
      />

      <h3 className="trend-title">{metric.label} por dia</h3>
      <TrendChart
        xLabels={days.map(fmtDay)}
        series={daySeries}
        format={metric.format}
        detail={(si, i) => {
          const row = cell(dayGroups[si].key, days[i]);
          return row ? `${row.sessions} sessões, ${row.failed_sessions} com falha` : null;
        }}
      />
      <p className="admin-note">
        Cada ponto agrega sessões (não relatórios). Versão/dia com poucas sessões oscila muito — veja a contagem no tooltip.
      </p>
    </section>
  );
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
                            encoder sem saída (aguardando ~90s)
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
              Encerramento automático só com app ≥ 1.5.3: o próprio app relata ~90s seguidos de encoder sem saída com espectador conectado. Sala sem
              espectador ou com tela parada nunca é tocada. App antigo: só pelo botão.
            </p>
          </section>

          <Trends stats={stats} />

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
                  <th>Horas</th>
                  <th>1º quadro</th>
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
                    <td>{num(v.total_hours) !== null ? `${num(v.total_hours)?.toFixed(1)} h` : "—"}</td>
                    <td>{num(v.avg_first_frame_ms) !== null ? `${((num(v.avg_first_frame_ms) ?? 0) / 1000).toFixed(1)} s` : "—"}</td>
                    <td>{fmtDate(v.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="admin-note">Falha = sessão com algum relatório de erro. Não contam: fim normal, espectador fechando a aba, host encerrando, queda que reconectou, vídeo que chegou atrasado.</p>
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
