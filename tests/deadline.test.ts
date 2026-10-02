import { afterEach, describe, expect, it, vi } from "vitest";
import { searchPhrasesInDbWithDiagnostics } from "@/lib/entrez/base";
import { searchEuropePmcForVariantsDetailed } from "@/lib/pubmed/europepmc";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("soft deadline", () => {
  it("skips unstarted PubMed phrases after the deadline and reports partial", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await searchPhrasesInDbWithDiagnostics("pubmed", ["a", "b", "c"], { deadline: Date.now() - 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.matched.size).toBe(0);
    expect(res.diagnostics.failedPhraseCount).toBe(3);
    expect(res.diagnostics.likelyPartial).toBe(true);
  });

  it("skips unstarted Europe PMC phrases after the deadline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await searchEuropePmcForVariantsDetailed(["a", "b"], { deadline: Date.now() - 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.diagnostics.likelyPartial).toBe(true);
  });
});
