import { useState } from "react";

// Gráfico de linhas simples (SVG, sem lib) pro painel admin: um eixo Y só, uma linha por série,
// crosshair + tooltip ao passar o mouse. `null` = sem dado naquele ponto (a linha quebra).

export interface TrendSeries {
  label: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  xLabels: string[];
  series: TrendSeries[];
  format: (v: number) => string;
  // Legenda fica fora quando vários gráficos dividem os mesmos grupos (small multiples).
  hideLegend?: boolean;
  // Contexto extra no tooltip (ex.: "41 sessões") por série/ponto.
  detail?: (seriesIndex: number, pointIndex: number) => string | null;
}

const W = 480;
const H = 200;
const PAD = { top: 12, right: 16, bottom: 28, left: 52 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * exp >= v) ?? 10;
  return step * exp;
}

export function TrendChart({ xLabels, series, format, hideLegend, detail }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (xLabels.length === 0 || all.length === 0) return <p className="admin-empty">Sem dados no período.</p>;

  const max = niceMax(Math.max(...all));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (xLabels.length === 1 ? innerW / 2 : (i / (xLabels.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // Rótulos do eixo X: no máximo ~8, pra não encavalar.
  const labelEvery = Math.max(1, Math.ceil(xLabels.length / 8));

  const pathFor = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
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

  return (
    <div className="trend">
      {series.length > 1 && !hideLegend && (
        <p className="admin-legend">
          {series.map((s) => (
            <span key={s.label} className="trend-legend-item">
              <span className="trend-swatch" style={{ background: s.color }} /> {s.label}
            </span>
          ))}
        </p>
      )}
      <div className="trend-plot">
        <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="trend-grid" />
              <text x={PAD.left - 6} y={y(t) + 4} className="trend-axis" textAnchor="end">
                {format(t)}
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
          {series.map((s) => (
            <g key={s.label}>
              <path d={pathFor(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) =>
                v === null ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} fill={s.color} className="trend-dot" />
                ),
              )}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div className="trend-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <strong>{xLabels[hover]}</strong>
            {series.map((s, si) => {
              const v = s.values[hover];
              if (v === null || v === undefined) return null;
              const extra = detail?.(si, hover);
              return (
                <div key={s.label}>
                  <span className="trend-swatch" style={{ background: s.color }} /> {series.length > 1 ? `${s.label}: ` : ""}
                  {format(v)}
                  {extra && <span className="admin-sub"> · {extra}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
