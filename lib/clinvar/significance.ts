export type SigClass = "sig-path" | "sig-lpath" | "sig-vus" | "sig-lbenign" | "sig-benign" | "sig-other";

export function sigClass(sig?: string): SigClass {
  const x = (sig ?? "").trim().toLowerCase();
  if (x.includes("conflicting") || x.includes("uncertain")) return "sig-vus";
  // "Pathogenic/Likely pathogenic" is reported as pathogenic; "Likely pathogenic" alone is not.
  if (x.startsWith("pathogenic")) return "sig-path";
  if (x.startsWith("likely pathogenic")) return "sig-lpath";
  if (x.startsWith("benign")) return "sig-benign";
  if (x.startsWith("likely benign")) return "sig-lbenign";
  return "sig-other";
}

const SEVERITY: SigClass[] = ["sig-path", "sig-lpath", "sig-vus", "sig-lbenign", "sig-benign", "sig-other"];

/** Most clinically severe significance among ClinVar records (for a one-line summary). */
export function topSignificance(records: { clinicalSignificance?: string }[]): { label: string; cls: SigClass } | undefined {
  let best: { label: string; cls: SigClass } | undefined;
  for (const r of records) {
    if (!r.clinicalSignificance) continue;
    const cls = sigClass(r.clinicalSignificance);
    if (!best || SEVERITY.indexOf(cls) < SEVERITY.indexOf(best.cls)) best = { label: r.clinicalSignificance, cls };
  }
  return best;
}
