/**
 * PubMed search via NCBI Entrez E-utilities.
 *
 * Strategy:
 *   - One esearch per variant string (as an exact phrase with [All Fields])
 *     so we can attribute which string(s) matched each PMID.
 *   - Then one batched esummary for all unique PMIDs (chunks of 200 IDs).
 */

import {
  EntrezConfig,
  EntrezDiagnostics,
  esummaryBatchWithDiagnostics,
  searchPhrasesInDbWithDiagnostics,
} from "@/lib/entrez/base";

export type { EntrezConfig };

export interface PubmedArticle {
  pmid: string;
  title: string;
  authors: string[];
  journal: string;
  pubDate: string;
  doi?: string;
  matchedBy: string[];
}

export interface PubmedSearchResult {
  articles: PubmedArticle[];
  diagnostics: EntrezDiagnostics;
}

interface EsummaryDocsum {
  uid: string;
  title?: string;
  authors?: { name: string }[];
  fulljournalname?: string;
  source?: string;
  pubdate?: string;
  elocationid?: string;
  articleids?: { idtype: string; value: string }[];
}

export async function searchPubmedForVariants(
  variants: string[],
  cfg: EntrezConfig,
): Promise<PubmedArticle[]> {
  const res = await searchPubmedForVariantsDetailed(variants, cfg);
  return res.articles;
}

export async function searchPubmedForVariantsDetailed(
  variants: string[],
  cfg: EntrezConfig,
): Promise<PubmedSearchResult> {
  const phraseRes = await searchPhrasesInDbWithDiagnostics("pubmed", variants, cfg);
  const matched = phraseRes.matched;
  const allIds = Array.from(matched.keys());
  if (allIds.length === 0) {
    return {
      articles: [],
      diagnostics: phraseRes.diagnostics,
    };
  }
  const summaryRes = await esummaryBatchWithDiagnostics<EsummaryDocsum>("pubmed", allIds, cfg);
  const summaries = summaryRes.summaries;

  const articles: PubmedArticle[] = [];
  for (const [pmid, matchedSet] of matched) {
    const s = summaries.get(pmid);
    if (!s) {
      articles.push({
        pmid,
        title: "(metadata unavailable)",
        authors: [],
        journal: "",
        pubDate: "",
        matchedBy: Array.from(matchedSet),
      });
      continue;
    }
    const doi = s.articleids?.find((a) => a.idtype === "doi")?.value;
    articles.push({
      pmid,
      title: s.title ?? "",
      authors: (s.authors ?? []).map((a) => a.name).slice(0, 10),
      journal: s.fulljournalname || s.source || "",
      pubDate: s.pubdate ?? "",
      doi,
      matchedBy: Array.from(matchedSet),
    });
  }
  // Best-match first: articles matching more variant representations rank higher.
  // Recency is a tiebreaker.
  articles.sort((a, b) => {
    const byMatchCount = b.matchedBy.length - a.matchedBy.length;
    if (byMatchCount !== 0) return byMatchCount;
    return (b.pubDate || "").localeCompare(a.pubDate || "");
  });
  return {
    articles,
    diagnostics: {
      ...phraseRes.diagnostics,
      summaryBatchCount: summaryRes.diagnostics.summaryBatchCount,
      failedSummaryBatchCount: summaryRes.diagnostics.failedSummaryBatchCount,
      rateLimitedSummaryBatchCount: summaryRes.diagnostics.rateLimitedSummaryBatchCount,
      likelyPartial:
        phraseRes.diagnostics.failedPhraseCount > 0 ||
        summaryRes.diagnostics.failedSummaryBatchCount > 0,
      likelyRateLimited:
        phraseRes.diagnostics.rateLimitedPhraseCount > 0 ||
        summaryRes.diagnostics.rateLimitedSummaryBatchCount > 0,
    },
  };
}
