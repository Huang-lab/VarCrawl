import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/cache.ts reads its Upstash config at module load, so each test imports a
 * fresh copy with the env already in place.
 */
async function loadCache(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("@/lib/cache");
}

const UPSTASH = {
  UPSTASH_REDIS_REST_URL: "https://cache.example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

describe("cacheSet", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the payload in the request body, keeping the URL small", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response("{\"result\":\"OK\"}", { status: 200 });
      }),
    );

    const { cacheSet } = await loadCache(UPSTASH);

    // A realistic /api/pubmed response: 200 articles.
    const big = {
      count: 200,
      articles: Array.from({ length: 200 }, (_, i) => ({
        pmid: String(20000000 + i),
        title: "Clinical characterization of BRAF V600E in metastatic melanoma",
        authors: Array.from({ length: 10 }, (_, a) => `Author ${a} ${i}`),
        journal: "Journal of Clinical Oncology",
        pubDate: "2023 Jun 15",
        matchedBy: ["V600E", "p.Val600Glu", "BRAF V600E"],
      })),
    };

    await expect(cacheSet("pubmed:abc", big, 3600)).resolves.toBe(true);
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0];
    expect(init?.method).toBe("POST");
    // The payload must not be in the URL: it would blow past the ~8 KB
    // request-line limit that proxies enforce.
    expect(url.length).toBeLessThan(200);
    expect(url).toContain("/set/");
    expect(url).toContain("EX=3600");
    expect(String(init?.body)).toBe(JSON.stringify(big));
    expect(String(init?.body).length).toBeGreaterThan(8192);
  });

  it("reports failure when Upstash rejects the write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("too large", { status: 413 })),
    );
    const { cacheSet } = await loadCache(UPSTASH);
    await expect(cacheSet("k", { a: 1 })).resolves.toBe(false);
  });

  it("swallows network errors rather than failing the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { cacheSet } = await loadCache(UPSTASH);
    await expect(cacheSet("k", { a: 1 })).resolves.toBe(false);
  });

  it("skips writes above the size ceiling instead of failing them upstream", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { cacheSet } = await loadCache({ ...UPSTASH, CACHE_MAX_VALUE_BYTES: "1000" });
    await expect(cacheSet("k", { blob: "x".repeat(5000) })).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when Upstash is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { cacheSet, cacheGet } = await loadCache({
      UPSTASH_REDIS_REST_URL: undefined,
      UPSTASH_REDIS_REST_TOKEN: undefined,
    });
    await expect(cacheSet("k", { a: 1 })).resolves.toBe(false);
    await expect(cacheGet("k")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cacheGet", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("round-trips a stored value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ result: JSON.stringify({ count: 2 }) }), { status: 200 }),
      ),
    );
    const { cacheGet } = await loadCache(UPSTASH);
    await expect(cacheGet<{ count: number }>("k")).resolves.toEqual({ count: 2 });
  });

  it("returns null for a miss and for malformed stored JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: null }), { status: 200 })),
    );
    const { cacheGet } = await loadCache(UPSTASH);
    await expect(cacheGet("miss")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ result: "{not json" }), { status: 200 })),
    );
    const mod = await loadCache(UPSTASH);
    await expect(mod.cacheGet("bad")).resolves.toBeNull();
  });
});

describe("hash", () => {
  it("is stable and distinguishes similar variant queries", async () => {
    const { hash } = await loadCache({});
    expect(hash({ q: "BRAF V600E" })).toBe(hash({ q: "BRAF V600E" }));
    expect(hash({ q: "BRAF V600E" })).not.toBe(hash({ q: "BRAF V600K" }));
    expect(hash(["V600E"])).not.toBe(hash(["V600D"]));
    // Key-order differences in the input object are a genuine difference in
    // JSON.stringify output; what matters is that equal inputs agree.
    expect(hash({ a: 1, b: 2 })).toBe(hash({ a: 1, b: 2 }));
  });

  it("has no collisions across a large synthetic variant space", async () => {
    const { hash } = await loadCache({});
    const seen = new Map<string, string>();
    const aas = "ACDEFGHIKLMNPQRSTVWY".split("");
    let collisions = 0;
    let n = 0;
    for (const gene of ["BRAF", "KRAS", "TP53", "EGFR", "PIK3CA", "BRCA1", "BRCA2"]) {
      for (let pos = 1; pos <= 400; pos++) {
        for (const ref of aas.slice(0, 6)) {
          for (const alt of aas.slice(0, 6)) {
            const key = `${gene} ${ref}${pos}${alt}`;
            const h = hash({ variants: [key], gene });
            n += 1;
            const prev = seen.get(h);
            if (prev !== undefined && prev !== key) collisions += 1;
            else seen.set(h, key);
          }
        }
      }
    }
    expect(n).toBeGreaterThan(100000);
    expect(collisions).toBe(0);
  });
});
