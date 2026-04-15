import { CanonicalVariant, Consequence } from "./types";

/**
 * Produce every string representation a mutation is likely to appear as in
 * literature. We want high-recall for PubMed phrase matching — each returned
 * string will be run as `"string"[All Fields]`.
 *
 * Grouped by source so the UI can explain *where* each representation comes
 * from (per transcript / isoform, plus a "universal" group for
 * transcript-independent forms like rsIDs and HGVSg).
 */
export interface VariantString {
  text: string;
  label: string; // short description, e.g. "HGVSp short"
}

export interface TranscriptGroup {
  // Identifier fields — at least one of these will be set
  gene?: string;
  transcript?: string;         // NM_004333.6
  proteinAccession?: string;   // NP_004324.2
  hgvsc?: string;              // NM_004333.6:c.1799T>A
  hgvsp?: string;              // NP_004324.2:p.Val600Glu
  consequenceTerms?: string[]; // e.g. ["missense_variant"]
  variants: VariantString[];
}

export interface VariantGroups {
  // Transcript-independent: rsID, HGVSg — appear only once no matter how many transcripts
  universal: VariantString[];
  // One group per transcript/isoform
  perTranscript: TranscriptGroup[];
  // Raw-input fallback when nothing else was resolvable
  fallback: VariantString[];
}

export function enumerateGrouped(v: CanonicalVariant): VariantGroups {
  const seen = new Set<string>();
  const universal: VariantString[] = [];
  const perTranscript: TranscriptGroup[] = [];
  const fallback: VariantString[] = [];

  const dedupe = (bucket: VariantString[], text: string | undefined | null, label: string) => {
    if (!text) return;
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    bucket.push({ text: trimmed, label });
  };

  // --- Universal (transcript-independent) ---
  if (v.rsid) dedupe(universal, v.rsid, "dbSNP rsID");
  if (v.chrom && v.genomicPos && v.refAllele && v.altAllele) {
    const g = `g.${v.genomicPos}${v.refAllele}>${v.altAllele}`;
    dedupe(universal, `chr${v.chrom}:${g}`, `HGVSg (${v.assembly}, chr-prefix)`);
    dedupe(universal, `${v.chrom}:${g}`, `HGVSg (${v.assembly}, no prefix)`);
  }
  if (v.hgvsg) dedupe(universal, v.hgvsg, `HGVSg (${v.assembly})`);

  // --- Per-transcript consequences ---
  for (const c of v.consequences) {
    const group: TranscriptGroup = {
      gene: c.gene,
      transcript: c.transcript,
      proteinAccession: c.proteinAccession,
      hgvsc: c.hgvsc,
      hgvsp: c.hgvsp,
      consequenceTerms: c.consequenceTerms,
      variants: [],
    };
    enumerateConsequence(c, group.variants, dedupe);
    if (group.variants.length > 0) perTranscript.push(group);
  }

  // --- Fallback ---
  if (universal.length === 0 && perTranscript.length === 0) {
    dedupe(fallback, v.input.raw, "raw input");
    if (v.input.proteinShort) dedupe(fallback, v.input.proteinShort, "short (parsed)");
    if (v.input.proteinLong) dedupe(fallback, v.input.proteinLong, "p.3-letter (parsed)");
  }

  return { universal, perTranscript, fallback };
}

function enumerateConsequence(
  c: Consequence,
  bucket: VariantString[],
  dedupe: (bucket: VariantString[], text: string | undefined | null, label: string) => void,
) {
  // HGVSc — with and without transcript prefix, gene-prefixed
  if (c.hgvsc) {
    dedupe(bucket, c.hgvsc, "HGVSc (with transcript)");
    const bare = stripAccession(c.hgvsc);
    if (bare) dedupe(bucket, bare, "HGVSc (bare)");
    if (c.gene && bare) dedupe(bucket, `${c.gene}:${bare}`, "HGVSc (gene-prefixed)");
    if (c.gene && bare) dedupe(bucket, `${c.gene} ${bare}`, "HGVSc (gene space)");
  }

  // HGVSp — with and without transcript prefix, 3-letter forms
  if (c.hgvsp) {
    dedupe(bucket, c.hgvsp, "HGVSp (with transcript)");
    const bare = stripAccession(c.hgvsp);
    if (bare) dedupe(bucket, bare, "HGVSp (bare 3-letter)");
    if (c.gene && bare) dedupe(bucket, `${c.gene}:${bare}`, "HGVSp (gene-prefixed)");
    if (c.gene && bare) dedupe(bucket, `${c.gene} ${bare}`, "HGVSp (gene space)");
  }
  if (c.proteinLong) {
    dedupe(bucket, c.proteinLong, "p.3-letter");
    dedupe(bucket, c.proteinLong.replace(/^p\./, ""), "3-letter bare");
    dedupe(bucket, `p.(${c.proteinLong.replace(/^p\./, "")})`, "p. paren 3-letter");
    if (c.gene) dedupe(bucket, `${c.gene} ${c.proteinLong}`, "gene + p.3-letter");
    if (c.gene) dedupe(bucket, `${c.gene}:${c.proteinLong}`, "gene:p.3-letter");
  }

  // HGVSp — 1-letter forms
  if (c.proteinShort) {
    dedupe(bucket, `p.${c.proteinShort}`, "p.1-letter");
    dedupe(bucket, c.proteinShort, "1-letter bare");
    if (c.gene) dedupe(bucket, `${c.gene} ${c.proteinShort}`, "gene + 1-letter");
    if (c.gene) dedupe(bucket, `${c.gene} p.${c.proteinShort}`, "gene + p.1-letter");
    if (c.gene) dedupe(bucket, `${c.gene}:p.${c.proteinShort}`, "gene:p.1-letter");
  }
}

function stripAccession(hgvs: string): string | null {
  const idx = hgvs.indexOf(":");
  if (idx < 0) return null;
  return hgvs.slice(idx + 1);
}

/** Flatten grouped variants into a single deduplicated array for PubMed search. */
export function flattenVariants(groups: VariantGroups): VariantString[] {
  const seen = new Set<string>();
  const out: VariantString[] = [];
  const push = (v: VariantString) => {
    if (seen.has(v.text)) return;
    seen.add(v.text);
    out.push(v);
  };
  groups.universal.forEach(push);
  for (const g of groups.perTranscript) g.variants.forEach(push);
  groups.fallback.forEach(push);
  return out;
}

/**
 * Backwards-compatible flat enumeration (used by existing callers/tests).
 */
export function enumerateVariantStrings(v: CanonicalVariant): VariantString[] {
  return flattenVariants(enumerateGrouped(v));
}
