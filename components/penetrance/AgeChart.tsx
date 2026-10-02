import { MEASURE_LABELS, type AgePoint, type MeasureKey } from "@/lib/penetrance/types";
import { formatPct, interpolateAges as interpolate } from "@/lib/penetrance/stats";

const W = 640;
const H = 240;
const M = { top: 14, right: 16, bottom: 34, left: 44 };

interface Props {
  points: AgePoint[];
  age: number;
  onAge: (age: number) => void;
  synthetic?: boolean;
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100];
  return steps.find((s) => s >= v * 1.05) ?? 100;
}

export function AgeChart({ points, age, onAge, synthetic }: Props) {
  const minAge = points[0].age;
  const maxAge = points[points.length - 1].age;
  const yMax = niceMax(Math.max(...points.map((p) => Math.max(p.icd10, p.algorithm))));
  const x = (a: number) => M.left + ((a - minAge) / Math.max(1, maxAge - minAge)) * (W - M.left - M.right);
  const y = (v: number) => H - M.bottom - (v / yMax) * (H - M.top - M.bottom);
  const line = (k: MeasureKey) => points.map((p, i) => `${i ? "L" : "M"}${x(p.age).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTicks = points.map((p) => p.age).filter((a) => a % 10 === 0);

  return (
    <figure className="age-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Cumulative penetrance by age, ${minAge} to ${maxAge} years${synthetic ? " (synthetic demo)" : ""}`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const a = minAge + ((px - M.left) / (W - M.left - M.right)) * (maxAge - minAge);
          onAge(Math.round(Math.min(maxAge, Math.max(minAge, a))));
        }}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={M.left - 8} y={y(t) + 4} textAnchor="end">
              {Number(t.toFixed(2))}%
            </text>
          </g>
        ))}
        {xTicks.map((a) => (
          <text key={a} className="tick" x={x(a)} y={H - M.bottom + 18} textAnchor="middle">
            {a}
          </text>
        ))}
        <text className="tick" x={(M.left + W - M.right) / 2} y={H - 4} textAnchor="middle">
          Age (years)
        </text>
        <path className="series series-algorithm" d={line("algorithm")} />
        <path className="series series-icd10" d={line("icd10")} />
        <line className="age-marker" x1={x(age)} x2={x(age)} y1={M.top} y2={H - M.bottom} />
        {points.length > 0 &&
          (["icd10", "algorithm"] as MeasureKey[]).map((k) => {
            const v = interpolate(points, k, age);
            return <circle key={k} className={`dot dot-${k}`} cx={x(age)} cy={y(v)} r={5} />;
          })}
      </svg>
      <figcaption className="legend">
        {(["icd10", "algorithm"] as MeasureKey[]).map((k) => (
          <span key={k} className={`legend-item tone-${k}`}>
            <i aria-hidden="true" /> {MEASURE_LABELS[k]}: {formatPct(interpolate(points, k, age))} by age {age}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
