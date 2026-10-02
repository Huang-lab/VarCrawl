import { describe, expect, it } from "vitest";
import { compareArticles, mergeArticles, pubDateRank } from "@/lib/search/results";
import type { Article } from "@/lib/search/results";

const article = (over: Partial<Article> = {}): Article => ({
  pmid: "1",
  title: "t",
  authors: [],
  journal: "",
  pubDate: "",
  matchedBy: [],
  ...over,
});

describe("pubDateRank", () => {
  it("reads ISO dates at day resolution, as Europe PMC supplies them", () => {
    expect(pubDateRank("2023-12-15")).toBe(Date.UTC(2023, 11, 15));
    expect(pubDateRank("2023-01-02")).toBe(Date.UTC(2023, 0, 2));
    expect(pubDateRank("2023-12")).toBe(Date.UTC(2023, 11, 1));
  });

  it("reads the PubMed 'YYYY Mon DD' shape", () => {
    expect(pubDateRank("2023 Jun 15")).toBe(Date.UTC(2023, 5, 15));
    expect(pubDateRank("2023 Jun")).toBe(Date.UTC(2023, 5, 1));
    expect(pubDateRank("2023")).toBe(Date.UTC(2023, 0, 1));
    expect(pubDateRank("2023 December 1")).toBe(Date.UTC(2023, 11, 1));
  });

  it("orders an ISO December above a PubMed February of the same year", () => {
    // The regression: the PubMed pattern matches only the year of an ISO
    // string, so 2023-12-15 used to rank as 2023-01-01 and sort below Feb.
    expect(pubDateRank("2023-12-15")).toBeGreaterThan(pubDateRank("2023 Feb 3"));
  });

  it("sorts empty and unparseable dates last", () => {
    expect(pubDateRank(undefined)).toBe(0);
    expect(pubDateRank("")).toBe(0);
    expect(pubDateRank("   ")).toBe(0);
    expect(pubDateRank("in press")).toBe(0);
  });
});

describe("compareArticles", () => {
  it("ranks more matched representations first", () => {
    const a = article({ pmid: "a", matchedBy: ["x", "y"] });
    const b = article({ pmid: "b", matchedBy: ["x"] });
    expect([b, a].sort(compareArticles).map((x) => x.pmid)).toEqual(["a", "b"]);
  });

  it("breaks ties by recency across both date formats", () => {
    const older = article({ pmid: "old", pubDate: "2019 Mar 2", matchedBy: ["x"] });
    const newer = article({ pmid: "new", pubDate: "2023-12-15", matchedBy: ["x"] });
    expect([older, newer].sort(compareArticles).map((x) => x.pmid)).toEqual(["new", "old"]);
  });
});

describe("mergeArticles", () => {
  it("unions sources and matchedBy for a PMID found in both indexes", () => {
    const merged = mergeArticles(
      [article({ pmid: "1", title: "From PubMed", matchedBy: ["V600E"], journal: "Nature" })],
      [article({ pmid: "1", title: "From EPMC", matchedBy: ["p.Val600Glu"], doi: "10.1/x" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("From PubMed");
    expect(merged[0].journal).toBe("Nature");
    expect(merged[0].doi).toBe("10.1/x");
    expect(merged[0].matchedBy.sort()).toEqual(["V600E", "p.Val600Glu"]);
    expect(merged[0].sources?.sort()).toEqual(["Europe PMC", "PubMed"]);
  });

  it("fills missing PubMed metadata from Europe PMC", () => {
    const merged = mergeArticles(
      [article({ pmid: "1", title: "", authors: [], journal: "", pubDate: "" })],
      [
        article({
          pmid: "1",
          title: "EPMC title",
          authors: ["Smith JA"],
          journal: "Cell",
          pubDate: "2023-12-15",
        }),
      ],
    );
    expect(merged[0].title).toBe("EPMC title");
    expect(merged[0].authors).toEqual(["Smith JA"]);
    expect(merged[0].journal).toBe("Cell");
    expect(merged[0].pubDate).toBe("2023-12-15");
  });

  it("keeps Europe PMC-only articles and labels their source", () => {
    const merged = mergeArticles([], [article({ pmid: "9", matchedBy: ["x"] })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toEqual(["Europe PMC"]);
  });
});
