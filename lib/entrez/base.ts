/**
 * Shared NCBI E-utilities helpers — used by PubMed and ClinVar clients.
 *
 * Every outbound call goes through a process-wide token-bucket limiter
 * (`lib/entrez/scheduler.ts`) rather than a hard-coded sleep between serial
 * requests. That keeps us inside NCBI's documented rate while allowing several
 * requests to be in flight, so round-trip latency overlaps instead of
 * accumulating across the ~50 variant representations a search expands into.
 */

import {
  RateLimiter,
  entrezLimiter,
  envNumber,
  mapWithLimiter,
} from "@/lib/entrez/scheduler";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/** Abandon a single upstream call after this long. */
const REQUEST_TIMEOUT_MS = envNumber("ENTREZ_TIMEOUT_MS", 15000);

/**
 * Cap on how long we honour an upstream `Retry-After`.
 *
 * NCBI can answer a 429 with a delay longer than the whole serverless function
 * budget. Sleeping that long guarantees the platform kills the request and the
 * caller gets no body at all, which is worse than returning the partial result
 * with `likelyRateLimited` set.
 */
const MAX_RETRY_WAIT_MS = envNumber("ENTREZ_MAX_RETRY_WAIT_MS", 5000);

export interface EntrezConfig {
  apiKey?: string;
  email?: string;
  tool?: string;
  /**
   * Epoch ms after which phrase searches that have not started are skipped and
   * reported as failed, so a slow query returns partial results before the
   * serverless function limit instead of being killed with no response.
   */
  deadline?: number;
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

/** The limiter governing this credential class. Shared across PubMed + ClinVar. */
export function limiterFor(cfg: EntrezConfig): RateLimiter {
  return entrezLimiter(!!cfg.apiKey);
}

/**
 * Minimum spacing between Entrez calls under the previous serial design.
 * Pacing is now the limiter's job; this remains only because it documents the
 * per-key rate NCBI grants (10 req/s with a key, 3 without).
 */
export function delayMs(cfg: EntrezConfig): number {
  return cfg.apiKey ? 110 : 350;
}

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How long to wait before retrying: the upstream `Retry-After` when it gives
 * one, else exponential backoff — clamped either way so a retry cannot outlast
 * the function budget.
 */
export function retryWaitMs(retryAfterHeader: string | null, attempt: number): number {
  const retryAfter = Number(retryAfterHeader);
  const requested =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 300 * Math.pow(2, attempt - 1);
  return Math.min(requested, MAX_RETRY_WAIT_MS);
}

function networkFailureResponse(detail?: unknown): Response {
  return new Response(
    JSON.stringify({
      error: "network_fetch_failed",
      ...(detail === undefined ? {} : { detail: String(detail) }),
    }),
    { status: 599, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * fetch with bounded retries on transient failures.
 *
 * The caller already holds a rate-limit token and concurrency slot for its
 * first attempt. Each *retry* is an additional request against the same quota,
 * so it waits for its own token via `acquireToken()` before going out —
 * otherwise a burst of retries during an upstream wobble pushes the rate over
 * the limit precisely when NCBI is already unhappy. `acquireToken` deliberately
 * does not take a second concurrency slot, which would deadlock once every
 * slot were held by a retrying request.
 *
 * `Retry-After` is honoured up to MAX_RETRY_WAIT_MS.
 */
async function timedFetch(url: string, limiter?: RateLimiter): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await limiter?.acquireToken();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        await sleep(300 * Math.pow(2, attempt - 1));
        continue;
      }
      return networkFailureResponse(lastError);
    }

    if (res.ok) return res;
    if (!RETRIABLE_STATUS.has(res.status) || attempt === maxAttempts) return res;

    await sleep(retryWaitMs(res.headers.get("Retry-After"), attempt));
  }

  return networkFailureResponse(lastError);
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
  return {
    ...d,
    likelyPartial: d.failedPhraseCount > 0 || d.failedSummaryBatchCount > 0,
    likelyRateLimited: d.rateLimitedPhraseCount > 0 || d.rateLimitedSummaryBatchCount > 0,
  };
}

interface EsearchPhraseResult {
  ids: string[];
  ok: boolean;
  status: number;
  rateLimited: boolean;
}

function failedSearch(status: number): EsearchPhraseResult {
  return { ids: [], ok: false, status, rateLimited: isRateLimitStatus(status) };
}

/** Read an idlist out of an esearch JSON body, tolerating malformed payloads. */
async function readIdList(res: Response): Promise<EsearchPhraseResult> {
  try {
    const data = (await res.json()) as { esearchresult?: { idlist?: string[] } };
    return {
      ids: data.esearchresult?.idlist ?? [],
      ok: true,
      status: res.status,
      rateLimited: false,
    };
  } catch {
    // A 200 with a truncated or non-JSON body is an upstream failure, not an
    // empty result set — surfacing it keeps `likelyPartial` honest.
    return failedSearch(res.status);
  }
}

async function esearchUrl(
  db: string,
  term: string,
  cfg: EntrezConfig,
  retmax: number,
): Promise<EsearchPhraseResult> {
  const params = baseParams(cfg);
  params.set("db", db);
  params.set("term", term);
  params.set("retmode", "json");
  params.set("retmax", String(retmax));
  const url = `${EUTILS}/esearch.fcgi?${params.toString()}`;
  const res = await timedFetch(url, limiterFor(cfg));
  if (!res.ok) return failedSearch(res.status);
  return readIdList(res);
}

function exactPhraseTerm(phrase: string): string {
  return `"${phrase.replace(/"/g, "")}"[All Fields]`;
}

async function esearchPhraseWithStatus(
  db: string,
  phrase: string,
  cfg: EntrezConfig,
  retmax = 200,
): Promise<EsearchPhraseResult> {
  return esearchUrl(db, exactPhraseTerm(phrase), cfg, retmax);
}

/** esearch for an exact phrase in a single DB. Returns a list of UIDs. */
export async function esearchPhrase(
  db: string,
  phrase: string,
  cfg: EntrezConfig,
  retmax = 200,
): Promise<string[]> {
  const limiter = limiterFor(cfg);
  const res = await limiter.schedule(() =>
    esearchPhraseWithStatus(db, phrase, cfg, retmax),
  );
  return res.ids;
}

/**
 * esearch with a caller-built term string (no quoting or field wrapping added).
 * Use this for structured queries like `BRAF[gene] AND (V600E OR Val600Glu)`
 * that the plain-phrase path can't express.
 *
 * Takes a rate-limit slot itself, so callers no longer sleep between calls.
 */
export async function esearchTermWithStatus(
  db: string,
  term: string,
  cfg: EntrezConfig,
  retmax = 200,
): Promise<EsearchPhraseResult> {
  const limiter = limiterFor(cfg);
  return limiter.schedule(() => esearchUrl(db, term, cfg, retmax));
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

/**
 * Fetch metadata for every UID, in chunks of 200.
 *
 * Chunks run concurrently under the shared limiter. A large result set (50
 * phrases x retmax 200) can span dozens of chunks, which previously ran one
 * after another.
 */
export async function esummaryBatchWithDiagnostics<T>(
  db: string,
  uids: string[],
  cfg: EntrezConfig,
): Promise<EsummaryBatchResult<T>> {
  const chunkSize = 200;
  const chunks: string[][] = [];
  for (let i = 0; i < uids.length; i += chunkSize) {
    chunks.push(uids.slice(i, i + chunkSize));
  }

  const limiter = limiterFor(cfg);
  const results = await mapWithLimiter(limiter, chunks, async (chunk) => {
    const params = baseParams(cfg);
    params.set("db", db);
    params.set("id", chunk.join(","));
    params.set("retmode", "json");
    const url = `${EUTILS}/esummary.fcgi?${params.toString()}`;
    const res = await timedFetch(url, limiter);
    if (!res.ok) {
      return { ok: false as const, status: res.status, entries: [] as [string, T][] };
    }
    try {
      const data = (await res.json()) as { result?: Record<string, T | string[]> };
      const entries: [string, T][] = [];
      for (const [k, v] of Object.entries(data.result ?? {})) {
        if (k === "uids" || Array.isArray(v)) continue;
        entries.push([k, v as T]);
      }
      return { ok: true as const, status: res.status, entries };
    } catch {
      return { ok: false as const, status: res.status, entries: [] as [string, T][] };
    }
  });

  // Merge in chunk order so a UID appearing twice resolves deterministically.
  const out = new Map<string, T>();
  let failedSummaryBatchCount = 0;
  let rateLimitedSummaryBatchCount = 0;
  for (const r of results) {
    if (!r.ok) {
      failedSummaryBatchCount += 1;
      if (isRateLimitStatus(r.status)) rateLimitedSummaryBatchCount += 1;
      continue;
    }
    for (const [k, v] of r.entries) out.set(k, v);
  }

  return {
    summaries: out,
    diagnostics: {
      summaryBatchCount: chunks.length,
      failedSummaryBatchCount,
      rateLimitedSummaryBatchCount,
    },
  };
}

/**
 * Run one esearch per input phrase. Returns a map of UID → set of phrases that
 * matched.
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
  const diag = emptyDiagnostics();
  diag.phraseCount = phrases.length;

  const limiter = limiterFor(cfg);
  const results = await mapWithLimiter(limiter, phrases, async (phrase) =>
    cfg.deadline !== undefined && Date.now() > cfg.deadline
      ? failedSearch(0)
      : esearchPhraseWithStatus(db, phrase, cfg),
  );

  // Accumulate in phrase order so `matchedBy` sets are built deterministically
  // regardless of which request happened to finish first.
  const matched: Map<string, Set<string>> = new Map();
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (!res.ok) {
      diag.failedPhraseCount += 1;
      if (res.rateLimited) diag.rateLimitedPhraseCount += 1;
    }
    for (const id of res.ids) {
      let set = matched.get(id);
      if (!set) {
        set = new Set();
        matched.set(id, set);
      }
      set.add(phrases[i]);
    }
  }

  return { matched, diagnostics: finalizeDiagnostics(diag) };
}

/**
 * Scheduled GET returning a text body, for the E-utilities endpoints that only
 * speak XML (elink, efetch with rettype=vcv). Inherits the same retry/timeout
 * handling as the JSON paths; returns null on failure so callers can treat
 * these as best-effort.
 *
 * This takes its own rate-limit slot, so callers batch it with plain
 * `Promise.all`. Passing it to `mapWithLimiter` (or wrapping it in
 * `schedule()`) would hold one slot while waiting for a second and deadlock
 * as soon as the batch reached the concurrency ceiling.
 */
export async function entrezFetchText(
  url: string,
  cfg: EntrezConfig,
): Promise<string | null> {
  const limiter = limiterFor(cfg);
  return limiter.schedule(async () => {
    const res = await timedFetch(url, limiter);
    if (!res.ok) return null;
    try {
      return await res.text();
    } catch {
      return null;
    }
  });
}
