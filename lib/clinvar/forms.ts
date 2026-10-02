/** Protein forms ClinVar titles can contain: no accession prefix, and frameshifts abbreviated as "fs". */
export function proteinFormsFor(raw: string): string[] {
  const bare = raw.replace(/^p\./i, "").replace(/^[A-Z]{2}_\d+(?:\.\d+)?:(?:p\.)?/, "");
  if (!bare) return [];
  const out = [bare];
  const fs = /^([A-Za-z]+\d+)[A-Za-z]*fs(?:Ter\d+|\*\d+)?$/.exec(bare);
  if (fs) out.push(`${fs[1]}fs`);
  return out.flatMap((f) => [f, `p.${f}`]);
}
