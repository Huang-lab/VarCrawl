import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCsv } from "@/lib/penetrance/csv";
import { parsePenetranceCsv } from "@/lib/penetrance/parse";
import {
  compareToBaseline,
  formatPct,
  formatRate,
  iconFills,
  oneInPhrase,
  penetranceAtAge,
  wilsonInterval,
} from "@/lib/penetrance/stats";
import { baselineFor } from "@/lib/penetrance/baseline";
import { makeDemoDataset } from "@/lib/penetrance/demo";

const META = { id: "t", label: "t", description: "t" };
const real = readFileSync("public/data/etable4_penetrance.csv", "utf8");

describe("parseCsv", () => {
  it("handles quoted commas, escaped quotes and CRLF", () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\r\n')).toEqual([
      ["a", "b, c", 'd "e"'],
      ["1", "2", "3"],
    ]);
  });
});

describe("parsePenetranceCsv", () => {
  it("loads every row of the bundled eTable 4 data", () => {
    const ds = parsePenetranceCsv(real, META);
    expect(ds.warnings).toEqual([]);
    expect(ds.records).toHaveLength(237);
    const top = ds.records.find((r) => r.rsid === "rs201672011")!;
    expect(top.carriers).toBe(990);
    expect(top.pct).toBeCloseTo(6.0606, 3);
    expect(top.affected).toBe(60);
  });

  it("keeps both alleles that share an rsID", () => {
    const ds = parsePenetranceCsv(real, META);
    expect(ds.records.filter((r) => r.rsid === "rs80359351")).toHaveLength(2);
  });

  it("ignores the clinical algorithm column", () => {
    const csv =
      "Disease,CHR,POS,REF,ALT,rsID,Individuals with variants n,ICD-10 affected individuals with variants n\nD,1,5,A,G,rs1,10,2\n";
    const ds = parsePenetranceCsv(csv, META);
    expect(ds.warnings).toEqual([]);
    expect(ds.records[0].pct).toBe(20);
  });

  it("rejects files missing required columns", () => {
    const ds = parsePenetranceCsv("Disease,CHR\nX,1\n", META);
    expect(ds.records).toHaveLength(0);
    expect(ds.warnings[0]).toMatch(/Missing required/);
  });

  it("skips rows where affected exceeds carriers", () => {
    const csv =
      "Disease,CHR,POS,REF,ALT,rsID,Individuals with variants n,ICD-10 affected individuals with variants n\nD,1,5,A,G,rs1,10,11\n";
    const ds = parsePenetranceCsv(csv, META);
    expect(ds.records).toHaveLength(0);
    expect(ds.warnings.length).toBeGreaterThan(0);
  });

  it("groups an Age column into a curve and uses the oldest age as lifetime", () => {
    const csv =
      "Disease,CHR,POS,REF,ALT,rsID,Individuals with variants n,ICD-10 affected individuals with variants n,Age\n" +
      "D,1,5,A,G,rs1,100,10,80\nD,1,5,A,G,rs1,100,2,40\n";
    const [rec] = parsePenetranceCsv(csv, META).records;
    expect(rec.ages?.map((a) => a.age)).toEqual([40, 80]);
    expect(rec.pct).toBe(10);
    expect(penetranceAtAge(rec, 60)).toBeCloseTo(6);
  });
});

describe("stats", () => {
  it("iconFills fills whole and partial icons", () => {
    expect(iconFills(35, 10)).toEqual([1, 1, 1, 0.5, 0, 0, 0, 0, 0, 0]);
    expect(iconFills(0, 10).every((f) => f === 0)).toBe(true);
    expect(iconFills(100, 10).every((f) => f === 1)).toBe(true);
    expect(iconFills(0.5, 100)[0]).toBe(0.5);
  });

  it("wilson interval stays in range and widens with small n", () => {
    const small = wilsonInterval(4, 4);
    expect(small.high).toBe(100);
    expect(small.low).toBeGreaterThan(30);
    expect(small.low).toBeLessThan(60);
    const big = wilsonInterval(400, 400);
    expect(big.low).toBeGreaterThan(small.low);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 100 });
  });

  it("oneInPhrase and formatRate", () => {
    expect(oneInPhrase(0.32)).toBe("1 in 310");
    expect(oneInPhrase(0.0005)).toBe("1 in 200,000");
    expect(formatRate(12.9)).toBe("13%");
    expect(formatRate(0.4)).toBe("about 1 in 250");
  });

  it("compareToBaseline only claims a difference when the baseline is outside the range", () => {
    const ci = wilsonInterval(60, 990);
    expect(compareToBaseline(6.06, ci, 1).verdict).toBe("higher");
    expect(compareToBaseline(6.06, ci, 6).verdict).toBe("similar");
    expect(compareToBaseline(6.06, ci, 20).verdict).toBe("lower");
    expect(compareToBaseline(6, ci, 2).ratio).toBeCloseTo(3);
    // Few carriers: the range is wide, so a 5x point estimate is still "similar".
    expect(compareToBaseline(10, wilsonInterval(1, 10), 2).verdict).toBe("similar");
  });

  it("formatPct", () => {
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(0.04)).toBe("<0.1%");
    expect(formatPct(3.636)).toBe("3.6%");
    expect(formatPct(33.33)).toBe("33%");
  });
});

describe("baselines", () => {
  it("covers every disease in the bundled data", () => {
    const diseases = new Set(parsePenetranceCsv(real, META).records.map((r) => r.disease));
    for (const d of diseases) expect(baselineFor(d), d).toBeDefined();
  });
  it("matches ignoring case and returns undefined for unknown diseases", () => {
    expect(baselineFor("Familial Cancer of Breast")?.pct).toBeGreaterThan(0);
    expect(baselineFor("not a disease")).toBeUndefined();
  });
});

describe("demo dataset", () => {
  it("is monotone, starts at 0 and ends at the lifetime value", () => {
    const ds = makeDemoDataset(parsePenetranceCsv(real, META).records);
    expect(ds.synthetic).toBe(true);
    for (const rec of ds.records) {
      const ages = rec.ages!;
      expect(ages[0].pct).toBeCloseTo(0);
      expect(ages[ages.length - 1].pct).toBeCloseTo(rec.pct);
      for (let i = 1; i < ages.length; i++) expect(ages[i].pct).toBeGreaterThanOrEqual(ages[i - 1].pct);
    }
  });
});

import { findRecords, parseLocus } from "@/lib/penetrance/lookup";

describe("lookup", () => {
  const records = parsePenetranceCsv(real, META).records;

  it("parses loci", () => {
    expect(parseLocus("chr13:g.32340300G>T")).toEqual({ chr: "13", pos: 32340300, ref: "G", alt: "T" });
    expect(parseLocus("13:32340300")).toEqual({ chr: "13", pos: 32340300, ref: undefined, alt: undefined });
    expect(parseLocus("X-67723690-C-T")?.alt).toBe("T");
    expect(parseLocus("BRAF p.V600E")).toBeUndefined();
    expect(parseLocus("rs80359550")).toBeUndefined();
  });

  it("finds by rsID (case-insensitive) and by locus", () => {
    expect(findRecords(records, { rsid: "RS80359550" }).matches.length).toBeGreaterThan(0);
    const byLocus = findRecords(records, { locus: parseLocus("13:32340300") });
    expect(byLocus.by).toBe("locus");
    expect(byLocus.matches[0].rsid).toBe("rs80359550");
    expect(findRecords(records, { rsid: "rs1" }).matches).toEqual([]);
  });
});

import { proteinFormsFor } from "@/lib/clinvar/forms";
import { cleanTitle } from "@/lib/text";

describe("clinvar protein forms", () => {
  it("strips accessions and adds the ClinVar fs abbreviation", () => {
    const forms = proteinFormsFor("NP_000050.3:p.Ser1982ArgfsTer22");
    expect(forms).toContain("p.Ser1982fs");
    expect(forms).toContain("Ser1982ArgfsTer22");
    expect(forms.some((f) => f.includes("NP_"))).toBe(false);
  });
  it("keeps simple substitutions", () => {
    expect(proteinFormsFor("p.Gly12Asp")).toEqual(["Gly12Asp", "p.Gly12Asp"]);
  });
});

describe("cleanTitle", () => {
  it("decodes entities and strips tags", () => {
    expect(cleanTitle("&lt;i&gt;BRCA1&lt;/i&gt; &amp; BRCA2")).toBe("BRCA1 & BRCA2");
  });
});

import { pickHeadline, stripAccession, toOneLetter } from "@/lib/variant/headline";

describe("variant headline", () => {
  it("strips accessions and converts to one-letter", () => {
    expect(stripAccession("NP_000050.3:p.Ser1982ArgfsTer22")).toBe("p.Ser1982ArgfsTer22");
    expect(toOneLetter("p.Ser1982ArgfsTer22")).toBe("p.S1982Rfs*22");
    expect(toOneLetter("p.Gly12Asp")).toBe("p.G12D");
    expect(toOneLetter("p.Arg175His")).toBe("p.R175H");
  });
  it("prefers the MANE Select transcript", () => {
    const h = pickHeadline({
      input: "x",
      classified: {},
      canonical: { gene: "BRCA2", rsid: "rs1", hgvsg: "g", consequences: [] },
      groups: {
        perTranscript: [
          { transcript: "NM_2", hgvsp: "NP_2:p.Gly1Ala" },
          { transcript: "NM_1", hgvsp: "NP_1:p.Ser2Thr", hgvsc: "NM_1:c.4A>T", isManeSelect: true, consequenceTerms: ["missense_variant"] },
        ],
      },
    });
    expect(h).toMatchObject({ gene: "BRCA2", protein: "p.Ser2Thr", proteinShort: "p.S2T", cdna: "NM_1:c.4A>T", consequence: "missense variant" });
  });
});

import { sigClass, topSignificance } from "@/lib/clinvar/significance";

describe("indel locus + allele narrowing", () => {
  const records = parsePenetranceCsv(real, META).records;
  it("matches a VEP-style deletion to the VCF-anchored record", () => {
    const l = parseLocus("chr13:g.32340301T>-");
    expect(l).toEqual({ chr: "13", pos: 32340301, ref: "T", alt: "-" });
    expect(findRecords(records, { locus: l }).matches[0]?.rsid).toBe("rs80359550");
  });
  it("narrows a multi-allelic rsID to the searched allele", () => {
    const both = findRecords(records, { rsid: "rs80359351" }).matches;
    expect(both).toHaveLength(2);
    const one = findRecords(records, { rsid: "rs80359351", locus: parseLocus("13:32337161:AAAC:-") }).matches;
    expect(one).toHaveLength(1);
    expect(one[0].alt).toBe("T");
  });
});

describe("clinvar significance", () => {
  it("ranks conflicting as uncertain, not pathogenic", () => {
    expect(sigClass("Conflicting classifications of pathogenicity")).toBe("sig-vus");
    expect(sigClass("Pathogenic/Likely pathogenic")).toBe("sig-path");
    expect(sigClass("Likely pathogenic")).toBe("sig-lpath");
    expect(sigClass("Benign/Likely benign")).toBe("sig-benign");
    expect(topSignificance([{ clinicalSignificance: "Conflicting classifications of pathogenicity" }, { clinicalSignificance: "Likely pathogenic" }])?.cls).toBe("sig-lpath");
  });
});

describe("parser edge cases", () => {
  const H = "Disease,CHR,POS,REF,ALT,rsID,Individuals with variants n,ICD-10 affected individuals with variants n";
  it("skips rows with blank numeric cells", () => {
    expect(parsePenetranceCsv(`${H}\nD,1,,A,G,rs1,10,1\nD,1,5,A,G,rs2,,0\n`, META).records).toHaveLength(0);
  });
  it("warns on repeated variant rows", () => {
    const ds = parsePenetranceCsv(`${H}\nD,1,5,A,G,rs1,10,1\nD,1,5,A,G,rs1,10,2\n`, META);
    expect(ds.records).toHaveLength(1);
    expect(ds.warnings.join()).toMatch(/repeats/);
  });
  it("takes the carrier count from the oldest age row", () => {
    const csv = `${H},Age\nD,1,5,A,G,rs1,100,2,40\nD,1,5,A,G,rs1,60,6,80\n`;
    const [rec] = parsePenetranceCsv(csv, META).records;
    expect(rec.carriers).toBe(60);
    expect(rec.affected).toBe(6);
  });
});
