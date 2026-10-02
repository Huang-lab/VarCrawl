import { NextRequest, NextResponse } from "next/server";
import { cacheGet, cacheSet, hash } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";
import { rateLimitedStatus } from "@/lib/search/results";
import { entrezConfigFromEnv, runClinvarSearch } from "@/lib/search/run";
import { MAX_SEARCH_TERMS, normalizeTerms } from "@/lib/search/terms";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  variants: string[];
  /** Gene symbol the user intended (e.g. "KRAS"). Enables strict filtering. */
  gene?: string;
  /**
   * Accepted protein forms (mix of 1-letter and 3-letter, with and without the
   * `p.` prefix). Any record whose title doesn't contain at least one of these
   * forms is dropped. Leave empty to skip the protein check.
   */
  proteinForms?: string[];
}

export async function POST(req: NextRequest) {
  const rl = await checkRateLimit(req);
  if (rl && !rl.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded", status: rateLimitedStatus("ClinVar", rl.retryAfterSec) },
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

  const variants = normalizeTerms(body.variants, MAX_SEARCH_TERMS);
  if (variants.length === 0) {
    return NextResponse.json(
      { error: "'variants' must contain at least one non-empty string" },
      { status: 400 },
    );
  }

  const gene =
    typeof body.gene === "string" && body.gene.trim() ? body.gene.trim() : undefined;
  const proteinForms = Array.isArray(body.proteinForms)
    ? body.proteinForms.filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];

  const cacheKey = `clinvar:${hash({ variants, gene, proteinForms })}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const resp = await runClinvarSearch(variants, entrezConfigFromEnv(), {
    gene,
    proteinForms,
  });
  await cacheSet(cacheKey, resp, 3600 * 6);
  return NextResponse.json(resp);
}
