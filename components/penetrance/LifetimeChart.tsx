import { MEASURE_LABELS, type MeasureKey } from "@/lib/penetrance/types";
import { formatPct } from "@/lib/penetrance/stats";
import { niceMax } from "./AgeChart";

interface Row {
  measure: MeasureKey;
  pct: number;
  low: number;
  high: number;
}

const W = 640;
const M = { left: 120, right: 20, top: 8, rowH: 52, axis: 28 };

/** Horizontal bars with 95% CI whiskers; used when a dataset has no age dimension. */
export function LifetimeChart({ rows }: { rows: Row[] }) {
  const max = niceMax(Math.max(...rows.map((r) => r.high)));
  const x = (v: number) => M.left + (v / max) * (W - M.left - M.right);
  const H = M.top + rows.length * M.rowH + M.axis;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <figure className="age-chart lifetime-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={rows.map((r) => `${MEASURE_LABELS[r.measure]} ${formatPct(r.pct)}, 95% CI ${formatPct(r.low)} to ${formatPct(r.high)}`).join("; ")}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={x(t)} x2={x(t)} y1={M.top} y2={H - M.axis} />
            <text className="tick" x={x(t)} y={H - 8} textAnchor="middle">
              {Number(t.toFixed(2))}%
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cy = M.top + i * M.rowH + M.rowH / 2;
          return (
            <g key={r.measure}>
              <text className="row-label" x={M.left - 10} y={cy + 4} textAnchor="end">
                {MEASURE_LABELS[r.measure]}
              </text>
              <rect className={`bar bar-${r.measure}`} x={M.left} y={cy - 10} width={Math.max(2, x(r.pct) - M.left)} height={20} rx={3} />
              <line className="whisker" x1={x(r.low)} x2={x(r.high)} y1={cy} y2={cy} />
              <line className="whisker" x1={x(r.low)} x2={x(r.low)} y1={cy - 7} y2={cy + 7} />
              <line className="whisker" x1={x(r.high)} x2={x(r.high)} y1={cy - 7} y2={cy + 7} />
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
