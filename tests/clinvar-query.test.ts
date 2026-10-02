import { describe, it, expect } from "vitest";
import { buildGeneProteinQuery, buildGeneProteinQueries } from "@/lib/clinvar/entrez";

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

describe("buildGeneProteinQueries", () => {
  it("emits simple GENE[gene] AND FORM terms with 3-letter forms first", () => {
    const terms = buildGeneProteinQueries("BRAF", [
      "V600E",
      "p.V600E",
      "Val600Glu",
      "p.Val600Glu",
    ]);
    expect(terms).toEqual([
      "BRAF[gene] AND Val600Glu",
      "BRAF[gene] AND V600E",
      "BRAF[gene] AND Val600Glu[All Fields]",
      "BRAF[gene] AND V600E[All Fields]",
    ]);
  });

  it("strips a leading p. prefix before emitting tokens", () => {
    const terms = buildGeneProteinQueries("TP53", ["p.R175H"]);
    expect(terms).toEqual([
      "TP53[gene] AND R175H",
      "TP53[gene] AND R175H[All Fields]",
    ]);
  });

  it("drops forms that would need quoting", () => {
    // `p.Val600Glu*` is not alphanumeric — skip it rather than emit a term that
    // NCBI's parser could misinterpret.
    const terms = buildGeneProteinQueries("BRAF", ["Val600Glu*", "Val600Glu"]);
    expect(terms).toEqual([
      "BRAF[gene] AND Val600Glu",
      "BRAF[gene] AND Val600Glu[All Fields]",
    ]);
  });

  it("deduplicates case-insensitively", () => {
    const terms = buildGeneProteinQueries("KRAS", ["G12D", "g12d", "p.G12D"]);
    expect(terms).toEqual([
      "KRAS[gene] AND G12D",
      "KRAS[gene] AND G12D[All Fields]",
    ]);
  });

  it("caps the output at four terms even with many forms", () => {
    const terms = buildGeneProteinQueries("BRAF", [
      "Val600Glu",
      "V600E",
      "Val600Lys",
      "V600K",
      "Val600Asp",
      "V600D",
    ]);
    expect(terms).toHaveLength(4);
  });

  it("returns an empty list when gene or forms are missing", () => {
    expect(buildGeneProteinQueries("", ["V600E"])).toEqual([]);
    expect(buildGeneProteinQueries("BRAF", [])).toEqual([]);
    expect(buildGeneProteinQueries("BRAF", ["", "   "])).toEqual([]);
  });
});
