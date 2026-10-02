import { describe, it, expect } from "vitest";
import { classify } from "@/lib/hgvs/classify";

describe("classify", () => {
  it("recognizes transcript-prefixed HGVSc", () => {
    const r = classify("NM_004333.6:c.1799T>A");
    expect(r.kind).toBe("hgvsc");
    expect(r.accession).toBe("NM_004333.6");
    expect(r.body).toBe("c.1799T>A");
  });

  it("recognizes transcript-prefixed HGVSp (3-letter)", () => {
    const r = classify("NP_004324.2:p.Val600Glu");
    expect(r.kind).toBe("hgvsp");
    expect(r.accession).toBe("NP_004324.2");
    expect(r.body).toBe("p.Val600Glu");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("recognizes chr-prefixed HGVSg", () => {
    const r = classify("chr7:g.140753336A>T");
    expect(r.kind).toBe("hgvsg");
    expect(r.chrom).toBe("7");
    expect(r.body).toBe("g.140753336A>T");
  });

  it("recognizes numeric chrom HGVSg", () => {
    const r = classify("7:g.140753336A>T");
    expect(r.kind).toBe("hgvsg");
    expect(r.chrom).toBe("7");
  });

  it("recognizes NC_ accession for HGVSg", () => {
    const r = classify("NC_000007.14:g.140753336A>T");
    expect(r.kind).toBe("hgvsg");
    expect(r.accession).toBe("NC_000007.14");
  });

  it("recognizes gene + space + HGVSp short", () => {
    const r = classify("BRAF p.V600E");
    expect(r.kind).toBe("hgvsp");
    expect(r.gene).toBe("BRAF");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("recognizes gene + space + short (no p. prefix)", () => {
    const r = classify("KRAS G12D");
    expect(r.kind).toBe("short");
    expect(r.gene).toBe("KRAS");
    expect(r.proteinShort).toBe("G12D");
    expect(r.proteinLong).toBe("p.Gly12Asp");
  });

  it("recognizes gene-colon-HGVSp", () => {
    const r = classify("BRAF:p.V600E");
    expect(r.kind).toBe("hgvsp");
    expect(r.gene).toBe("BRAF");
  });

  it("recognizes bare short protein form with parens", () => {
    const r = classify("p.(V600E)");
    expect(r.kind).toBe("hgvsp");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("recognizes bare 3-letter protein", () => {
    const r = classify("Val600Glu");
    expect(r.kind).toBe("short");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("recognizes rsID", () => {
    const r = classify("rs113488022");
    expect(r.kind).toBe("rsid");
    expect(r.body).toBe("rs113488022");
  });

  it("recognizes stop-gain short form", () => {
    const r = classify("R175*");
    expect(r.kind).toBe("short");
    expect(r.proteinShort).toBe("R175*");
    expect(r.proteinLong).toBe("p.Arg175Ter");
  });

  it("rejects invalid one-letter amino-acid alt code in short form", () => {
    const r = classify("V600B");
    expect(r.kind).toBe("unknown");
    expect(r.proteinShort).toBeUndefined();
    expect(r.proteinLong).toBeUndefined();
  });

  it("rejects invalid one-letter amino-acid ref code in short form", () => {
    const r = classify("B600E");
    expect(r.kind).toBe("unknown");
    expect(r.proteinShort).toBeUndefined();
    expect(r.proteinLong).toBeUndefined();
  });

  it("returns unknown for nonsense", () => {
    const r = classify("this is not a mutation");
    expect(r.kind).toBe("unknown");
  });

  it("accepts lowercase protein body in gene + space form", () => {
    const r = classify("BRAF v600e");
    expect(r.kind).toBe("short");
    expect(r.gene).toBe("BRAF");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("accepts lowercase gene symbol and uppercases it", () => {
    const r = classify("braf V600E");
    expect(r.kind).toBe("short");
    expect(r.gene).toBe("BRAF");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("accepts fully lowercase gene + short form", () => {
    const r = classify("braf v600e");
    expect(r.kind).toBe("short");
    expect(r.gene).toBe("BRAF");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("accepts lowercase 3-letter protein with gene", () => {
    const r = classify("kras gly12asp");
    expect(r.kind).toBe("short");
    expect(r.gene).toBe("KRAS");
    expect(r.proteinShort).toBe("G12D");
    expect(r.proteinLong).toBe("p.Gly12Asp");
  });

  it("accepts lowercase p. form with gene", () => {
    const r = classify("BRAF p.v600e");
    expect(r.kind).toBe("hgvsp");
    expect(r.gene).toBe("BRAF");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("accepts lowercase gene:p.form", () => {
    const r = classify("braf:p.v600e");
    expect(r.kind).toBe("hgvsp");
    expect(r.gene).toBe("BRAF");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });

  it("accepts bare lowercase short protein", () => {
    const r = classify("v600e");
    expect(r.kind).toBe("short");
    expect(r.proteinShort).toBe("V600E");
    expect(r.proteinLong).toBe("p.Val600Glu");
  });
});
