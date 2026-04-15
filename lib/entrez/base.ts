/**
 * Shared NCBI E-utilities helpers — used by PubMed and ClinVar clients.
 */

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export interface EntrezConfig {
  apiKey?: string;
  email?: string;
  tool?: string;
}

export function baseParams(cfg: EntrezConfig): URLSearchParams {
  const params = new URLSearchParams();
  params.set("tool", cfg.tool ?? "askmutation");
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
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res;
    const retriable = res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;
    if (!retriable || attempt === maxAttempts) return res;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 300 * Math.pow(2, attempt - 1);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return fetch(url, { headers: { Accept: "application/json" } });
}

/** esearch for an exact phrase in a single DB. Returns a list of UIDs. */
export async function esearchPhrase(
  db: string,
  phrase: string,
  cfg: EntrezConfig,
  retmax = 200,
): Promise<string[]> {
  const params = baseParams(cfg);
  params.set("db", db);
  params.set("term", `"${phrase.replace(/"/g, "")}"[All Fields]`);
  params.set("retmode", "json");
  params.set("retmax", String(retmax));
  const url = `${EUTILS}/esearch.fcgi?${params.toString()}`;
  const res = await timedFetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    esearchresult?: { idlist?: string[] };
  };
  return data.esearchresult?.idlist ?? [];
}

/** esummary for a batch of UIDs. Returns the raw `result` map minus the `uids` array. */
export async function esummaryBatch<T>(
  db: string,
  uids: string[],
  cfg: EntrezConfig,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const chunkSize = 200;
  const d = delayMs(cfg);
  for (let i = 0; i < uids.length; i += chunkSize) {
    const chunk = uids.slice(i, i + chunkSize);
    const params = baseParams(cfg);
    params.set("db", db);
    params.set("id", chunk.join(","));
    params.set("retmode", "json");
    const url = `${EUTILS}/esummary.fcgi?${params.toString()}`;
    if (i > 0) await new Promise((r) => setTimeout(r, d));
    const res = await timedFetch(url);
    if (!res.ok) continue;
    const data = (await res.json()) as { result?: Record<string, T | string[]> };
    if (!data.result) continue;
    for (const [k, v] of Object.entries(data.result)) {
      if (k === "uids") continue;
      if (Array.isArray(v)) continue;
      out.set(k, v as T);
    }
  }
  return out;
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
  const matched: Map<string, Set<string>> = new Map();
  const d = delayMs(cfg);
  for (let i = 0; i < phrases.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, d));
    const ids = await esearchPhrase(db, phrases[i], cfg);
    for (const id of ids) {
      if (!matched.has(id)) matched.set(id, new Set());
      matched.get(id)!.add(phrases[i]);
    }
  }
  return matched;
}
