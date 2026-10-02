import { NextRequest, NextResponse } from "next/server";
import { cacheGet, cacheSet, hash } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";
import { rateLimitedStatus } from "@/lib/search/results";
import { entrezConfigFromEnv, runPubmedSearch } from "@/lib/search/run";
import { MAX_SEARCH_TERMS, normalizeTerms } from "@/lib/search/terms";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  variants: string[];
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req);
  if (rl && !rl.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded", status: rateLimitedStatus("PubMed", rl.retryAfterSec) },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.variants) || body.variants.length === 0) {
    return NextResponse.json(
      { error: "'variants' must be a non-empty string array" },
      { status: 400 },
    );
  }

  // Each phrase costs one upstream request per database — refuse to blast
  // PubMed with an unbounded list.
  const variants = normalizeTerms(body.variants, MAX_SEARCH_TERMS);
  if (variants.length === 0) {
    return NextResponse.json(
      { error: "'variants' must contain at least one non-empty string" },
      { status: 400 },
    );
  }

  const cacheKey = `pubmed:${hash(variants)}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const resp = await runPubmedSearch(variants, entrezConfigFromEnv());
  await cacheSet(cacheKey, resp, 3600 * 6); // 6h TTL — new pubs land often enough
  return NextResponse.json(resp);
}
