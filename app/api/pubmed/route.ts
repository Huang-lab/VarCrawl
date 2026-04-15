import { NextRequest, NextResponse } from "next/server";
import { searchPubmedForVariants } from "@/lib/pubmed/entrez";
import { cacheGet, cacheSet, hash } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  variants: string[];
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req);
  if (rl && !rl.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
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
    return NextResponse.json({ error: "'variants' must be a non-empty string array" }, { status: 400 });
  }

  // Keep it sane — refuse to blast PubMed with >50 variants in one request.
  const variants = body.variants
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 50);

  const cacheKey = `pubmed:${hash(variants)}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const cfg = {
    apiKey: process.env.NCBI_API_KEY,
    email: process.env.NCBI_EMAIL,
    tool: "askmutation",
  };

  const articles = await searchPubmedForVariants(variants, cfg);
  const resp = { count: articles.length, articles };
  await cacheSet(cacheKey, resp, 3600 * 6); // 6h TTL — new pubs land often enough
  return NextResponse.json(resp);
}
