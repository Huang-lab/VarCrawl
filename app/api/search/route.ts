import { NextRequest, NextResponse } from "next/server";
import { classify } from "@/lib/hgvs/classify";
import { canonicalizeMultiAssembly } from "@/lib/hgvs/convert";
import { enumerateGrouped, flattenVariants } from "@/lib/hgvs/enumerate";
import { Assembly } from "@/lib/hgvs/types";
import { cacheGet, cacheSet, hash } from "@/lib/cache";
import { checkRateLimit } from "@/lib/ratelimit";
import {
  ExpansionResult,
  MAX_SEARCH_TERMS,
  buildProteinForms,
  buildPubmedSearchTerms,
  collectVariants,
  literatureSearchBlockedReason,
  normalizeTerms,
  resolveGene,
} from "@/lib/search/terms";
import {
  entrezConfigFromEnv,
  failedClinvarPayload,
  failedPubmedPayload,
  runClinvarSearch,
  runPubmedSearch,
  skippedPubmedPayload,
} from "@/lib/search/run";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Cache lifetime for a complete result. New publications land often enough. */
const COMPLETE_TTL_SEC = 3600 * 6;

/**
 * Cache lifetime for a result that upstream reported as partial or
 * rate-limited. Such a response tells the reader to retry shortly, so it must
 * not be served for hours — but a short TTL still absorbs a refresh storm.
 */
const INCOMPLETE_TTL_SEC = 60;

/**
 * One request that expands a mutation and searches every source.
 *
 * The UI previously made three sequential round-trips (expand, then ClinVar,
 * then PubMed) because two concurrent NCBI searches from the browser could
 * each assume the full Entrez quota. Running them inside one request means
 * they share the process-wide rate limiter, so they can go in parallel without
 * exceeding NCBI's limit — and the client waits for one round-trip, not three.
 *
 * `/api/expand`, `/api/pubmed` and `/api/clinvar` remain available for
 * programmatic use.
 */

interface Body {
  query: string;
  assembly?: Assembly;
}

const VALID_ASSEMBLIES: Assembly[] = ["GRCh38", "GRCh37"];

export async function POST(req: NextRequest) {
  try {
    return await handleSearch(req);
  } catch (e) {
    // Anything unexpected (an upstream client throwing, a VEP outage
    // propagating out of canonicalizeMultiAssembly) would otherwise become an
    // HTML 500 that the browser cannot parse as JSON, so the user sees a JSON
    // syntax error instead of what went wrong.
    console.error("[api/search] unhandled failure", e);
    return NextResponse.json(
      {
        error:
          "The search could not be completed because an upstream service failed. Please retry shortly.",
      },
      { status: 502 },
    );
  }
}

async function handleSearch(req: NextRequest) {
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

  if (!body.query || typeof body.query !== "string") {
    return NextResponse.json({ error: "Missing 'query'" }, { status: 400 });
  }
  const assembly = body.assembly ?? "GRCh38";
  if (!VALID_ASSEMBLIES.includes(assembly)) {
    return NextResponse.json({ error: "Invalid 'assembly'" }, { status: 400 });
  }

  const query = body.query.trim();
  const classified = classify(query);
  if (classified.kind === "unknown") {
    return NextResponse.json(
      {
        error:
          "Could not recognize the mutation format. Examples: BRAF p.V600E, NM_004333.6:c.1799T>A, chr7:g.140753336A>T, rs113488022.",
        classified,
      },
      { status: 400 },
    );
  }

  const cacheKey = `search:${hash({ q: query, a: assembly })}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const canonical = await canonicalizeMultiAssembly(classified, assembly);
  const groups = enumerateGrouped(canonical);
  const expand: ExpansionResult = {
    input: query,
    assembly,
    classified,
    canonical,
    groups,
    variants: flattenVariants(groups),
  };

  const gene = resolveGene(expand);
  const proteinForms = buildProteinForms(expand);
  const clinvarTerms = normalizeTerms(collectVariants(expand), MAX_SEARCH_TERMS);
  const pubmedTerms = normalizeTerms(buildPubmedSearchTerms(expand), MAX_SEARCH_TERMS);
  const blocked = literatureSearchBlockedReason(expand);

  const cfg = entrezConfigFromEnv();

  // Both searches share this process's Entrez limiter, so the aggregate rate
  // stays within quota while their latencies overlap.
  //
  // allSettled, not all: one source failing must not discard the other source
  // and the expansion we already computed.
  const [pubmedRes, clinvarRes] = await Promise.allSettled([
    blocked
      ? Promise.resolve(skippedPubmedPayload(blocked))
      : runPubmedSearch(pubmedTerms, cfg),
    runClinvarSearch(clinvarTerms, cfg, { gene, proteinForms }),
  ]);

  const pubmed =
    pubmedRes.status === "fulfilled" ? pubmedRes.value : failedPubmedPayload();
  const clinvar =
    clinvarRes.status === "fulfilled"
      ? clinvarRes.value
      : failedClinvarPayload(gene, proteinForms);

  const resp = {
    input: query,
    assembly,
    classified,
    canonical,
    groups,
    variants: expand.variants,
    searchTerms: { pubmed: pubmedTerms, clinvar: clinvarTerms },
    pubmed,
    clinvar,
  };

  const complete = pubmed.status.complete && clinvar.status.complete;
  await cacheSet(cacheKey, resp, complete ? COMPLETE_TTL_SEC : INCOMPLETE_TTL_SEC);
  return NextResponse.json(resp);
}
