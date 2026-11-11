import { useState } from "react";

// Gráfico de linhas simples (SVG, sem lib) pro painel admin: crosshair + tooltip ao passar o
// mouse, legenda clicável (liga/desliga série). `null` = sem dado naquele ponto (a linha quebra).
//
// `normalized`: cada série é desenhada relativa ao PRÓPRIO máximo (0–100%) — permite pôr métricas
// de unidades diferentes (%, minutos, horas…) num gráfico só pra comparar a tendência; o valor real
// de cada uma aparece no tooltip (`format` da série).

export interface TrendSeries {
  label: string;
  color: string;
  values: (number | null)[];
  format?: (v: number) => string;
}

interface Props {
  xLabels: string[];
  series: TrendSeries[];
  format?: (v: number) => string;
  normalized?: boolean;
  // Contexto extra no tooltip por ponto (ex.: "41 sessões").
  detail?: (pointIndex: number) => string | null;
}

const W = 720;
const H = 240;
const PAD = { top: 12, right: 16, bottom: 28, left: 52 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * exp >= v) ?? 10;
  return step * exp;
}

// Curva monotônica (Fritsch–Carlson): suave sem "passar" dos pontos (não inventa pico/vale).
function smoothPath(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    slope.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) t.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  t.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / slope[i];
    const b = t[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      t[i] = k * a * slope[i];
      t[i + 1] = k * b * slope[i];
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const h = dx[i] / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + t[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

export function TrendChart({ xLabels, series, format, normalized, detail }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = series.filter((s) => !hidden.has(s.label));
  const hasData = series.some((s) => s.values.some((v) => v !== null));
  if (xLabels.length === 0 || !hasData) return <p className="admin-empty">Sem dados no período.</p>;

  const seriesMax = (s: TrendSeries) => Math.max(0, ...s.values.filter((v): v is number => v !== null));
  const globalMax = niceMax(Math.max(0, ...visible.map(seriesMax)));
  // Valor em escala do eixo: normalizado = % do máximo da série.
  const scaled = (s: TrendSeries, v: number) => {
    if (!normalized) return v;
    const m = seriesMax(s);
    return m > 0 ? (v / m) * 100 : 0;
  };
  const max = normalized ? 100 : globalMax;
  const axisFmt = normalized ? (v: number) => `${v.toFixed(0)}%` : (format ?? ((v: number) => String(v)));

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (xLabels.length === 1 ? innerW / 2 : (i / (xLabels.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(xLabels.length / 8));

  // Trechos contínuos (null quebra a linha), cada um suavizado.
  const pathFor = (s: TrendSeries) => {
    const segments: [number, number][][] = [[]];
    s.values.forEach((v, i) => {
      if (v === null) segments.push([]);
      else segments[segments.length - 1].push([x(i), y(scaled(s, v))]);
    });
    return segments.map(smoothPath).join("");
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    xLabels.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    setHover(best);
  };

  const toggle = (label: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  const extra = hover !== null ? detail?.(hover) : null;

  return (
    <div className="trend">
      {series.length > 1 && (
        <div className="trend-legend">
          {series.map((s) => (
            <button
              key={s.label}
              className={`trend-legend-item${hidden.has(s.label) ? " trend-legend-off" : ""}`}
              onClick={() => toggle(s.label)}
              title="Mostrar/ocultar"
            >
              <span className="trend-swatch" style={{ background: s.color }} /> {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="trend-plot">
        <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="trend-grid" />
              <text x={PAD.left - 6} y={y(t) + 4} className="trend-axis" textAnchor="end">
                {axisFmt(t)}
              </text>
            </g>
          ))}
          {xLabels.map((l, i) =>
            i % labelEvery === 0 || i === xLabels.length - 1 ? (
              <text key={i} x={x(i)} y={H - 8} className="trend-axis" textAnchor="middle">
                {l}
              </text>
            ) : null,
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="trend-cross" />}
          {visible.map((s) => (
            <g key={s.label}>
              <path d={pathFor(s)} fill="none" stroke={s.color} className="trend-line" />
              {s.values.map((v, i) =>
                v === null || (hover !== i && s.values.length > 12) ? null : (
                  <circle key={i} cx={x(i)} cy={y(scaled(s, v))} r={hover === i ? 4.5 : 2.5} fill={s.color} className="trend-dot" />
                ),
              )}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div className={`trend-tip${x(hover) > W * 0.6 ? " trend-tip-left" : ""}`} style={{ left: `${(x(hover) / W) * 100}%` }}>
            <strong>{xLabels[hover]}</strong>
            {extra && <div className="admin-sub">{extra}</div>}
            {visible.map((s) => {
              const v = s.values[hover];
              if (v === null || v === undefined) return null;
              const fmt = s.format ?? format ?? String;
              return (
                <div key={s.label}>
                  <span className="trend-swatch" style={{ background: s.color }} /> {series.length > 1 ? `${s.label}: ` : ""}
                  {fmt(v)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
