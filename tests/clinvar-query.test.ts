import { describe, it, expect } from "vitest";
import { buildGeneProteinQuery } from "@/lib/clinvar/entrez";

describe("buildGeneProteinQuery", () => {
  it("emits a gene-field-anchored OR query for BRAF V600E forms", () => {
    const term = buildGeneProteinQuery("BRAF", [
      "V600E",
      "p.V600E",
      "Val600Glu",
      "p.Val600Glu",
    ]);
    expect(term).toBe(
      'BRAF[gene] AND (V600E OR "p.V600E" OR Val600Glu OR "p.Val600Glu")',
    );
  });

  it("quotes forms containing non-word characters so NCBI keeps them as one token", () => {
    const term = buildGeneProteinQuery("TP53", ["p.R175H"]);
    expect(term).toBe('TP53[gene] AND ("p.R175H")');
  });

  it("deduplicates case-insensitively", () => {
    const term = buildGeneProteinQuery("KRAS", ["G12D", "g12d", "G12D"]);
    expect(term).toBe("KRAS[gene] AND (G12D)");
  });

  it("returns an empty string when no usable protein forms are provided", () => {
    expect(buildGeneProteinQuery("BRAF", [])).toBe("");
    expect(buildGeneProteinQuery("BRAF", ["", "   "])).toBe("");
  });

  it("returns an empty string when the gene is blank", () => {
    expect(buildGeneProteinQuery("", ["V600E"])).toBe("");
    expect(buildGeneProteinQuery("   ", ["V600E"])).toBe("");
  });
});
