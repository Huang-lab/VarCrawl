import type { AgePoint, PenetranceRecord } from "./types";

/** Wilson score interval for a binomial proportion, as percentages. */
export function wilsonInterval(affected: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 100 };
  const p = affected / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, (center - half) * 100), high: Math.min(100, (center + half) * 100) };
}

/**
 * Fill fraction (0-1) for each of `total` person icons so that the filled area
 * equals pct% of the grid. Fractional people render as partially filled icons
 * rather than being rounded away.
 */
export function iconFills(pct: number, total: number): number[] {
  const clamped = Math.min(100, Math.max(0, pct));
  let remaining = (clamped / 100) * total;
  const fills: number[] = [];
  for (let i = 0; i < total; i++) {
    const f = Math.min(1, Math.max(0, remaining));
    fills.push(Math.round(f * 100) / 100);
    remaining -= f;
  }
  return fills;
}

/** Linear interpolation of cumulative penetrance (%) on an ascending age curve. */
export function interpolateAges(pts: AgePoint[], age: number): number {
  if (age <= pts[0].age) return pts[0].pct;
  for (let i = 1; i < pts.length; i++) {
    if (age <= pts[i].age) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.pct + ((age - a.age) / (b.age - a.age)) * (b.pct - a.pct);
    }
  }
  return pts[pts.length - 1].pct;
}

/** Cumulative penetrance (%) at an age; undefined without age data. */
export function penetranceAtAge(rec: PenetranceRecord, age: number): number | undefined {
  return rec.ages && rec.ages.length > 0 ? interpolateAges(rec.ages, age) : undefined;
}

/** Format a percentage with sensible precision for small values. */
export function formatPct(pct: number): string {
  if (pct === 0) return "0%";
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** "3 in 100" style phrasing, picking a denominator that keeps the count sensible. */
export function perHundredPhrase(pct: number, total: number): string {
  const n = (pct / 100) * total;
  const shown = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${shown} of ${total.toLocaleString("en-US")}`;
}

export function ageRange(points: AgePoint[]): { min: number; max: number } {
  return { min: points[0].age, max: points[points.length - 1].age };
}

/** "1 in 250" style phrasing for a percentage, for rates too small to picture as a percent. */
export function oneInPhrase(pct: number): string {
  if (pct <= 0) return "0";
  const n = 100 / pct;
  // Two significant figures: "1 in 310", not "1 in 312.5".
  const step = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return `1 in ${(Math.round(n / step) * step).toLocaleString("en-US")}`;
}

/** Plain-language rate: "12%" for common outcomes, "about 1 in 250" for rare ones. */
export function formatRate(pct: number): string {
  return pct >= 2 ? formatPct(pct) : `about ${oneInPhrase(pct)}`;
}

export type BaselineVerdict = "higher" | "similar" | "lower";

export interface BaselineComparison {
  /** Carrier penetrance divided by the baseline rate. */
  ratio: number;
  /**
   * "higher" or "lower" only when the baseline sits outside the carriers' 95% interval,
   * so a small carrier count reads as "similar" rather than overclaiming.
   */
  verdict: BaselineVerdict;
}

export function compareToBaseline(pct: number, ci: { low: number; high: number }, baselinePct: number): BaselineComparison {
  const verdict: BaselineVerdict = baselinePct < ci.low ? "higher" : baselinePct > ci.high ? "lower" : "similar";
  return { ratio: baselinePct > 0 ? pct / baselinePct : Infinity, verdict };
}

/** "3.2 times" style ratio text. */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "much more";
  if (ratio >= 10) return `${Math.round(ratio)} times`;
  return `${(Math.round(ratio * 10) / 10).toString()} times`;
}
