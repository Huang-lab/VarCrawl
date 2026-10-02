import { describe, it, expect, afterEach, vi } from "vitest";
import { searchClinvarForVariantsDetailed } from "@/lib/clinvar/entrez";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function decodeTerm(url: string): string {
  const u = new URL(url);
  return u.searchParams.get("term") ?? "";
}

describe("searchClinvarForVariantsDetailed fallback path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recovers VCV000013961 via per-form fallback when the primary OR query returns nothing", async () => {
    const esearchCalls: string[] = [];
    let esummaryCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/esearch.fcgi")) {
        const term = decodeTerm(url);
        esearchCalls.push(term);
        // Phrase path and the big OR primary both miss; only the simple
        // `BRAF[gene] AND Val600Glu` fallback returns the UID.
        if (term === "BRAF[gene] AND Val600Glu") {
          return jsonResponse({ esearchresult: { idlist: ["13961"] } });
        }
        return jsonResponse({ esearchresult: { idlist: [] } });
      }

      if (url.includes("/esummary.fcgi")) {
        esummaryCalls += 1;
        return jsonResponse({
          result: {
            uids: ["13961"],
            "13961": {
              uid: "13961",
              accession: "VCV000013961",
              title: "NM_004333.6(BRAF):c.1799T>A (p.Val600Glu)",
              genes: [{ symbol: "BRAF" }],
              germline_classification: {
                description: "Pathogenic",
                review_status: "criteria provided, multiple submitters",
                last_evaluated: "2024/01/01",
              },
              trait_set: [{ trait_name: "Melanoma" }],
            },
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const res = await searchClinvarForVariantsDetailed(
      ["BRAF V600E"],
      { tool: "test" },
      {
        gene: "BRAF",
        proteinForms: ["V600E", "p.V600E", "Val600Glu", "p.Val600Glu"],
      },
    );

    expect(res.records).toHaveLength(1);
    expect(res.records[0].accession).toBe("VCV000013961");
    expect(res.records[0].gene).toBe("BRAF");
    expect(res.records[0].clinicalSignificance).toBe("Pathogenic");
    expect(res.records[0].matchedBy).toContain("BRAF V600E");

    // Short-circuit: once the first fallback term hits, no further fallbacks run.
    expect(esearchCalls).toEqual([
      '"BRAF V600E"[All Fields]',
      'BRAF[gene] AND (V600E OR "p.V600E" OR Val600Glu OR "p.Val600Glu")',
      "BRAF[gene] AND Val600Glu",
    ]);
    expect(esummaryCalls).toBe(1);
  });

  it("skips the fallback loop when the primary structured query already returned hits", async () => {
    const esearchCalls: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/esearch.fcgi")) {
        const term = decodeTerm(url);
        esearchCalls.push(term);
        if (term.startsWith("BRAF[gene] AND (")) {
          return jsonResponse({ esearchresult: { idlist: ["13961"] } });
        }
        return jsonResponse({ esearchresult: { idlist: [] } });
      }

      if (url.includes("/esummary.fcgi")) {
        return jsonResponse({
          result: {
            uids: ["13961"],
            "13961": {
              uid: "13961",
              accession: "VCV000013961",
              title: "NM_004333.6(BRAF):c.1799T>A (p.Val600Glu)",
              genes: [{ symbol: "BRAF" }],
              germline_classification: { description: "Pathogenic" },
            },
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const res = await searchClinvarForVariantsDetailed(
      ["BRAF V600E"],
      { tool: "test" },
      {
        gene: "BRAF",
        proteinForms: ["V600E", "p.V600E", "Val600Glu", "p.Val600Glu"],
      },
    );

    expect(res.records).toHaveLength(1);
    expect(res.records[0].accession).toBe("VCV000013961");
    // No fallback `BRAF[gene] AND Val600Glu` call was issued — only the
    // phrase path and the primary structured query ran.
    expect(esearchCalls.some((t) => t === "BRAF[gene] AND Val600Glu")).toBe(false);
  });
});
