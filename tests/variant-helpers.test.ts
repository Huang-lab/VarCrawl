import { describe, expect, it } from "vitest";
import { proteinFormsFor } from "@/lib/clinvar/forms";
import { sigClass, topSignificance } from "@/lib/clinvar/significance";
import { cleanTitle } from "@/lib/text";
import { pickHeadline, stripAccession, toOneLetter } from "@/lib/variant/headline";

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

describe("clinvar significance", () => {
  it("ranks conflicting as uncertain, not pathogenic", () => {
    expect(sigClass("Conflicting classifications of pathogenicity")).toBe("sig-vus");
    expect(sigClass("Pathogenic/Likely pathogenic")).toBe("sig-path");
    expect(sigClass("Likely pathogenic")).toBe("sig-lpath");
    expect(sigClass("Benign/Likely benign")).toBe("sig-benign");
    expect(topSignificance([{ clinicalSignificance: "Conflicting classifications of pathogenicity" }, { clinicalSignificance: "Likely pathogenic" }])?.cls).toBe("sig-lpath");
  });
});
