/**
 * Background rates for the diseases in the bundled penetrance data, so a
 * carrier's risk can be read against what a person without the variant faces.
 *
 * These are approximate, published general-population figures, not the rate in
 * the cohort that produced the penetrance data. They are meant for orientation
 * and should be verified against the cited source before any clinical use.
 */
export interface Baseline {
  /** Percent of the reference population affected. */
  pct: number;
  /** What the figure measures, as it should read in "the general population: ...". */
  kind: "lifetime risk" | "prevalence";
  /** Who the figure describes, e.g. "women" or "adults aged 45-85". */
  population: string;
  /** Short citation. */
  source: string;
}

const BASELINES: Record<string, Baseline> = {
  "age-related macular degeneration": {
    pct: 8.7,
    kind: "prevalence",
    population: "adults aged 45-85",
    source: "Wong et al., Lancet Glob Health 2014",
  },
  "malignant tumor of prostate": {
    pct: 12.9,
    kind: "lifetime risk",
    population: "men",
    source: "SEER / American Cancer Society",
  },
  "familial cancer of breast": {
    pct: 13,
    kind: "lifetime risk",
    population: "women",
    source: "SEER / American Cancer Society",
  },
  "familial hypercholesterolemia": {
    pct: 0.32,
    kind: "prevalence",
    population: "people of all ages",
    source: "Beheshti et al., J Am Coll Cardiol 2020 (about 1 in 313)",
  },
  "diabetes mellitus type 2": {
    pct: 14.7,
    kind: "prevalence",
    population: "US adults, diagnosed and undiagnosed",
    source: "CDC National Diabetes Statistics Report (all diabetes, mostly type 2)",
  },
  "hepatocellular carcinoma": {
    pct: 0.8,
    kind: "lifetime risk",
    population: "people in the US (liver cancer, mostly HCC)",
    source: "SEER",
  },
  "brugada syndrome": {
    pct: 0.05,
    kind: "prevalence",
    population: "people of all ages (about 1 in 2,000; higher in Asia)",
    source: "Vutthikraivit et al., Acta Cardiol Sin 2018",
  },
  "arrhythmogenic right ventricular cardiomyopathy": {
    pct: 0.03,
    kind: "prevalence",
    population: "people of all ages (estimates range from 1 in 2,000 to 1 in 5,000)",
    source: "Corrado et al., N Engl J Med 2017",
  },
  "primary pulmonary hypertension": {
    pct: 0.0005,
    kind: "prevalence",
    population: "adults (idiopathic PAH, about 5 per million)",
    source: "Humbert et al., Eur Respir J 2022 (ESC/ERS guidelines)",
  },
};

/** Base rate for a disease, when one is on file. Matching ignores case. */
export function baselineFor(disease: string): Baseline | undefined {
  return BASELINES[disease.trim().toLowerCase()];
}
