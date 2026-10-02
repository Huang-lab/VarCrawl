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
      // Alt transcript first in the input — the enumerator should reorder MANE first
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
      {
        gene: "BRAF",
        transcript: "NM_004333.6",
        proteinAccession: "NP_004324.2",
        hgvsc: "NM_004333.6:c.1799T>A",
        hgvsp: "NP_004324.2:p.Val600Glu",
        proteinShort: "V600E",
        proteinLong: "p.Val600Glu",
        consequenceTerms: ["missense_variant"],
        maneSelect: "NM_004333.6",
        canonical: true,
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

  it("puts MANE Select transcript first regardless of input order", () => {
    const g = enumerateGrouped(brafV600E());
    expect(g.perTranscript[0].transcript).toBe("NM_004333.6");
    expect(g.perTranscript[0].isManeSelect).toBe(true);
    expect(g.perTranscript[0].isCanonical).toBe(true);
    expect(g.perTranscript[1].isManeSelect).toBeFalsy();
  });

  it("flattenVariants(groups) is equivalent to enumerateVariantStrings()", () => {
    const flat = enumerateVariantStrings(brafV600E()).map((v) => v.text);
    const flat2 = flattenVariants(enumerateGrouped(brafV600E())).map((v) => v.text);
    expect(flat2).toEqual(flat);
  });

  it("emits HGVSg for the alternate genome build when altAssemblyCoords is present", () => {
    const cv = brafV600E();
    cv.altAssemblyCoords = {
      assembly: "GRCh37",
      chrom: "7",
      genomicPos: 140453136,
      refAllele: "A",
      altAllele: "T",
    };
    const g = enumerateGrouped(cv);
    const universalTexts = g.universal.map((v) => v.text);
    // Primary (GRCh38) still present
    expect(universalTexts).toContain("chr7:g.140753336A>T");
    // Alternate (GRCh37) now also present
    expect(universalTexts).toContain("chr7:g.140453136A>T");
    expect(universalTexts).toContain("7:g.140453136A>T");
    // Labels should distinguish the assemblies
    const labels = g.universal.map((v) => v.label);
    expect(labels.some((l) => l.includes("GRCh37"))).toBe(true);
    expect(labels.some((l) => l.includes("GRCh38"))).toBe(true);
  });
});

describe("enumerateGrouped consequence attribution", () => {
  const variant = (consequences: CanonicalVariant["consequences"]): CanonicalVariant => ({
    input: { raw: "test", kind: "short", body: "test" },
    assembly: "GRCh38",
    consequences,
    notes: [],
  });

  it("keeps a group per consequence when VEP omits transcript ids", () => {
    // Both consequences lack a transcript id. Looking the consequence back up
    // by transcript would resolve both groups to the first one, dropping the
    // second gene's representations from the search entirely.
    const groups = enumerateGrouped(
      variant([
        { gene: "BRAF", proteinShort: "V600E", proteinLong: "p.Val600Glu" },
        { gene: "MAP2K1", proteinShort: "K57N", proteinLong: "p.Lys57Asn" },
      ]),
    );

    expect(groups.perTranscript).toHaveLength(2);
    expect(groups.perTranscript.map((g) => g.gene)).toEqual(["BRAF", "MAP2K1"]);

    const all = flattenVariants(groups).map((v) => v.text);
    expect(all).toContain("BRAF V600E");
    expect(all).toContain("MAP2K1 K57N");
    expect(all).toContain("p.Lys57Asn");
  });

  it("enumerates the consequence belonging to each group when transcript ids collide", () => {
    // Same transcript id on both consequences, and the second outranks the
    // first (MANE Select), so the sort reorders them. Each group must still
    // describe its own consequence.
    const groups = enumerateGrouped(
      variant([
        { transcript: "NM_1", gene: "AAA", proteinShort: "A1C", proteinLong: "p.Ala1Cys" },
        {
          transcript: "NM_1",
          gene: "BBB",
          proteinShort: "C2D",
          proteinLong: "p.Cys2Asp",
          maneSelect: "NM_1",
        },
      ]),
    );

    expect(groups.perTranscript).toHaveLength(2);

    const mane = groups.perTranscript.find((g) => g.isManeSelect);
    expect(mane?.gene).toBe("BBB");
    const maneTexts = mane!.variants.map((v) => v.text);
    // The MANE Select group must carry BBB's forms, not AAA's.
    expect(maneTexts).toContain("BBB C2D");
    expect(maneTexts).toContain("p.Cys2Asp");
    expect(maneTexts.some((t) => t.includes("AAA") || t.includes("Ala1Cys"))).toBe(false);

    const other = groups.perTranscript.find((g) => !g.isManeSelect);
    expect(other?.gene).toBe("AAA");
    expect(other!.variants.map((v) => v.text)).toContain("AAA A1C");
  });

  it("orders groups MANE Select, then MANE Plus Clinical, then canonical, then the rest", () => {
    const groups = enumerateGrouped(
      variant([
        { transcript: "NM_plain", gene: "G", proteinShort: "P4Q" },
        { transcript: "NM_canon", gene: "G", proteinShort: "P3Q", canonical: true },
        { transcript: "NM_mane", gene: "G", proteinShort: "P1Q", maneSelect: "NM_mane" },
        { transcript: "NM_mpc", gene: "G", proteinShort: "P2Q", manePlusClinical: "NM_mpc" },
      ]),
    );
    expect(groups.perTranscript.map((g) => g.transcript)).toEqual([
      "NM_mane",
      "NM_mpc",
      "NM_canon",
      "NM_plain",
    ]);
  });

  it("scales linearly with consequence count", () => {
    // A previous implementation re-scanned every consequence for each group,
    // which is quadratic; VEP can return hundreds for a large gene.
    const many = Array.from({ length: 600 }, (_, i) => ({
      transcript: `NM_${i}`,
      gene: "BIG",
      proteinShort: `A${i + 1}C`,
      proteinLong: `p.Ala${i + 1}Cys`,
    }));
    const t0 = Date.now();
    const groups = enumerateGrouped(variant(many));
    expect(groups.perTranscript).toHaveLength(600);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
