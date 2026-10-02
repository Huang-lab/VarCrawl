/** Cumulative penetrance (percent of carriers with an ICD-10 diagnosis) by a given age. */
export interface AgePoint {
  age: number;
  pct: number;
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
  /** Carriers with an ICD-10 diagnosis of the disease. */
  affected: number;
  /** Penetrance in percent (0-100): affected / carriers. */
  pct: number;
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
