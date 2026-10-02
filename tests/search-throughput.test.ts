import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end throughput and rate-compliance test against a simulated NCBI /
 * EBI, standing in for live calls (which need network access and would be
 * non-deterministic anyway).
 *
 * Two things must hold at once, and they pull against each other:
 *   1. A search over the full phrase budget finishes well inside the 60s
 *      serverless ceiling.
 *   2. No 1-second window exceeds the rate NCBI grants for the API key.
 */

const RTT_MS = 300; // representative round-trip to eutils
const PHRASES = 50; // the per-database phrase cap

interface CallRecord {
  host: "ncbi" | "ebi";
  at: number;
}

function installUpstreamSimulator(calls: CallRecord[], t0: () => number) {
  const idsFor = (seed: string) => {
    // Deterministic overlapping id sets, so esummary has real work to batch.
    const base = Math.abs([...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 500;
    return Array.from({ length: 40 }, (_, i) => String(30000000 + ((base + i * 7) % 900)));
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const host: CallRecord["host"] = url.includes("ebi.ac.uk") ? "ebi" : "ncbi";
      calls.push({ host, at: Date.now() - t0() });

      await new Promise((r) => setTimeout(r, RTT_MS));

      if (url.includes("/esearch.fcgi")) {
        const term = new URL(url).searchParams.get("term") ?? "";
        return json({ esearchresult: { idlist: idsFor(term) } });
      }
      if (url.includes("/esummary.fcgi")) {
        const params = new URL(url).searchParams;
        const ids = (params.get("id") ?? "").split(",").filter(Boolean);
        const isClinvar = params.get("db") === "clinvar";
        const result: Record<string, unknown> = { uids: ids };
        for (const id of ids) {
          result[id] = isClinvar
            ? {
                uid: id,
                // Shaped like a real ClinVar title: the gene/protein post-filter
                // requires the protein form to appear here.
                title: `NM_004333.6(BRAF):c.1799T>A (p.Val600Glu)`,
                accession: `VCV${id}`,
                genes: [{ symbol: "BRAF" }],
                germline_classification: {
                  description: "Pathogenic",
                  review_status: "criteria provided, multiple submitters",
                  last_evaluated: "2023/01/01",
                },
                trait_set: [{ trait_name: "Melanoma" }],
              }
            : {
                uid: id,
                title: `Study of a variant ${id}`,
                authors: [{ name: "Smith JA" }],
                fulljournalname: "Journal of Test Oncology",
                pubdate: "2023 Jun 15",
                articleids: [{ idtype: "doi", value: `10.1000/test.${id}` }],
              };
        }
        return json({ result });
      }
      if (url.includes("ebi.ac.uk")) {
        const q = new URL(url).searchParams.get("query") ?? "";
        return json({
          resultList: {
            result: idsFor(q)
              .slice(0, 20)
              .map((id) => ({
                source: "MED",
                id,
                pmid: id,
                title: `Europe PMC record ${id}`,
                authorString: "Smith JA, Doe RB",
                journalTitle: "Journal of Test Oncology",
                firstPublicationDate: "2023-06-15",
              })),
          },
        });
      }
      return json({});
    }),
  );
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Highest number of calls to one host within any 1-second sliding window. */
function peakRatePerSec(calls: CallRecord[], host: CallRecord["host"]): number {
  const times = calls.filter((c) => c.host === host).map((c) => c.at).sort((a, b) => a - b);
  let peak = 0;
  for (const t of times) {
    peak = Math.max(peak, times.filter((o) => o >= t && o < t + 1000).length);
  }
  return peak;
}

const phrases = (n: number) =>
  Array.from({ length: n }, (_, i) => `BRAF p.Val${600 + i}Glu`);

const PACING_VARS = [
  "NCBI_RATE_PER_SEC",
  "NCBI_CONCURRENCY",
  "NCBI_BURST",
  "EUROPEPMC_RATE_PER_SEC",
  "EUROPEPMC_CONCURRENCY",
  "EUROPEPMC_BURST",
] as const;

describe("search throughput against a simulated upstream", () => {
  let calls: CallRecord[];
  let start = 0;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.resetModules();
    // Unset the rate settings so the test exercises production defaults,
    // remembering them so a developer's own values survive this file.
    savedEnv = {};
    for (const name of PACING_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    calls = [];
    start = Date.now();
    installUpstreamSimulator(calls, () => start);
    const { __resetLimitersForTests } = await import("@/lib/entrez/scheduler");
    __resetLimitersForTests();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs PubMed and ClinVar concurrently inside the serverless budget and inside the NCBI rate", async () => {
    const { runPubmedSearch, runClinvarSearch } = await import("@/lib/search/run");
    const cfg = { apiKey: "test-key", email: "test@example.com", tool: "varcrawl" };

    start = Date.now();
    const [pubmed, clinvar] = await Promise.all([
      runPubmedSearch(phrases(PHRASES), cfg),
      runClinvarSearch(phrases(PHRASES), cfg, {
        gene: "BRAF",
        proteinForms: ["V600E", "p.V600E", "Val600Glu", "p.Val600Glu"],
      }),
    ]);
    const elapsed = Date.now() - start;

    // Both searches returned real, merged results.
    expect(pubmed.count).toBeGreaterThan(0);
    expect(pubmed.status.complete).toBe(true);
    expect(clinvar.count).toBeGreaterThan(0);
    expect(clinvar.status.complete).toBe(true);
    expect(clinvar.records[0].clinicalSignificance).toBe("Pathogenic");
    expect(clinvar.records[0].gene).toBe("BRAF");
    expect(pubmed.articles[0].sources).toContain("PubMed");

    // The serial predecessor issued >=100 NCBI calls at one in flight, each
    // preceded by a 110ms pause: over 20s for PubMed alone, and ClinVar ran
    // after it. Well inside the ceiling now.
    const ncbiCalls = calls.filter((c) => c.host === "ncbi").length;
    expect(ncbiCalls).toBeGreaterThanOrEqual(2 * PHRASES);
    const serialEstimate = ncbiCalls * (RTT_MS + 110);
    expect(elapsed).toBeLessThan(serialEstimate / 3);
    expect(elapsed).toBeLessThan(30_000);

    // Rate compliance: NCBI grants 10 req/s with an API key, and a token
    // bucket's worst-case one-second window is burst + rate. The defaults are
    // chosen so that sum lands on the ceiling, never above it.
    expect(peakRatePerSec(calls, "ncbi")).toBeLessThanOrEqual(10);
    expect(peakRatePerSec(calls, "ebi")).toBeLessThanOrEqual(10);

    // eslint-disable-next-line no-console
    console.log(
      `[measured] ${ncbiCalls} NCBI + ${calls.length - ncbiCalls} EBI calls in ${elapsed}ms ` +
        `(serial equivalent ~${Math.round(serialEstimate / 1000)}s); ` +
        `peak NCBI ${peakRatePerSec(calls, "ncbi")} req/s, peak EBI ${peakRatePerSec(calls, "ebi")} req/s`,
    );
  }, 60_000);

  it("throttles to the lower anonymous rate when no API key is configured", async () => {
    const { runPubmedSearch } = await import("@/lib/search/run");

    start = Date.now();
    // 8 phrases only: without a key the sustained rate is ~2.5 req/s.
    await runPubmedSearch(phrases(8), { email: "test@example.com", tool: "varcrawl" });

    // NCBI allows 3 req/s without a key; stay within it.
    expect(peakRatePerSec(calls, "ncbi")).toBeLessThanOrEqual(3);
  }, 60_000);

  it("reports an incomplete search when phrases are rate-limited upstream", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/esearch.fcgi")) {
          return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
        }
        return json({ result: { uids: [] } });
      }),
    );

    const { runPubmedSearch } = await import("@/lib/search/run");
    const res = await runPubmedSearch(phrases(3), { apiKey: "k", tool: "varcrawl" });

    expect(res.count).toBe(0);
    expect(res.status.complete).toBe(false);
    expect(res.status.likelyRateLimited).toBe(true);
    expect(res.status.message).toMatch(/rate limiting/i);
  }, 60_000);
});
