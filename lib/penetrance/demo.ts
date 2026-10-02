import type { AgePoint, PenetranceDataset, PenetranceRecord } from "./types";

/** Typical mid-onset age and spread (years) per disease, for the illustrative demo only. */
const ONSET: Record<string, { mid: number; spread: number }> = {
  "age-related macular degeneration": { mid: 72, spread: 7 },
  "malignant tumor of prostate": { mid: 66, spread: 8 },
  "familial cancer of breast": { mid: 52, spread: 11 },
  "familial hypercholesterolemia": { mid: 38, spread: 12 },
  "diabetes mellitus type 2": { mid: 55, spread: 10 },
  "hepatocellular carcinoma": { mid: 62, spread: 9 },
  "brugada syndrome": { mid: 40, spread: 10 },
  "arrhythmogenic right ventricular cardiomyopathy": { mid: 35, spread: 10 },
  "primary pulmonary hypertension": { mid: 45, spread: 12 },
};
const DEFAULT_ONSET = { mid: 55, spread: 10 };
export const DEMO_AGES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];

const logistic = (age: number, mid: number, spread: number) => 1 / (1 + Math.exp(-(age - mid) / spread));

/** Monotone S-curve, rescaled so it is 0 at birth and 1 at the final age. */
function curve(age: number, disease: string): number {
  const { mid, spread } = ONSET[disease.toLowerCase()] ?? DEFAULT_ONSET;
  const lo = logistic(0, mid, spread);
  const hi = logistic(DEMO_AGES[DEMO_AGES.length - 1], mid, spread);
  return (logistic(age, mid, spread) - lo) / (hi - lo);
}

/**
 * Builds an illustrative age-specific dataset by spreading each variant's
 * lifetime penetrance over an assumed onset curve. NOT measured data; it
 * exists to show what the viewer does once real age-specific data is loaded.
 */
export function makeDemoDataset(source: PenetranceRecord[]): PenetranceDataset {
  const records = source.map((rec) => {
    const ages: AgePoint[] = DEMO_AGES.map((age) => {
      const f = curve(age, rec.disease);
      return { age, pct: rec.pct * f };
    });
    return { ...rec, ages };
  });
  return {
    id: "demo",
    label: "Demo: age-specific",
    description: "Synthetic age curves built from the eTable 4 lifetime values. Illustrative only, not measured.",
    source: undefined,
    synthetic: true,
    records,
    warnings: [],
  };
}
