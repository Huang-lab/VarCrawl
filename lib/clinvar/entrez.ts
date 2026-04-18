/**
 * ClinVar search via NCBI Entrez (db=clinvar).
 *
 * Primary path: one esearch per variant string as an exact phrase, then a batched
 * esummary for metadata (title, clinical significance, conditions).
 *
 * Supplemental path: for rsID variants, elink (dbSNP → ClinVar) + efetch with
 * rettype=vcv gives us the authoritative ClinVar variation records that esearch
 * often fails to surface through text indexing.
 */

import {
  EntrezConfig,
  EntrezDiagnostics,
  baseParams,
  delayMs,
  esearchTermWithStatus,
  esummaryBatchWithDiagnostics,
  searchPhrasesInDbWithDiagnostics,
} from "@/lib/entrez/base";

export interface ClinvarRecord {
  uid: string;
  accession?: string;        // e.g. VCV000013961
  title?: string;            // "NM_004333.6(BRAF):c.1799T>A (p.Val600Glu)"
  gene?: string;
  clinicalSignificance?: string; // "Pathogenic", "Likely benign", etc.
  reviewStatus?: string;     // "criteria provided, multiple submitters"
  lastEvaluated?: string;
  conditions: string[];      // traits from ClinVar
  matchedBy: string[];
}

export interface ClinvarSearchResult {
  records: ClinvarRecord[];
  diagnostics: EntrezDiagnostics;
}

// ClinVar's esummary schema has shifted over time. We accept both the newer
// (germline_classification) and older (clinical_significance) shapes.
interface ClinvarDocsum {
  uid: string;
  accession?: string;
  title?: string;
  genes?: { symbol?: string }[];
  germline_classification?: {
    description?: string;
    review_status?: string;
    last_evaluated?: string;
  };
  clinical_significance?: {
    description?: string;
    review_status?: string;
    last_evaluated?: string;
  };
  trait_set?: { trait_name?: string }[];
  traits?: { trait_name?: string }[];
}

export interface ClinvarSearchOptions {
  /** Gene symbol from the classified input or canonical variant. */
  gene?: string;
  /**
   * Protein forms (1-letter and 3-letter, with/without `p.` prefix) used to
   * construct a structured ClinVar query like `BRAF[gene] AND (V600E OR ...)`.
   * This catches records the plain-phrase esearch misses because ClinVar's
   * All-Fields index doesn't treat "BRAF V600E" as a variant phrase.
   */
  proteinForms?: string[];
}

export async function searchClinvarForVariants(
  variants: string[],
  cfg: EntrezConfig,
  opts?: ClinvarSearchOptions,
): Promise<ClinvarRecord[]> {
  const res = await searchClinvarForVariantsDetailed(variants, cfg, opts);
  return res.records;
}

export async function searchClinvarForVariantsDetailed(
  variants: string[],
  cfg: EntrezConfig,
  opts?: ClinvarSearchOptions,
): Promise<ClinvarSearchResult> {
  /* ── 1. Existing esearch path (unchanged) ── */
  const phraseRes = await searchPhrasesInDbWithDiagnostics("clinvar", variants, cfg);
  const matched = phraseRes.matched;

  /* ── 1b. Targeted gene + protein-form query ──
   * ClinVar's `"phrase"[All Fields]` index doesn't recognize compound strings
   * like "BRAF V600E" (the 1-letter form rarely appears in indexed titles).
   * A structured query `BRAF[gene] AND (V600E OR Val600Glu OR "p.Val600Glu")`
   * mirrors how the ClinVar web UI resolves gene+variant queries and reliably
   * returns records such as VCV000013961. Best-effort — failures are ignored.
   */
  if (opts?.gene && opts.proteinForms && opts.proteinForms.length > 0) {
    const term = buildGeneProteinQuery(opts.gene, opts.proteinForms);
    if (term) {
      await new Promise((r) => setTimeout(r, delayMs(cfg)));
      const res = await esearchTermWithStatus("clinvar", term, cfg);
      if (res.ok) {
        const tag = `${opts.gene} ${shortestProteinForm(opts.proteinForms)}`;
        for (const id of res.ids) {
          if (!matched.has(id)) matched.set(id, new Set());
          matched.get(id)!.add(tag);
        }
      }
    }
  }

  const allIds = Array.from(matched.keys());

  let records: ClinvarRecord[] = [];
  let summaryDiag = { summaryBatchCount: 0, failedSummaryBatchCount: 0, rateLimitedSummaryBatchCount: 0 };

  if (allIds.length > 0) {
    const summaryRes = await esummaryBatchWithDiagnostics<ClinvarDocsum>("clinvar", allIds, cfg);
    summaryDiag = summaryRes.diagnostics;
    const summaries = summaryRes.summaries;

    for (const [uid, matchedSet] of matched) {
      const s = summaries.get(uid);
      const clin = s?.germline_classification ?? s?.clinical_significance;
      const conditions = normalizeConditionStrings(
        (s?.trait_set ?? s?.traits ?? [])
          .map((t) => t.trait_name)
          .filter((t): t is string => !!t),
      );
      records.push({
        uid,
        accession: s?.accession,
        title: s?.title,
        gene: s?.genes?.[0]?.symbol,
        clinicalSignificance: clin?.description,
        reviewStatus: clin?.review_status,
        lastEvaluated: clin?.last_evaluated,
        conditions,
        matchedBy: Array.from(matchedSet),
      });
    }
  }

  /* ── 2. Supplemental elink path for rsID variants ── */
  const rsIds: { variant: string; rsNum: number }[] = [];
  for (const v of variants) {
    const m = v.match(/^rs(\d+)$/i);
    if (m) rsIds.push({ variant: v, rsNum: Number(m[1]) });
  }
  if (rsIds.length > 0) {
    try {
      const supplemental = await elinkClinvarRecords(rsIds, cfg);
      const existingAccessions = new Set(
        records.map((r) => r.accession).filter(Boolean),
      );
      for (const rec of supplemental) {
        if (rec.accession && !existingAccessions.has(rec.accession)) {
          records.push(rec);
          existingAccessions.add(rec.accession);
        }
      }
    } catch {
      // Supplemental lookup is best-effort; swallow errors
    }
  }

  /* ── 3. Sort by clinical significance ── */
  const sigRank = (s?: string): number => {
    const x = (s ?? "").toLowerCase();
    if (x.includes("pathogenic") && !x.includes("likely") && !x.includes("benign")) return 0;
    if (x.includes("likely pathogenic")) return 1;
    if (x.includes("uncertain") || x.includes("conflicting")) return 2;
    if (x.includes("likely benign")) return 3;
    if (x.includes("benign")) return 4;
    return 5;
  };
  records.sort((a, b) => sigRank(a.clinicalSignificance) - sigRank(b.clinicalSignificance));
  return {
    records,
    diagnostics: {
      ...phraseRes.diagnostics,
      summaryBatchCount: summaryDiag.summaryBatchCount,
      failedSummaryBatchCount: summaryDiag.failedSummaryBatchCount,
      rateLimitedSummaryBatchCount: summaryDiag.rateLimitedSummaryBatchCount,
      likelyPartial:
        phraseRes.diagnostics.failedPhraseCount > 0 ||
        summaryDiag.failedSummaryBatchCount > 0,
      likelyRateLimited:
        phraseRes.diagnostics.rateLimitedPhraseCount > 0 ||
        summaryDiag.rateLimitedSummaryBatchCount > 0,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Supplemental ClinVar lookup via dbSNP elink + VCV efetch
 *
 * ClinVar's esearch text index often fails to surface records for well-known
 * variants (e.g. BRAF V600E / VCV000013961). The elink path from dbSNP is
 * more reliable: elink(dbfrom=snp → db=clinvar) returns variation IDs, and
 * efetch(rettype=vcv, is_variationid) returns full VCV XML with metadata.
 * ──────────────────────────────────────────────────────────────────────────── */

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

async function elinkClinvarRecords(
  rsIds: { variant: string; rsNum: number }[],
  cfg: EntrezConfig,
): Promise<ClinvarRecord[]> {
  const d = delayMs(cfg);

  // 1. elink: dbSNP → ClinVar (one call per rsID to track matchedBy)
  const varIdToRsVariant = new Map<number, string>();
  for (const { variant, rsNum } of rsIds) {
    const params = baseParams(cfg);
    params.set("dbfrom", "snp");
    params.set("db", "clinvar");
    params.set("id", String(rsNum));
    params.set("retmode", "xml");
    const url = `${EUTILS}/elink.fcgi?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const xml = await res.text();
    // Extract <Id> elements inside <LinkSetDb> (they are variation IDs)
    const lsdb = xml.match(/<LinkSetDb>[\s\S]*?<\/LinkSetDb>/g);
    if (lsdb) {
      for (const block of lsdb) {
        for (const m of block.matchAll(/<Id>(\d+)<\/Id>/g)) {
          varIdToRsVariant.set(Number(m[1]), variant);
        }
      }
    }
    await new Promise((r) => setTimeout(r, d));
  }

  if (varIdToRsVariant.size === 0) return [];

  // 2. efetch: get VCV XML for all variation IDs in one call
  const variationIds = Array.from(varIdToRsVariant.keys());
  const params = baseParams(cfg);
  params.set("db", "clinvar");
  params.set("rettype", "vcv");
  params.set("id", variationIds.join(","));
  // is_variationid is a flag (no value) telling ClinVar the IDs are variation IDs
  const url = `${EUTILS}/efetch.fcgi?${params.toString()}&is_variationid`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const xml = await res.text();

  // 3. Parse each <VariationArchive> element
  return parseVcvXml(xml, varIdToRsVariant);
}

/** Parse ClinVar VCV XML into ClinvarRecord objects. */
function parseVcvXml(
  xml: string,
  varIdToRsVariant: Map<number, string>,
): ClinvarRecord[] {
  const records: ClinvarRecord[] = [];
  // Each <VariationArchive ...>...</VariationArchive> is one record
  const archiveBlocks = xml.match(
    /<VariationArchive\b[^>]*>[\s\S]*?<\/VariationArchive>/g,
  );
  if (!archiveBlocks) return records;

  for (const block of archiveBlocks) {
    const variationId = attr(block, "VariationArchive", "VariationID");
    const accession = attr(block, "VariationArchive", "Accession");
    const title = decodeXmlEntities(
      attr(block, "VariationArchive", "VariationName") ?? "",
    ) || undefined;

    // Gene symbol from <Gene Symbol="...">
    const gene = attr(block, "Gene", "Symbol");

    // Aggregated classification lives in <Classifications> (not <RCVClassifications>).
    // We strip all <RCVClassifications> blocks first so our regex hits the
    // top-level <Classifications> section.
    const stripped = block.replace(
      /<RCVClassifications>[\s\S]*?<\/RCVClassifications>/g,
      "",
    );
    const clsBlock =
      stripped.match(/<GermlineClassification\b[^>]*>[\s\S]*?<\/GermlineClassification>/) ??
      stripped.match(/<ClinicalSignificance\b[^>]*>[\s\S]*?<\/ClinicalSignificance>/);

    let clinicalSignificance: string | undefined;
    let reviewStatus: string | undefined;
    let lastEvaluated: string | undefined;
    if (clsBlock) {
      const cb = clsBlock[0];
      // ReviewStatus and Description are CHILD ELEMENTS, not attributes
      const rsM = cb.match(/<ReviewStatus[^>]*>([\s\S]*?)<\/ReviewStatus>/);
      if (rsM) reviewStatus = decodeXmlEntities(rsM[1].trim());
      const descM = cb.match(/<Description[^>]*>([\s\S]*?)<\/Description>/);
      if (descM) clinicalSignificance = decodeXmlEntities(descM[1].trim());
      // DateLastEvaluated is an attribute on <GermlineClassification> or <Description>
      lastEvaluated =
        attr(cb, "GermlineClassification", "DateLastEvaluated") ??
        attr(cb, "ClinicalSignificance", "DateLastEvaluated") ??
        attr(cb, "Description", "DateLastEvaluated");
    }

    // Conditions: try TraitName attr, ClassifiedCondition elements, then ElementValue
    const conditions: string[] = [];
    for (const tm of block.matchAll(/TraitName="([^"]+)"/g)) {
      const name = decodeXmlEntities(tm[1].trim());
      if (name && !conditions.includes(name)) conditions.push(name);
    }
    if (conditions.length === 0) {
      for (const cc of block.matchAll(
        /<ClassifiedCondition[^>]*>([\s\S]*?)<\/ClassifiedCondition>/g,
      )) {
        const name = decodeXmlEntities(cc[1].trim());
        if (name && !conditions.includes(name)) conditions.push(name);
      }
    }
    if (conditions.length === 0) {
      for (const ev of block.matchAll(
        /<ElementValue\s+Type="Preferred"[^>]*>([\s\S]*?)<\/ElementValue>/g,
      )) {
        const name = decodeXmlEntities(ev[1].trim());
        if (name && !conditions.includes(name)) conditions.push(name);
      }
    }

    const varId = variationId ? Number(variationId) : undefined;
    const matchedVariant = varId ? varIdToRsVariant.get(varId) : undefined;

    records.push({
      uid: variationId ?? "",
      accession,
      title,
      gene,
      clinicalSignificance,
      reviewStatus,
      lastEvaluated,
      conditions: normalizeConditionStrings(conditions),
      matchedBy: matchedVariant ? [matchedVariant] : [],
    });
  }

  return records;
}

/** Extract an XML attribute value from the first occurrence of a tag. */
function attr(
  xml: string,
  tag: string,
  attribute: string,
): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${attribute}="([^"]*)"`, "s");
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]) : undefined;
}

/** Decode common XML character entities. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

/**
 * Build a ClinVar esearch term that combines the gene field with any of the
 * accepted protein forms, e.g. `BRAF[gene] AND (V600E OR Val600Glu)`.
 *
 * Forms containing non-word characters (e.g. "p.Val600Glu") are quoted so
 * NCBI's tokenizer keeps them as a single token. Returns an empty string if
 * no usable forms remain.
 */
export function buildGeneProteinQuery(gene: string, proteinForms: string[]): string {
  const g = gene.trim();
  if (!g) return "";
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of proteinForms) {
    if (!raw) continue;
    const f = raw.trim();
    if (!f) continue;
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Quote forms that contain characters the NCBI tokenizer breaks on.
    const token = /^[A-Za-z0-9]+$/.test(f) ? f : `"${f.replace(/"/g, "")}"`;
    terms.push(token);
  }
  if (terms.length === 0) return "";
  return `${g}[gene] AND (${terms.join(" OR ")})`;
}

function shortestProteinForm(forms: string[]): string {
  const usable = forms.filter((f) => f && f.trim().length > 0);
  if (usable.length === 0) return "";
  return [...usable].sort((a, b) => a.length - b.length)[0];
}

function normalizeConditionStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (name: string) => {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };

  for (const raw of values) {
    const decoded = decodeXmlEntities(raw ?? "").trim();
    if (!decoded) continue;

    // If a condition contains serialized XML, extract just text inside
    // <ClassifiedCondition>...</ClassifiedCondition> tags.
    const embedded = Array.from(
      decoded.matchAll(/<ClassifiedCondition\b[^>]*>([\s\S]*?)<\/ClassifiedCondition>/g),
      (m) => m[1],
    );
    if (embedded.length > 0) {
      for (const name of embedded) push(name);
      continue;
    }

    // Otherwise strip any tags and split semicolon-delimited lists.
    const noTags = decoded.replace(/<[^>]+>/g, " ").trim();
    if (!noTags) continue;
    for (const part of noTags.split(/\s*;\s*/)) push(part);
  }

  return out;
}
