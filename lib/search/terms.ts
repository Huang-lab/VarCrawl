/**
 * Search-term construction: turn one expanded variant into the phrase lists
 * that go to PubMed/Europe PMC and to ClinVar.
 *
 * This ran in the browser before, which meant the phrase list a search
 * depended on was neither unit-tested nor reusable by the server. It is pure
 * string logic over the expansion result, so it belongs here.
 */

import type { Assembly, ClassifiedInput, CanonicalVariant } from "@/lib/hgvs/types";
import { proteinFormsFor } from "@/lib/clinvar/forms";
import type { VariantGroups, VariantString } from "@/lib/hgvs/enumerate";

export interface ExpansionResult {
  input: string;
  assembly: Assembly;
  classified: ClassifiedInput;
  canonical: CanonicalVariant;
  groups: VariantGroups;
  variants: VariantString[];
}

/** Max phrases sent to one upstream database. Each phrase costs a request. */
export const MAX_SEARCH_TERMS = 50;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary gene match, so KRAS does not match KRASP1. */
export function hasGeneSymbol(term: string, gene?: string): boolean {
  if (!gene) return false;
  return new RegExp(`\\b${escapeRegex(gene)}\\b`, "i").test(term);
}

/**
 * Protein-only or cDNA-only inputs (V600E, c.1799T>A) are ambiguous across
 * genes, so the literature search needs a gene symbol to be meaningful.
 */
export function isProteinOrCdnaOnly(kind: string): boolean {
  return kind === "short" || kind === "hgvsp" || kind === "hgvsc";
}

/** Every enumerated representation, de-duplicated, in group order. */
export function collectVariants(expand: ExpansionResult): string[] {
  const out = new Set<string>();
  const add = (v: VariantString) => {
    const t = v.text?.trim();
    if (t) out.add(t);
  };
  expand.groups.universal.forEach(add);
  for (const group of expand.groups.perTranscript) group.variants.forEach(add);
  expand.groups.fallback.forEach(add);
  return Array.from(out);
}

/**
 * Protein forms for ClinVar's structured query and post-filter: 1-letter and
 * 3-letter, each with and without the `p.` prefix.
 */
export function buildProteinForms(expand: ExpansionResult): string[] {
  const out = new Set<string>();
  const push = (s?: string) => {
    if (s) for (const f of proteinFormsFor(s)) out.add(f);
  };
  push(expand.classified.proteinShort);
  push(expand.classified.proteinLong);
  for (const c of expand.canonical.consequences) {
    push(c.proteinShort);
    push(c.proteinLong);
  }
  return Array.from(out);
}

/** The gene symbol to trust: resolved by VEP if available, else as typed. */
export function resolveGene(expand: ExpansionResult): string | undefined {
  return expand.canonical.gene ?? expand.classified.gene;
}

/** Distinct transcript accessions across the per-transcript groups. */
export function collectTranscripts(expand: ExpansionResult): string[] {
  return Array.from(
    new Set(
      expand.groups.perTranscript
        .map((g) => g.transcript)
        .filter((t): t is string => Boolean(t && t.trim()))
        .map((t) => t.trim()),
    ),
  );
}

/**
 * Rank a phrase by how specific it is to this mutation. Lower is stronger, and
 * the list is truncated to MAX_SEARCH_TERMS, so this decides what survives.
 */
export function rankPubmedTerm(
  term: string,
  ctx: { rawInput: string; gene?: string; transcripts: string[] },
): number {
  const t = term.trim();
  const lower = t.toLowerCase();

  if (lower === ctx.rawInput.trim().toLowerCase()) return 0;
  if (/^rs\d+$/i.test(t)) return 1;
  if (/^(?:chr)?(?:[0-9]{1,2}|x|y|m|mt):g\./i.test(t)) return 1;
  if (/^[A-Z]{2,4}_[0-9]+(?:\.[0-9]+)?:g\./i.test(t)) return 1;
  if (hasGeneSymbol(t, ctx.gene)) return 2;
  if (ctx.transcripts.some((tx) => t.includes(tx))) return 3;
  return 4;
}

/**
 * Build the phrase list for PubMed / Europe PMC.
 *
 * Bare HGVS forms (`c.1799T>A`, `p.V600E`) match thousands of unrelated papers,
 * so gene- and transcript-qualified variants are added, then everything is
 * ranked strongest-first because only the top MAX_SEARCH_TERMS are searched.
 */
export function buildPubmedSearchTerms(expand: ExpansionResult): string[] {
  const baseVariants = collectVariants(expand);
  const gene = resolveGene(expand);
  const transcripts = collectTranscripts(expand);

  // A bare genomic coordinate is already unambiguous; adding context would
  // only dilute the phrase list.
  const coordinateOnly =
    expand.classified.kind === "hgvsg" && !gene && transcripts.length === 0;
  if (coordinateOnly) return Array.from(new Set(baseVariants));

  // Transcript-prefixing only helps for bare HGVS c./p. forms.
  const shouldAddTranscriptContext = (variant: string): boolean =>
    /^c\./i.test(variant) || /^p\./i.test(variant);

  const withContext: string[] = [];
  for (const v of baseVariants) {
    if (gene && !hasGeneSymbol(v, gene)) withContext.push(`${gene} ${v}`);
    const hasTranscript = transcripts.some((t) => v.includes(t));
    if (!hasTranscript && shouldAddTranscriptContext(v)) {
      for (const tx of transcripts.slice(0, 6)) withContext.push(`${tx} ${v}`);
    }
  }

  const merged = Array.from(new Set([...baseVariants, ...withContext]));
  const ranked = merged.sort((a, b) => {
    const ra = rankPubmedTerm(a, { rawInput: expand.input, gene, transcripts });
    const rb = rankPubmedTerm(b, { rawInput: expand.input, gene, transcripts });
    if (ra !== rb) return ra - rb;
    return a.length - b.length;
  });

  // For gene-ambiguous inputs, drop phrases that carry no gene context at all.
  if (isProteinOrCdnaOnly(expand.classified.kind) && gene) {
    const geneOnly = ranked.filter((term) => hasGeneSymbol(term, gene));
    if (geneOnly.length > 0) return geneOnly;
  }

  return ranked;
}

/** Trim, de-duplicate and cap a phrase list before it reaches an upstream API. */
export function normalizeTerms(terms: unknown, limit = MAX_SEARCH_TERMS): string[] {
  if (!Array.isArray(terms)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Whether a literature search can produce a meaningful answer, and why not.
 * A protein- or cDNA-only query with no resolvable gene would match every
 * paper mentioning that codon in any gene.
 */
export function literatureSearchBlockedReason(
  expand: ExpansionResult,
): string | null {
  if (isProteinOrCdnaOnly(expand.classified.kind) && !resolveGene(expand)) {
    return "PubMed/PMC search skipped: amino-acid or cDNA-only queries require a gene symbol (e.g. TP53 R175H, BRCA1 c.68_69delAG).";
  }
  return null;
}
