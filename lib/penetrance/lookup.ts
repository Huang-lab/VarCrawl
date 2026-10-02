import type { PenetranceRecord } from "./types";

export interface Locus {
  chr: string;
  pos: number;
  ref?: string;
  alt?: string;
}

const ALLELE = "[ACGT]+|-";

/**
 * Pulls a genomic locus out of strings like "chr13:g.32340300G>T", "13:32340300"
 * or "13-32340300-GT-G". "-" marks an empty allele (VEP-style indels).
 * Returns undefined when the text is not a locus.
 */
export function parseLocus(text: string | undefined): Locus | undefined {
  if (!text) return undefined;
  const t = text.trim();
  const hgvs = new RegExp(`^(?:chr)?([0-9]{1,2}|X|Y|MT?):g\\.(\\d+)(?:(${ALLELE})>(${ALLELE}))?$`, "i").exec(t);
  if (hgvs) return { chr: hgvs[1].toUpperCase(), pos: Number(hgvs[2]), ref: hgvs[3]?.toUpperCase(), alt: hgvs[4]?.toUpperCase() };
  const plain = new RegExp(`^(?:chr)?([0-9]{1,2}|X|Y|MT?)[:\\-\\s](\\d+)(?:[:\\-\\s](${ALLELE})[:\\-\\s>](${ALLELE}))?$`, "i").exec(t);
  if (plain) return { chr: plain[1].toUpperCase(), pos: Number(plain[2]), ref: plain[3]?.toUpperCase(), alt: plain[4]?.toUpperCase() };
  return undefined;
}

/**
 * Does a record (VCF-style, indels anchored on a padding base) sit at a locus?
 * VEP-style deletions ("T>-") and insertions ("->A") drop the anchor base, so
 * they are compared after trimming it.
 */
function atLocus(r: PenetranceRecord, l: Locus): boolean {
  if (r.chr.toUpperCase() !== l.chr) return false;
  const ref = r.ref.toUpperCase();
  const alt = r.alt.toUpperCase();
  if (l.alt === "-" || l.ref === "-") {
    if (l.alt === "-" && ref.length > alt.length && ref.startsWith(alt)) {
      return r.pos + alt.length === l.pos && (!l.ref || ref.slice(alt.length) === l.ref);
    }
    if (l.ref === "-" && alt.length > ref.length && alt.startsWith(ref)) {
      return r.pos + ref.length === l.pos && (!l.alt || alt.slice(ref.length) === l.alt);
    }
    return false;
  }
  return r.pos === l.pos && (!l.ref || ref === l.ref) && (!l.alt || alt === l.alt);
}

/**
 * Records for a variant, matched by rsID first and by (GRCh38) locus otherwise.
 * When both are known, a multi-allelic rsID is narrowed to the searched allele.
 */
export function findRecords(
  records: PenetranceRecord[],
  keys: { rsid?: string; locus?: Locus },
): { matches: PenetranceRecord[]; by?: "rsid" | "locus" } {
  const rsid = keys.rsid?.toLowerCase();
  if (rsid) {
    const hit = records.filter((r) => r.rsid?.toLowerCase() === rsid);
    if (hit.length > 0) {
      const narrowed = keys.locus?.ref && keys.locus.alt ? hit.filter((r) => atLocus(r, keys.locus!)) : [];
      return { matches: narrowed.length > 0 ? narrowed : hit, by: "rsid" };
    }
  }
  if (keys.locus) {
    const hit = records.filter((r) => atLocus(r, keys.locus!));
    if (hit.length > 0) return { matches: hit, by: "locus" };
  }
  return { matches: [] };
}
