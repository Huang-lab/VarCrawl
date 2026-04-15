import { describe, it, expect } from "vitest";
import { enumerateVariantStrings, enumerateGrouped, flattenVariants } from "@/lib/hgvs/enumerate";
import type { CanonicalVariant } from "@/lib/hgvs/types";

function brafV600E(): CanonicalVariant {
  return {
    input: {
      raw: "BRAF p.V600E",
      kind: "hgvsp",
      gene: "BRAF",
      body: "p.V600E",
      proteinShort: "V600E",
      proteinLong: "p.Val600Glu",
    },
    assembly: "GRCh38",
    gene: "BRAF",
    rsid: "rs113488022",
    hgvsg: "chr7:g.140753336A>T",
    chrom: "7",
    genomicPos: 140753336,
    refAllele: "A",
    altAllele: "T",
    consequences: [
      {
        gene: "BRAF",
        transcript: "NM_004333.6",
        proteinAccession: "NP_004324.2",
        hgvsc: "NM_004333.6:c.1799T>A",
        hgvsp: "NP_004324.2:p.Val600Glu",
        proteinShort: "V600E",
        proteinLong: "p.Val600Glu",
        consequenceTerms: ["missense_variant"],
      },
      {
        gene: "BRAF",
        transcript: "NM_001354609.2",
        proteinAccession: "NP_001341538.1",
        hgvsc: "NM_001354609.2:c.1391T>A",
        hgvsp: "NP_001341538.1:p.Val464Glu",
        proteinShort: "V464E",
        proteinLong: "p.Val464Glu",
        consequenceTerms: ["missense_variant"],
      },
    ],
    notes: [],
  };
}

describe("enumerateVariantStrings (flat)", () => {
  it("covers the major representations for BRAF V600E", () => {
    const strings = enumerateVariantStrings(brafV600E()).map((v) => v.text);
    expect(strings).toContain("rs113488022");
    expect(strings).toContain("chr7:g.140753336A>T");
    expect(strings).toContain("7:g.140753336A>T");
    expect(strings).toContain("NM_004333.6:c.1799T>A");
    expect(strings).toContain("c.1799T>A");
    expect(strings).toContain("BRAF:c.1799T>A");
    expect(strings).toContain("NP_004324.2:p.Val600Glu");
    expect(strings).toContain("p.Val600Glu");
    expect(strings).toContain("p.(Val600Glu)");
    expect(strings).toContain("Val600Glu");
    expect(strings).toContain("V600E");
    expect(strings).toContain("p.V600E");
    expect(strings).toContain("BRAF V600E");
    expect(strings).toContain("BRAF p.V600E");
  });

  it("deduplicates repeated strings", () => {
    const strings = enumerateVariantStrings(brafV600E()).map((v) => v.text);
    expect(new Set(strings).size).toBe(strings.length);
  });
});

describe("enumerateGrouped", () => {
  it("produces a universal group and one group per transcript", () => {
    const g = enumerateGrouped(brafV600E());
    expect(g.perTranscript).toHaveLength(2);
    expect(g.fallback).toHaveLength(0);
    // rsID and HGVSg live in universal, not inside any transcript group
    const universalTexts = g.universal.map((v) => v.text);
    expect(universalTexts).toContain("rs113488022");
    expect(universalTexts).toContain("chr7:g.140753336A>T");
  });

  it("attributes V600E chips to the canonical transcript and V464E to the alt transcript", () => {
    const g = enumerateGrouped(brafV600E());
    const canonical = g.perTranscript.find((t) => t.transcript === "NM_004333.6")!;
    const alt = g.perTranscript.find((t) => t.transcript === "NM_001354609.2")!;

    expect(canonical).toBeDefined();
    expect(alt).toBeDefined();
    expect(canonical.consequenceTerms).toEqual(["missense_variant"]);
    expect(canonical.hgvsp).toBe("NP_004324.2:p.Val600Glu");

    const canonicalTexts = canonical.variants.map((v) => v.text);
    expect(canonicalTexts).toContain("V600E");
    expect(canonicalTexts).toContain("NM_004333.6:c.1799T>A");
    expect(canonicalTexts).not.toContain("V464E");

    const altTexts = alt.variants.map((v) => v.text);
    expect(altTexts).toContain("V464E");
    expect(altTexts).toContain("NM_001354609.2:c.1391T>A");
    expect(altTexts).not.toContain("V600E");
  });

  it("never repeats a string across groups (global dedupe)", () => {
    const g = enumerateGrouped(brafV600E());
    const all = [...g.universal, ...g.perTranscript.flatMap((t) => t.variants), ...g.fallback];
    const texts = all.map((v) => v.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("falls back to raw input when canonicalization returns nothing", () => {
    const cv: CanonicalVariant = {
      input: { raw: "weird input", kind: "unknown", body: "weird input" },
      assembly: "GRCh38",
      consequences: [],
      notes: [],
    };
    const g = enumerateGrouped(cv);
    expect(g.universal).toHaveLength(0);
    expect(g.perTranscript).toHaveLength(0);
    expect(g.fallback.map((v) => v.text)).toContain("weird input");
  });

  it("flattenVariants(groups) is equivalent to enumerateVariantStrings()", () => {
    const flat = enumerateVariantStrings(brafV600E()).map((v) => v.text);
    const flat2 = flattenVariants(enumerateGrouped(brafV600E())).map((v) => v.text);
    expect(flat2).toEqual(flat);
  });
});
