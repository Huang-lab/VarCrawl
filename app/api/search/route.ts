import { NextRequest, NextResponse } from "next/server";
import { classify } from "@/lib/hgvs/classify";
import { canonicalizeMultiAssembly } from "@/lib/hgvs/convert";
import { enumerateGrouped, flattenVariants } from "@/lib/hgvs/enumerate";
import { Assembly, ClassifiedInput } from "@/lib/hgvs/types";
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
  ClinvarPayload,
  PubmedPayload,
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

/** Budget for starting phrase searches; the rest of the 60s covers summaries and the response. */
const SOFT_DEADLINE_MS = Number(process.env.SEARCH_SOFT_DEADLINE_MS) || 30_000;

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
  const wantsStream = (req.headers.get("accept") ?? "").includes(NDJSON);
  const cached = await cacheGet<SearchResponseBody>(cacheKey);
  if (cached) {
    return wantsStream ? ndjsonResponse(eventsFromResult(cached)) : NextResponse.json(cached);
  }

  const plan = await planSearch(query, assembly, classified);
  // Stop starting new phrase searches well before the function limit, leaving
  // time to fetch summaries and send what was found.
  const cfg = { ...entrezConfigFromEnv(), deadline: Date.now() + SOFT_DEADLINE_MS };

  // Both searches share this process's Entrez limiter, so the aggregate rate
  // stays within quota while their latencies overlap.
  //
  // allSettled, not all: one source failing must not discard the other source
  // and the expansion we already computed.
  const runPubmed = () =>
    plan.blocked
      ? Promise.resolve(skippedPubmedPayload(plan.blocked))
      : runPubmedSearch(plan.pubmedTerms, cfg);
  const runClinvar = () =>
    runClinvarSearch(plan.clinvarTerms, cfg, { gene: plan.gene, proteinForms: plan.proteinForms });
  const settlePubmed = (r: PromiseSettledResult<PubmedPayload>) =>
    r.status === "fulfilled" ? r.value : failedPubmedPayload();
  const settleClinvar = (r: PromiseSettledResult<ClinvarPayload>) =>
    r.status === "fulfilled" ? r.value : failedClinvarPayload(plan.gene, plan.proteinForms);
  const cacheResult = async (resp: SearchResponseBody) => {
    const complete = resp.pubmed.status.complete && resp.clinvar.status.complete;
    await cacheSet(cacheKey, resp, complete ? COMPLETE_TTL_SEC : INCOMPLETE_TTL_SEC);
  };

  if (!wantsStream) {
    const [pubmedRes, clinvarRes] = await Promise.allSettled([runPubmed(), runClinvar()]);
    const resp: SearchResponseBody = {
      ...plan.base,
      pubmed: settlePubmed(pubmedRes),
      clinvar: settleClinvar(clinvarRes),
    };
    await cacheResult(resp);
    return NextResponse.json(resp);
  }

  // Streaming: send the expansion as soon as it exists and each source as soon
  // as it finishes, so the page can show what it knows without waiting for the
  // slowest upstream.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: SearchEvent) => controller.enqueue(enc.encode(`${JSON.stringify(event)}\n`));
      try {
        send({ type: "expand", data: plan.base });
        const [pubmed, clinvar] = await Promise.all([
          Promise.allSettled([runPubmed()]).then(([r]) => {
            const v = settlePubmed(r);
            send({ type: "pubmed", data: v });
            return v;
          }),
          Promise.allSettled([runClinvar()]).then(([r]) => {
            const v = settleClinvar(r);
            send({ type: "clinvar", data: v });
            return v;
          }),
        ]);
        await cacheResult({ ...plan.base, pubmed, clinvar });
        send({ type: "done" });
      } catch (e) {
        console.error("[api/search] stream failure", e);
        send({ type: "error", error: "The search could not be completed. Please retry shortly." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}

/** Expands the query and derives the search terms for each source. */
async function planSearch(query: string, assembly: Assembly, classified: ClassifiedInput) {
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
  const clinvarTerms = normalizeTerms(collectVariants(expand), MAX_SEARCH_TERMS);
  const pubmedTerms = normalizeTerms(buildPubmedSearchTerms(expand), MAX_SEARCH_TERMS);
  return {
    gene: resolveGene(expand),
    proteinForms: buildProteinForms(expand),
    clinvarTerms,
    pubmedTerms,
    blocked: literatureSearchBlockedReason(expand),
    base: {
      input: query,
      assembly,
      classified,
      canonical,
      groups,
      variants: expand.variants,
      searchTerms: { pubmed: pubmedTerms, clinvar: clinvarTerms },
    },
  };
}

type ExpandBody = Awaited<ReturnType<typeof planSearch>>["base"];

interface SearchResponseBody extends ExpandBody {
  pubmed: PubmedPayload;
  clinvar: ClinvarPayload;
}

type SearchEvent =
  | { type: "expand"; data: ExpandBody }
  | { type: "pubmed"; data: PubmedPayload }
  | { type: "clinvar"; data: ClinvarPayload }
  | { type: "done" }
  | { type: "error"; error: string };

const NDJSON = "application/x-ndjson";
const NDJSON_HEADERS = { "Content-Type": `${NDJSON}; charset=utf-8`, "Cache-Control": "no-store" };

function eventsFromResult(r: SearchResponseBody): SearchEvent[] {
  const { pubmed, clinvar, ...base } = r;
  return [
    { type: "expand", data: base },
    { type: "clinvar", data: clinvar },
    { type: "pubmed", data: pubmed },
    { type: "done" },
  ];
}

function ndjsonResponse(events: SearchEvent[]): Response {
  return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: NDJSON_HEADERS });
}
