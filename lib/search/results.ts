/**
 * Result assembly shared by the search routes: publication-date ranking,
 * cross-source article merging, and upstream status reporting.
 *
 * `pubDateRank` / `monthFromName` previously existed in two copies (the PubMed
 * client and the PubMed route) that had to be kept in sync to sort correctly.
 */

export interface SourceStatus {
  complete: boolean;
  likelyRateLimited: boolean;
  likelyPartial: boolean;
  message?: string;
}

export interface Article {
  pmid: string;
  title: string;
  authors: string[];
  journal: string;
  pubDate: string;
  doi?: string;
  matchedBy: string[];
  sources?: string[];
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function monthFromName(mon?: string): number {
  if (!mon) return 0;
  return MONTHS[mon.slice(0, 3).toLowerCase()] ?? 0;
}

/**
 * Sortable timestamp for a publication date. PubMed emits "YYYY Mon DD" (month
 * and day optional); Europe PMC emits ISO dates. Unparseable values sort last.
 *
 * ISO is matched first and explicitly. The PubMed pattern's month group needs
 * leading whitespace, so it matches only the leading year of "2023-12-15" and
 * would otherwise silently round every Europe PMC date down to 1 January,
 * ranking an article published in December below one from that February.
 */
export function pubDateRank(pubDate?: string): number {
  const s = pubDate?.trim();
  if (!s) return 0;

  // ISO: 2023-12-15, 2023-12
  const iso = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) {
    return Date.UTC(
      Number(iso[1]),
      Math.min(11, Math.max(0, Number(iso[2]) - 1)),
      iso[3] ? Number(iso[3]) : 1,
    );
  }

  // PubMed: "2023 Jun 15", "2023 Jun", "2023"
  const pubmed = s.match(/^(\d{4})(?:\s+([A-Za-z]{3,9})(?:\s+(\d{1,2}))?)?/);
  if (pubmed) {
    return Date.UTC(
      Number(pubmed[1]),
      monthFromName(pubmed[2]),
      pubmed[3] ? Number(pubmed[3]) : 1,
    );
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Best match first: an article mentioning more of the variant's representations
 * is more likely to be about that variant. Recency breaks ties.
 */
export function compareArticles(a: Article, b: Article): number {
  const byMatchCount = b.matchedBy.length - a.matchedBy.length;
  if (byMatchCount !== 0) return byMatchCount;
  return pubDateRank(b.pubDate) - pubDateRank(a.pubDate);
}

function withSource(a: Article, source: string): Article {
  return { ...a, sources: Array.from(new Set([...(a.sources ?? []), source])) };
}

/**
 * Union PubMed and Europe PMC by PMID, keeping PubMed's metadata where both
 * have it and filling gaps from Europe PMC. `matchedBy` and `sources` are
 * unioned so attribution survives the merge.
 */
export function mergeArticles(pubmed: Article[], europePmc: Article[]): Article[] {
  const byPmid = new Map<string, Article>();

  for (const a of pubmed) byPmid.set(a.pmid, withSource(a, "PubMed"));

  for (const ep of europePmc) {
    const existing = byPmid.get(ep.pmid);
    if (!existing) {
      byPmid.set(ep.pmid, withSource(ep, "Europe PMC"));
      continue;
    }
    byPmid.set(ep.pmid, {
      ...existing,
      title: existing.title || ep.title,
      authors: existing.authors.length > 0 ? existing.authors : ep.authors,
      journal: existing.journal || ep.journal,
      pubDate: existing.pubDate || ep.pubDate,
      doi: existing.doi || ep.doi,
      matchedBy: Array.from(new Set([...(existing.matchedBy ?? []), ...(ep.matchedBy ?? [])])),
      sources: Array.from(
        new Set([...(existing.sources ?? []), ...(ep.sources ?? []), "Europe PMC"]),
      ),
    });
  }

  return Array.from(byPmid.values()).sort(compareArticles);
}

/**
 * Translate upstream diagnostics into the status the UI shows. `complete:false`
 * marks results a reader should not treat as an exhaustive search.
 */
export function buildStatusFromDiagnostics(
  diag: { likelyPartial: boolean; likelyRateLimited: boolean },
  source: "PubMed" | "ClinVar",
): SourceStatus {
  if (diag.likelyRateLimited) {
    return {
      complete: false,
      likelyRateLimited: true,
      likelyPartial: true,
      message: `${source} may be incomplete due to NCBI rate limiting. Please retry shortly.`,
    };
  }
  if (diag.likelyPartial) {
    return {
      complete: false,
      likelyRateLimited: false,
      likelyPartial: true,
      message: `${source} may be incomplete due to temporary upstream errors.`,
    };
  }
  return { complete: true, likelyRateLimited: false, likelyPartial: false };
}

/** Status for a source whose search failed outright rather than partially. */
export function failedSourceStatus(source: "PubMed" | "ClinVar"): SourceStatus {
  return {
    complete: false,
    likelyRateLimited: false,
    likelyPartial: true,
    message: `${source} search failed. The other sources below are unaffected; please retry.`,
  };
}

export function rateLimitedStatus(source: "PubMed" | "ClinVar", retryAfterSec?: number): SourceStatus {
  return {
    complete: false,
    likelyRateLimited: true,
    likelyPartial: true,
    message: retryAfterSec
      ? `${source} request rate-limited. Retry in ${retryAfterSec}s.`
      : `${source} may be incomplete due to NCBI rate limiting. Please retry shortly.`,
  };
}
