import { parseCsv } from "./csv";
import type { AgePoint, PenetranceDataset, PenetranceRecord } from "./types";

/**
 * Accepted columns (case-insensitive, matched by prefix):
 *   Disease, CHR, POS, REF, ALT, rsID,
 *   "Individuals with variants, n",
 *   "ICD-10 affected individuals with variants, n",
 *   "Clinical algorithm affected individuals with variants, n"
 * Optional: "Age" - when present, rows sharing a variant are treated as one
 * cumulative-penetrance-by-age curve; the oldest age row gives the lifetime value and carrier count.
 * Penetrance % columns are ignored and recomputed from counts.
 */
const COLS = {
  disease: /^disease$/,
  chr: /^chr/,
  pos: /^pos/,
  ref: /^ref$/,
  alt: /^alt$/,
  rsid: /^rsid/,
  carriers: /^individuals with variants/,
  icd10: /^icd-?10 affected/,
  algorithm: /^clinical algorithm affected/,
  age: /^age/,
} as const;

type ColKey = keyof typeof COLS;

function findColumns(header: string[]): Partial<Record<ColKey, number>> {
  const out: Partial<Record<ColKey, number>> = {};
  header.forEach((h, i) => {
    const name = h.trim().toLowerCase();
    for (const key of Object.keys(COLS) as ColKey[]) {
      if (out[key] === undefined && COLS[key].test(name)) out[key] = i;
    }
  });
  return out;
}

/** Number('') is 0; treat blank cells as missing instead. */
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

const pct = (affected: number, n: number) => (n > 0 ? (affected / n) * 100 : 0);

export function parsePenetranceCsv(
  text: string,
  meta: { id: string; label: string; description: string },
): PenetranceDataset {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  if (rows.length < 2) {
    return { ...meta, records: [], warnings: ["The file has no data rows."] };
  }

  const cols = findColumns(rows[0]);
  const required: ColKey[] = ["disease", "chr", "pos", "ref", "alt", "carriers", "icd10", "algorithm"];
  const missing = required.filter((k) => cols[k] === undefined);
  if (missing.length > 0) {
    return { ...meta, records: [], warnings: [`Missing required column(s): ${missing.join(", ")}.`] };
  }
  const cell = (r: string[], k: ColKey) => (cols[k] === undefined ? "" : (r[cols[k]!] ?? "").trim());

  const byId = new Map<string, PenetranceRecord>();
  let skipped = 0;

  rows.slice(1).forEach((r, idx) => {
    const carriers = num(cell(r, "carriers"));
    const icd = num(cell(r, "icd10"));
    const alg = num(cell(r, "algorithm"));
    const pos = num(cell(r, "pos"));
    const disease = cell(r, "disease");
    const validCounts = [carriers, icd, alg].every((v) => Number.isFinite(v) && v >= 0) && icd <= carriers && alg <= carriers;
    if (!disease || !Number.isFinite(pos) || !validCounts) {
      skipped++;
      if (skipped <= 3) warnings.push(`Row ${idx + 2} skipped: missing or inconsistent values.`);
      return;
    }

    const chr = cell(r, "chr").replace(/^chr/i, "");
    const ref = cell(r, "ref");
    const alt = cell(r, "alt");
    const id = `${disease}|${chr}:${pos}:${ref}>${alt}`;
    const ageRaw = cell(r, "age");
    const age = ageRaw === "" ? undefined : num(ageRaw);
    if (ageRaw !== "" && !Number.isFinite(age)) {
      skipped++;
      return;
    }

    let rec = byId.get(id);
    if (rec && age === undefined) {
      warnings.push(`Row ${idx + 2} repeats ${disease} ${chr}:${pos} ${ref}>${alt}; the first row is used.`);
      return;
    }
    if (!rec) {
      rec = {
        id,
        disease,
        chr,
        pos,
        ref,
        alt,
        rsid: /^rs\d+$/i.test(cell(r, "rsid")) ? cell(r, "rsid") : undefined,
        carriers,
        icd10: { affected: icd, pct: pct(icd, carriers) },
        algorithm: { affected: alg, pct: pct(alg, carriers) },
      };
      byId.set(id, rec);
    }
    if (age !== undefined) {
      const point: AgePoint = { age, icd10: pct(icd, carriers), algorithm: pct(alg, carriers), carriers };
      rec.ages = [...(rec.ages ?? []), point];
    }
  });

  const records = Array.from(byId.values());
  for (const rec of records) {
    if (!rec.ages) continue;
    rec.ages.sort((a, b) => a.age - b.age);
    const last = rec.ages[rec.ages.length - 1];
    // Lifetime figures come from the oldest age row, including its carrier count.
    rec.carriers = last.carriers ?? rec.carriers;
    rec.icd10 = { affected: Math.round((last.icd10 / 100) * rec.carriers), pct: last.icd10 };
    rec.algorithm = { affected: Math.round((last.algorithm / 100) * rec.carriers), pct: last.algorithm };
  }

  if (skipped > 3) warnings.push(`${skipped} rows skipped in total.`);
  return { ...meta, records, warnings };
}
