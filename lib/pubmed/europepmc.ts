/**
 * Europe PMC search — a second literature index alongside PubMed.
 *
 * Phrases run concurrently under a limiter dedicated to the EBI host (see
 * `lib/entrez/scheduler.ts`); EBI's quota is separate from NCBI's, so the two
 * searches do not compete for the same budget.
 */

import { europePmcLimiter, envNumber, mapWithLimiter } from "@/lib/entrez/scheduler";
import { retryWaitMs } from "@/lib/entrez/base";

export interface EuropePmcDiagnostics {
  phraseCount: number;
  failedPhraseCount: number;
  rateLimitedPhraseCount: number;
  likelyPartial: boolean;
  likelyRateLimited: boolean;
}

export interface EuropePmcArticle {
  pmid: string;
  title: string;
  authors: string[];
  journal: string;
  pubDate: string;
  doi?: string;
  matchedBy: string[];
  sources: string[];
}

export interface EuropePmcSearchResult {
  articles: EuropePmcArticle[];
  diagnostics: EuropePmcDiagnostics;
}

interface EuropePmcHit {
  source?: string;
  id?: string;
  pmid?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  firstPublicationDate?: string;
  pubYear?: string;
  doi?: string;
}

interface EuropePmcResponse {
  resultList?: { result?: EuropePmcHit[] };
}

const EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const REQUEST_TIMEOUT_MS = envNumber("EUROPEPMC_TIMEOUT_MS", 15000);
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FetchOutcome {
  ok: boolean;
  status: number;
  hits: EuropePmcHit[];
}

async function fetchEuropePmc(phrase: string): Promise<FetchOutcome> {
  const maxAttempts = 3;
  const query = `"${phrase.replace(/"/g, "")}" AND SRC:MED`;
  const params = new URLSearchParams({
    query,
    format: "json",
    pageSize: "100",
    // `lite` carries every field we render (pmid, title, authorString,
    // journalTitle, firstPublicationDate, doi). `core` adds abstracts, MeSH
    // terms, grant lists and full-text links we never read — a large payload
    // per hit, multiplied by 100 hits across every phrase.
    resultType: "lite",
  });
  const url = `${EUROPE_PMC}?${params.toString()}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network error or timeout — retry, then give up on this phrase.
      if (attempt < maxAttempts) {
        await sleep(300 * Math.pow(2, attempt - 1));
        continue;
      }
      return { ok: false, status: 599, hits: [] };
    }

    if (res.ok) {
      try {
        const data = (await res.json()) as EuropePmcResponse;
        return { ok: true, status: res.status, hits: data.resultList?.result ?? [] };
      } catch {
        return { ok: false, status: res.status, hits: [] };
      }
    }

    if (!RETRIABLE_STATUS.has(res.status) || attempt === maxAttempts) {
      return { ok: false, status: res.status, hits: [] };
    }
    await sleep(retryWaitMs(res.headers.get("Retry-After"), attempt));
  }

  return { ok: false, status: 599, hits: [] };
}

function toArticle(hit: EuropePmcHit, pmid: string, phrase: string): EuropePmcArticle {
  return {
    pmid,
    title: hit.title?.trim() ?? "",
    authors: (hit.authorString ?? "")
      .split(/,\s*/)
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 10),
    journal: hit.journalTitle?.trim() ?? "",
    pubDate: hit.firstPublicationDate?.trim() ?? hit.pubYear?.trim() ?? "",
    doi: hit.doi?.trim() || undefined,
    matchedBy: [phrase],
    sources: ["Europe PMC"],
  };
}

export async function searchEuropePmcForVariantsDetailed(
  variants: string[],
): Promise<EuropePmcSearchResult> {
  const diagnostics: EuropePmcDiagnostics = {
    phraseCount: variants.length,
    failedPhraseCount: 0,
    rateLimitedPhraseCount: 0,
    likelyPartial: false,
    likelyRateLimited: false,
  };

  const outcomes = await mapWithLimiter(europePmcLimiter(), variants, (phrase) =>
    fetchEuropePmc(phrase),
  );

  // Fold in phrase order, so the article kept for a PMID and the ordering of
  // its `matchedBy` list do not depend on which request returned first.
  const byPmid = new Map<string, { article: EuropePmcArticle; matched: Set<string> }>();
  for (let i = 0; i < outcomes.length; i++) {
    const res = outcomes[i];
    if (!res.ok) {
      diagnostics.failedPhraseCount += 1;
      if (res.status === 429) diagnostics.rateLimitedPhraseCount += 1;
      continue;
    }
    const phrase = variants[i];
    for (const hit of res.hits) {
      const pmid = (hit.pmid ?? (hit.source === "MED" ? hit.id : undefined))?.trim();
      if (!pmid) continue;
      const existing = byPmid.get(pmid);
      if (!existing) {
        byPmid.set(pmid, {
          article: toArticle(hit, pmid, phrase),
          matched: new Set([phrase]),
        });
      } else {
        existing.matched.add(phrase);
      }
    }
  }

  diagnostics.likelyPartial = diagnostics.failedPhraseCount > 0;
  diagnostics.likelyRateLimited = diagnostics.rateLimitedPhraseCount > 0;

  const articles = Array.from(byPmid.values()).map(({ article, matched }) => ({
    ...article,
    matchedBy: Array.from(matched),
  }));

  return { articles, diagnostics };
}
