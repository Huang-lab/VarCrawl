import { NextRequest, NextResponse } from "next/server";
import { searchPubmedForVariantsDetailed } from "@/lib/pubmed/entrez";
import { cacheGet, cacheSet, hash } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  variants: string[];
}

interface SourceStatus {
  complete: boolean;
  likelyRateLimited: boolean;
  likelyPartial: boolean;
  message?: string;
}

function buildStatusFromDiagnostics(diag: {
  likelyPartial: boolean;
  likelyRateLimited: boolean;
}): SourceStatus {
  if (diag.likelyRateLimited) {
    return {
      complete: false,
      likelyRateLimited: true,
      likelyPartial: true,
      message: "PubMed may be incomplete due to NCBI rate limiting. Please retry shortly.",
    };
  }
  if (diag.likelyPartial) {
    return {
      complete: false,
      likelyRateLimited: false,
      likelyPartial: true,
    };
  }
  return {
    complete: true,
    likelyRateLimited: false,
    likelyPartial: false,
  };
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req);
  if (rl && !rl.success) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        status: {
          complete: false,
          likelyRateLimited: true,
          likelyPartial: true,
          message: "PubMed may be incomplete due to NCBI rate limiting. Please retry shortly.",
        },
      },
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
    tool: "varcrawl",
  };

  const { articles, diagnostics } = await searchPubmedForVariantsDetailed(variants, cfg);
  const resp = {
    count: articles.length,
    articles,
    status: buildStatusFromDiagnostics(diagnostics),
  };
  await cacheSet(cacheKey, resp, 3600 * 6); // 6h TTL — new pubs land often enough
  return NextResponse.json(resp);
}
