import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_TERMS,
  buildProteinForms,
  buildPubmedSearchTerms,
  collectVariants,
  hasGeneSymbol,
  literatureSearchBlockedReason,
  normalizeTerms,
  rankPubmedTerm,
  resolveGene,
} from "@/lib/search/terms";
import type { ExpansionResult } from "@/lib/search/terms";
import { classify } from "@/lib/hgvs/classify";
import { enumerateGrouped, flattenVariants } from "@/lib/hgvs/enumerate";
import type { CanonicalVariant } from "@/lib/hgvs/types";

/** Build an ExpansionResult the way /api/search does, from a canonical variant. */
function expansion(raw: string, canonical: Partial<CanonicalVariant>): ExpansionResult {
  const classified = classify(raw);
  const full: CanonicalVariant = {
    input: classified,
    assembly: "GRCh38",
    consequences: [],
    notes: [],
    ...canonical,
  };
  const groups = enumerateGrouped(full);
  return {
    input: raw,
    assembly: "GRCh38",
    classified,
    canonical: full,
    groups,
    variants: flattenVariants(groups),
  };
}

const brafV600E = () =>
  expansion("BRAF p.V600E", {
    gene: "BRAF",
    rsid: "rs113488022",
    chrom: "7",
    genomicPos: 140753336,
    refAllele: "A",
    altAllele: "T",
    consequences: [
      {
        transcript: "NM_004333.6",
        proteinAccession: "NP_004324.2",
        gene: "BRAF",
        hgvsc: "NM_004333.6:c.1799T>A",
        hgvsp: "NP_004324.2:p.Val600Glu",
        proteinShort: "V600E",
        proteinLong: "p.Val600Glu",
        maneSelect: "NM_004333.6",
      },
    ],
  });

describe("hasGeneSymbol", () => {
  it("matches on word boundaries so paralog-like names do not collide", () => {
    expect(hasGeneSymbol("KRAS G12D", "KRAS")).toBe(true);
    expect(hasGeneSymbol("KRASP1 G12D", "KRAS")).toBe(false);
    expect(hasGeneSymbol("braf v600e", "BRAF")).toBe(true);
  });

  it("is false without a gene to match", () => {
    expect(hasGeneSymbol("V600E", undefined)).toBe(false);
  });
});

describe("resolveGene", () => {
  it("prefers the VEP-resolved gene over the typed one", () => {
    const e = expansion("BRAF V600E", { gene: "BRAF" });
    expect(resolveGene(e)).toBe("BRAF");
  });

  it("falls back to the classified gene when VEP resolved nothing", () => {
    const e = expansion("BRAF V600E", {});
    expect(resolveGene(e)).toBe("BRAF");
  });
});

describe("collectVariants", () => {
  it("gathers universal and per-transcript representations without duplicates", () => {
    const v = collectVariants(brafV600E());
    expect(v).toContain("rs113488022");
    expect(v).toContain("chr7:g.140753336A>T");
    expect(v).toContain("NM_004333.6:c.1799T>A");
    expect(v).toContain("V600E");
    expect(new Set(v).size).toBe(v.length);
  });
});

describe("buildProteinForms", () => {
  it("emits 1- and 3-letter forms with and without the p. prefix", () => {
    const forms = buildProteinForms(brafV600E());
    for (const f of ["V600E", "p.V600E", "Val600Glu", "p.Val600Glu"]) {
      expect(forms).toContain(f);
    }
  });
});

describe("rankPubmedTerm", () => {
  const ctx = { rawInput: "BRAF p.V600E", gene: "BRAF", transcripts: ["NM_004333.6"] };

  it("ranks the user's own input first", () => {
    expect(rankPubmedTerm("BRAF p.V600E", ctx)).toBe(0);
  });

  it("ranks unambiguous identifiers above gene-qualified forms", () => {
    expect(rankPubmedTerm("rs113488022", ctx)).toBe(1);
    expect(rankPubmedTerm("chr7:g.140753336A>T", ctx)).toBe(1);
    expect(rankPubmedTerm("BRAF V600E", ctx)).toBe(2);
    expect(rankPubmedTerm("NM_004333.6:c.1799T>A", ctx)).toBe(3);
    expect(rankPubmedTerm("c.1799T>A", ctx)).toBe(4);
  });
});

describe("buildPubmedSearchTerms", () => {
  it("adds gene context to bare representations", () => {
    const terms = buildPubmedSearchTerms(brafV600E());
    expect(terms).toContain("BRAF V600E");
    expect(terms).toContain("BRAF c.1799T>A");
  });

  it("orders strongest terms first, since the list is truncated", () => {
    const terms = buildPubmedSearchTerms(brafV600E());
    expect(terms[0]).toBe("BRAF p.V600E");
    const bareIdx = terms.indexOf("c.1799T>A");
    const geneIdx = terms.indexOf("BRAF V600E");
    if (bareIdx >= 0) expect(geneIdx).toBeLessThan(bareIdx);
  });

  it("drops gene-free phrases for gene-ambiguous input", () => {
    // "V600E" alone would match papers about any gene's codon 600.
    const terms = buildPubmedSearchTerms(brafV600E());
    expect(terms.every((t) => hasGeneSymbol(t, "BRAF"))).toBe(true);
  });

  it("keeps bare coordinates for a genomic query with no gene", () => {
    const e = expansion("chr7:g.140753336A>T", {
      chrom: "7",
      genomicPos: 140753336,
      refAllele: "A",
      altAllele: "T",
    });
    const terms = buildPubmedSearchTerms(e);
    expect(terms).toContain("chr7:g.140753336A>T");
    expect(terms).toContain("7:g.140753336A>T");
  });
});

describe("normalizeTerms", () => {
  it("trims, de-duplicates and preserves order", () => {
    expect(normalizeTerms([" V600E ", "V600E", "", "p.V600E"])).toEqual([
      "V600E",
      "p.V600E",
    ]);
  });

  it("caps the list so one search cannot issue unbounded upstream requests", () => {
    const many = Array.from({ length: 500 }, (_, i) => `term${i}`);
    expect(normalizeTerms(many)).toHaveLength(MAX_SEARCH_TERMS);
    expect(normalizeTerms(many, 5)).toHaveLength(5);
  });

  it("rejects non-array and non-string input", () => {
    expect(normalizeTerms(undefined)).toEqual([]);
    expect(normalizeTerms("V600E")).toEqual([]);
    expect(normalizeTerms([1, null, "V600E"])).toEqual(["V600E"]);
  });
});

describe("literatureSearchBlockedReason", () => {
  it("blocks a protein-only query with no resolvable gene", () => {
    const e = expansion("V600E", {});
    expect(e.classified.kind).toBe("short");
    expect(literatureSearchBlockedReason(e)).toMatch(/require a gene symbol/);
  });

  it("allows the same query once a gene is known", () => {
    expect(literatureSearchBlockedReason(brafV600E())).toBeNull();
  });

  it("allows a genomic query with no gene", () => {
    const e = expansion("chr7:g.140753336A>T", {
      chrom: "7",
      genomicPos: 140753336,
      refAllele: "A",
      altAllele: "T",
    });
    expect(literatureSearchBlockedReason(e)).toBeNull();
  });
});
