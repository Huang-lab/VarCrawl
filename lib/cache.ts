/**
 * Tiny Upstash Redis REST wrapper. No-op if the env vars aren't set, so local
 * dev works without any external deps.
 */

import { envNumber } from "@/lib/entrez/scheduler";

const BASE_URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const enabled = !!(BASE_URL && TOKEN);

/** Give up on a cache round-trip rather than delaying the response. */
const CACHE_TIMEOUT_MS = envNumber("CACHE_TIMEOUT_MS", 2000);

/**
 * Skip writes above this size. Upstash rejects oversized request bodies, and a
 * response this large is cheaper to recompute than to ship twice.
 */
const MAX_VALUE_BYTES = envNumber("CACHE_MAX_VALUE_BYTES", 900_000);

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!enabled) return null;
  try {
    const res = await fetch(`${BASE_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      cache: "no-store",
      signal: AbortSignal.timeout(CACHE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result: string | null };
    if (!data.result) return null;
    return JSON.parse(data.result) as T;
  } catch {
    return null;
  }
}

/**
 * Write a value under `key`, expiring after `ttlSec`.
 *
 * The value travels in the request body, not the URL. Upstash accepts either,
 * but a URL-embedded value has to survive every proxy's request-line limit
 * (commonly 8 KB), and these payloads are far larger: a 50-article PubMed
 * response percent-encodes to roughly 37 KB of URL. Sending those as a path
 * segment meant the write was rejected and — because cache failures are
 * deliberately swallowed — the cache silently never populated for exactly the
 * expensive queries it exists to serve.
 *
 * Returns whether the value was stored, so callers can surface cache health.
 */
export async function cacheSet<T>(key: string, value: T, ttlSec = 86400): Promise<boolean> {
  if (!enabled) return false;
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    return false; // circular or otherwise unserializable
  }
  if (body.length > MAX_VALUE_BYTES) return false;

  try {
    const res = await fetch(
      `${BASE_URL}/set/${encodeURIComponent(key)}?EX=${encodeURIComponent(String(ttlSec))}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(CACHE_TIMEOUT_MS),
      },
    );
    return res.ok;
  } catch {
    return false; // ignore cache failures
  }
}

/**
 * Non-cryptographic hash for cache keys.
 *
 * Two independent FNV-1a lanes (different offset bases, one over the string
 * reversed) plus the input length give a 64-bit-wide key. A single 32-bit lane
 * reaches a ~50% chance of collision after only ~77k distinct queries, and a
 * collision here would serve one variant's articles under another variant's
 * key — a wrong answer, not just a slow one. Widening the digest makes that
 * negligible for any realistic key space.
 */
export function hash(input: unknown): string {
  const s = JSON.stringify(input) ?? "";

  let h1 = 2166136261; // FNV-1a 32-bit offset basis
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
  }

  let h2 = 0x811c9dc5 ^ 0x9e3779b9; // distinct basis, walked in reverse
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 16777619);
  }

  const lane = (h: number) => (h >>> 0).toString(16).padStart(8, "0");
  return `${lane(h1)}${lane(h2)}-${s.length.toString(36)}`;
}
