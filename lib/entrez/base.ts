/**
 * Shared NCBI E-utilities helpers — used by PubMed and ClinVar clients.
 */

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export interface EntrezConfig {
  apiKey?: string;
  email?: string;
  tool?: string;
}

export interface EntrezDiagnostics {
  phraseCount: number;
  failedPhraseCount: number;
  rateLimitedPhraseCount: number;
  summaryBatchCount: number;
  failedSummaryBatchCount: number;
  rateLimitedSummaryBatchCount: number;
  likelyPartial: boolean;
  likelyRateLimited: boolean;
}

export interface SearchPhrasesResult {
  matched: Map<string, Set<string>>;
  diagnostics: EntrezDiagnostics;
}

export interface EsummaryBatchResult<T> {
  summaries: Map<string, T>;
  diagnostics: Pick<EntrezDiagnostics, "summaryBatchCount" | "failedSummaryBatchCount" | "rateLimitedSummaryBatchCount">;
}

export function baseParams(cfg: EntrezConfig): URLSearchParams {
  const params = new URLSearchParams();
  params.set("tool", cfg.tool ?? "varcrawl");
  if (cfg.email) params.set("email", cfg.email);
  if (cfg.apiKey) params.set("api_key", cfg.apiKey);
  return params;
}

/** Minimum delay between Entrez calls — 10 req/s with key, 3 req/s without. */
export function delayMs(cfg: EntrezConfig): number {
  return cfg.apiKey ? 110 : 350;
}

async function timedFetch(url: string): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        await sleep(300 * Math.pow(2, attempt - 1));
        continue;
      }
      return new Response(
        JSON.stringify({ error: "network_fetch_failed" }),
        {
          status: 599,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (res.ok) return res;
    const retriable = res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;
    if (!retriable || attempt === maxAttempts) return res;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 300 * Math.pow(2, attempt - 1);
    await sleep(waitMs);
  }

  return new Response(
    JSON.stringify({ error: "network_fetch_failed", detail: String(lastError ?? "unknown") }),
    {
      status: 599,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function isRateLimitStatus(status: number): boolean {
  return status === 429;
}

function emptyDiagnostics(): EntrezDiagnostics {
  return {
    phraseCount: 0,
    failedPhraseCount: 0,
    rateLimitedPhraseCount: 0,
    summaryBatchCount: 0,
    failedSummaryBatchCount: 0,
    rateLimitedSummaryBatchCount: 0,
    likelyPartial: false,
    likelyRateLimited: false,
  };
}

function finalizeDiagnostics(d: EntrezDiagnostics): EntrezDiagnostics {
  const likelyPartial = d.failedPhraseCount > 0 || d.failedSummaryBatchCount > 0;
  const likelyRateLimited = d.rateLimitedPhraseCount > 0 || d.rateLimitedSummaryBatchCount > 0;
  return {
    ...d,
    likelyPartial,
    likelyRateLimited,
  };
}

interface EsearchPhraseResult {
  ids: string[];
  ok: boolean;
  status: number;
  rateLimited: boolean;
}

async function esearchPhraseWithStatus(
  db: string,
  phrase: string,
  cfg: EntrezConfig,
  retmax = 200,
): Promise<EsearchPhraseResult> {
  const params = baseParams(cfg);
  params.set("db", db);
  params.set("term", `"${phrase.replace(/"/g, "")}"[All Fields]`);
  params.set("retmode", "json");
  params.set("retmax", String(retmax));
  const url = `${EUTILS}/esearch.fcgi?${params.toString()}`;
  const res = await timedFetch(url);
  if (!res.ok) {
    return {
      ids: [],
      ok: false,
      status: res.status,
      rateLimited: isRateLimitStatus(res.status),
    };
  }
  const data = (await res.json()) as {
    esearchresult?: { idlist?: string[] };
  };
  return {
    ids: data.esearchresult?.idlist ?? [],
    ok: true,
    status: res.status,
    rateLimited: false,
  };
}

/** esearch for an exact phrase in a single DB. Returns a list of UIDs. */
export async function esearchPhrase(
  db: string,
  phrase: string,
  cfg: EntrezConfig,
  retmax = 200,
): Promise<string[]> {
  const res = await esearchPhraseWithStatus(db, phrase, cfg, retmax);
  return res.ids;
}

/**
 * esearch with a caller-built term string (no quoting or field wrapping added).
 * Use this for structured queries like `BRAF[gene] AND (V600E OR Val600Glu)`
 * that the plain-phrase path can't express.
 */
export async function esearchTermWithStatus(
  db: string,
  term: string,
  cfg: EntrezConfig,
  retmax = 200,
): Promise<EsearchPhraseResult> {
  const params = baseParams(cfg);
  params.set("db", db);
  params.set("term", term);
  params.set("retmode", "json");
  params.set("retmax", String(retmax));
  const url = `${EUTILS}/esearch.fcgi?${params.toString()}`;
  const res = await timedFetch(url);
  if (!res.ok) {
    return {
      ids: [],
      ok: false,
      status: res.status,
      rateLimited: isRateLimitStatus(res.status),
    };
  }
  const data = (await res.json()) as {
    esearchresult?: { idlist?: string[] };
  };
  return {
    ids: data.esearchresult?.idlist ?? [],
    ok: true,
    status: res.status,
    rateLimited: false,
  };
}

/** esummary for a batch of UIDs. Returns the raw `result` map minus the `uids` array. */
export async function esummaryBatch<T>(
  db: string,
  uids: string[],
  cfg: EntrezConfig,
): Promise<Map<string, T>> {
  const res = await esummaryBatchWithDiagnostics<T>(db, uids, cfg);
  return res.summaries;
}

export async function esummaryBatchWithDiagnostics<T>(
  db: string,
  uids: string[],
  cfg: EntrezConfig,
): Promise<EsummaryBatchResult<T>> {
  const out = new Map<string, T>();
  let summaryBatchCount = 0;
  let failedSummaryBatchCount = 0;
  let rateLimitedSummaryBatchCount = 0;
  const chunkSize = 200;
  const d = delayMs(cfg);
  for (let i = 0; i < uids.length; i += chunkSize) {
    summaryBatchCount += 1;
    const chunk = uids.slice(i, i + chunkSize);
    const params = baseParams(cfg);
    params.set("db", db);
    params.set("id", chunk.join(","));
    params.set("retmode", "json");
    const url = `${EUTILS}/esummary.fcgi?${params.toString()}`;
    if (i > 0) await new Promise((r) => setTimeout(r, d));
    const res = await timedFetch(url);
    if (!res.ok) {
      failedSummaryBatchCount += 1;
      if (isRateLimitStatus(res.status)) rateLimitedSummaryBatchCount += 1;
      continue;
    }
    const data = (await res.json()) as { result?: Record<string, T | string[]> };
    if (!data.result) continue;
    for (const [k, v] of Object.entries(data.result)) {
      if (k === "uids") continue;
      if (Array.isArray(v)) continue;
      out.set(k, v as T);
    }
  }
  return {
    summaries: out,
    diagnostics: {
      summaryBatchCount,
      failedSummaryBatchCount,
      rateLimitedSummaryBatchCount,
    },
  };
}

/**
 * Run one esearch per input phrase, serialized with rate-limit delay.
 * Returns a map of UID → set of phrases that matched.
 */
export async function searchPhrasesInDb(
  db: string,
  phrases: string[],
  cfg: EntrezConfig,
): Promise<Map<string, Set<string>>> {
  const res = await searchPhrasesInDbWithDiagnostics(db, phrases, cfg);
  return res.matched;
}

export async function searchPhrasesInDbWithDiagnostics(
  db: string,
  phrases: string[],
  cfg: EntrezConfig,
): Promise<SearchPhrasesResult> {
  const matched: Map<string, Set<string>> = new Map();
  const diag = emptyDiagnostics();
  diag.phraseCount = phrases.length;
  const d = delayMs(cfg);
  for (let i = 0; i < phrases.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, d));
    const res = await esearchPhraseWithStatus(db, phrases[i], cfg);
    if (!res.ok) {
      diag.failedPhraseCount += 1;
      if (res.rateLimited) diag.rateLimitedPhraseCount += 1;
    }
    for (const id of res.ids) {
      if (!matched.has(id)) matched.set(id, new Set());
      matched.get(id)!.add(phrases[i]);
    }
  }
  return {
    matched,
    diagnostics: finalizeDiagnostics(diag),
  };
}
