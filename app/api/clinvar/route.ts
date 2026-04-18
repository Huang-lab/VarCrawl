import { NextRequest, NextResponse } from "next/server";
import { searchClinvarForVariantsDetailed } from "@/lib/clinvar/entrez";
import { filterClinvarRecords } from "@/lib/clinvar/filter";
import { cacheGet, cacheSet, hash } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";

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
      message: "ClinVar may be incomplete due to NCBI rate limiting. Please retry shortly.",
    };
  }
  if (diag.likelyPartial) {
    return {
      complete: false,
      likelyRateLimited: false,
      likelyPartial: true,
      message: "ClinVar may be incomplete due to temporary upstream errors.",
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
          message: "ClinVar request blocked by server rate limit. Retry later.",
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

  const variants = body.variants
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 50);

  const gene = typeof body.gene === "string" && body.gene.trim() ? body.gene.trim() : undefined;
  const proteinForms = Array.isArray(body.proteinForms)
    ? body.proteinForms.filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];

  const cacheKey = `clinvar:${hash({ variants, gene, proteinForms })}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const cfg = {
    apiKey: process.env.NCBI_API_KEY,
    email: process.env.NCBI_EMAIL,
    tool: "varcrawl",
  };

  const searchRes = await searchClinvarForVariantsDetailed(variants, cfg, {
    gene,
    proteinForms,
  });
  const all = searchRes.records;
  const { kept } = filterClinvarRecords(all, { gene, proteinForms });
  const resp = {
    count: kept.length,
    unfilteredCount: all.length,
    gene,
    proteinForms,
    status: buildStatusFromDiagnostics(searchRes.diagnostics),
    records: kept,
  };
  await cacheSet(cacheKey, resp, 3600 * 6);
  return NextResponse.json(resp);
}
