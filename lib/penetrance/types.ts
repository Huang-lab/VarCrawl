export type MeasureKey = "icd10" | "algorithm";

export const MEASURE_LABELS: Record<MeasureKey, string> = {
  icd10: "ICD-10 codes",
  algorithm: "Clinical algorithm",
};

export interface Measure {
  /** Carriers classified as affected under this definition. */
  affected: number;
  /** Penetrance in percent (0-100): affected / carriers. */
  pct: number;
}

/** Cumulative penetrance (percent of carriers affected) by a given age. */
export interface AgePoint {
  age: number;
  icd10: number;
  algorithm: number;
  /** Carriers in this age row, when the source reports it. */
  carriers?: number;
}

export interface PenetranceRecord {
  /** Stable key: disease|chr:pos:ref>alt */
  id: string;
  disease: string;
  chr: string;
  pos: number;
  ref: string;
  alt: string;
  rsid?: string;
  carriers: number;
  icd10: Measure;
  algorithm: Measure;
  /** Age-specific cumulative penetrance, ascending by age. Absent for lifetime-only data. */
  ages?: AgePoint[];
}

export interface PenetranceDataset {
  id: string;
  label: string;
  description: string;
  /** Where the numbers come from. */
  source?: { label: string; url: string };
  /** True when values are illustrative rather than measured. */
  synthetic?: boolean;
  records: PenetranceRecord[];
  warnings: string[];
}
