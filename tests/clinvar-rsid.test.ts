import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The supplemental rsID path: elink (dbSNP → ClinVar) per rsID, then one
 * efetch for the VCV records. `/api/clinvar` accepts an arbitrary variant
 * list, so this path can be driven with more rsIDs than the concurrency
 * ceiling allows in flight.
 */

const VCV_XML = `
<ClinVarResult-Set>
  <VariationArchive VariationID="13961" Accession="VCV000013961" VariationName="NM_004333.6(BRAF):c.1799T&gt;A (p.Val600Glu)">
    <ClassifiedRecord>
      <SimpleAllele><GeneList><Gene Symbol="BRAF"/></GeneList></SimpleAllele>
      <Classifications>
        <GermlineClassification DateLastEvaluated="2023-01-01">
          <ReviewStatus>criteria provided, multiple submitters, no conflicts</ReviewStatus>
          <Description>Pathogenic</Description>
        </GermlineClassification>
      </Classifications>
      <ConditionList>
        <TraitSet><Trait><Name><ElementValue Type="Preferred">Melanoma</ElementValue></Name></Trait></TraitSet>
      </ConditionList>
    </ClassifiedRecord>
  </VariationArchive>
</ClinVarResult-Set>`;

function installMock(counts: { elink: number; efetch: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/esearch.fcgi")) {
        return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 });
      }
      if (url.includes("/elink.fcgi")) {
        counts.elink += 1;
        return new Response(
          "<eLinkResult><LinkSet><LinkSetDb><Id>13961</Id></LinkSetDb></LinkSet></eLinkResult>",
          { status: 200 },
        );
      }
      if (url.includes("/efetch.fcgi")) {
        counts.efetch += 1;
        return new Response(VCV_XML, { status: 200 });
      }
      return new Response(JSON.stringify({ result: { uids: [] } }), { status: 200 });
    }),
  );
}

describe("ClinVar rsID elink path", () => {
  let counts: { elink: number; efetch: number };

  beforeEach(async () => {
    vi.resetModules();
    counts = { elink: 0, efetch: 0 };
    installMock(counts);
    const { __resetLimitersForTests } = await import("@/lib/entrez/scheduler");
    __resetLimitersForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses classification, gene and conditions out of the VCV record", async () => {
    const { searchClinvarForVariantsDetailed } = await import("@/lib/clinvar/entrez");
    const res = await searchClinvarForVariantsDetailed(["rs113488022"], {
      apiKey: "k",
      tool: "varcrawl",
    });

    expect(counts.elink).toBe(1);
    expect(counts.efetch).toBe(1);

    const rec = res.records.find((r) => r.accession === "VCV000013961");
    expect(rec).toBeDefined();
    expect(rec!.clinicalSignificance).toBe("Pathogenic");
    expect(rec!.gene).toBe("BRAF");
    expect(rec!.reviewStatus).toContain("criteria provided");
    expect(rec!.conditions).toContain("Melanoma");
    // XML entities in the variation name are decoded.
    expect(rec!.title).toBe("NM_004333.6(BRAF):c.1799T>A (p.Val600Glu)");
    expect(rec!.matchedBy).toEqual(["rs113488022"]);
  }, 30000);

  it("completes with more rsIDs than the concurrency ceiling", async () => {
    // Each elink call takes its own rate-limit slot. Batching those calls
    // inside another scheduled task would hold an outer slot while awaiting an
    // inner one, hanging the request until the function timed out.
    const { searchClinvarForVariantsDetailed } = await import("@/lib/clinvar/entrez");
    const rsids = Array.from({ length: 12 }, (_, i) => `rs${1000 + i}`);

    const outcome = await Promise.race([
      searchClinvarForVariantsDetailed(rsids, { apiKey: "k", tool: "varcrawl" }).then(
        (r) => r.records.length,
      ),
      new Promise<string>((r) => setTimeout(() => r("timed out"), 15000)),
    ]);

    expect(outcome).not.toBe("timed out");
    expect(counts.elink).toBe(12);
    // All 12 rsIDs link to the same variation, fetched in one efetch and
    // de-duplicated by accession.
    expect(counts.efetch).toBe(1);
    expect(outcome).toBe(1);
  }, 30000);
});
