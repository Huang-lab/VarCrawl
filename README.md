# VarCrawl

Powered by the Huang Lab at Mount Sinai (<https://labs.icahn.mssm.edu/kuanhuanglab/>).

GitHub: <https://github.com/Huang-lab/VarCrawl>

A serverless web app for searching PubMed, Europe PMC, and ClinVar by mutation. Paste a
mutation in any common notation (HGVSp, HGVSc, HGVSg, short forms like `V600E`,
`BRAF p.V600E`, dbSNP rsIDs) and the app expands it into every string
representation the mutation might appear under in the literature, groups them
by transcript/isoform (with MANE Select / MANE Plus Clinical badges), and
searches PubMed (Entrez), Europe PMC, and ClinVar for each as an exact phrase.

## Stack

- **Next.js 14 (app router)** — deploys to Vercel as static UI + route handlers.
- **Ensembl VEP REST** (`rest.ensembl.org`, `grch37.rest.ensembl.org`) for
  HGVSp ↔ HGVSc ↔ HGVSg cross-conversion across transcripts.
- **Mutalyzer** (`mutalyzer.nl/api`) as an HGVS normalizer (best-effort).
- **NCBI Variation Services** as a RefSeq-aware fallback (best-effort).
- **NCBI Entrez E-utilities** (`eutils.ncbi.nlm.nih.gov`) for PubMed search.
- **Europe PMC REST API** (`ebi.ac.uk/europepmc`) for supplemental literature recall.
- **Upstash Redis** (optional) for caching.

## Genome assemblies
GRCh38 and GRCh37 are fully supported via the two Ensembl REST endpoints.

## Getting started

```bash
pnpm install      # or npm install / yarn
cp .env.example .env.local
# add NCBI_API_KEY + NCBI_EMAIL for 10 req/s PubMed throughput
pnpm dev
```

Open <http://localhost:3000>.

## API

### `POST /api/search`

```json
{ "query": "BRAF p.V600E", "assembly": "GRCh38" }
```

Expands the mutation and searches every source in a single request, returning
the expansion (`classified`, `canonical`, `groups`, `variants`), the phrase
lists actually searched (`searchTerms`), and both result sets (`pubmed`,
`clinvar`). This is what the UI calls.

Doing all of it in one request is what makes the PubMed and ClinVar searches
safe to run concurrently: they share this process's Entrez rate limiter. Split
across separate HTTP requests they can land on different serverless instances,
each assuming the whole NCBI quota.

The endpoints below remain available for programmatic use.

### `POST /api/expand`

```json
{ "query": "BRAF p.V600E", "assembly": "GRCh38" }
```

Returns the classified input, canonical variant, and an array of every string
representation to search on.

### `POST /api/pubmed`

```json
{ "variants": ["V600E", "p.Val600Glu", "c.1799T>A", "chr7:g.140753336A>T"] }
```

Runs one phrase query per variant against PubMed and Europe PMC, unions PMIDs,
batches PubMed `esummary` metadata, and returns merged articles sorted by best
match (more matched representations first; recency as tie-breaker) with
per-article `matchedBy` attribution and source labels.

### `POST /api/clinvar`

Same shape as `/api/pubmed` but queries NCBI `db=clinvar`. Returns ClinVar
records with germline classification, review status, and conditions, sorted
by clinical significance (Pathogenic → Likely Pathogenic → VUS → …).

## How it works

1. **Input classification (`lib/hgvs/classify.ts`)**
  - Detects whether a query looks like protein/cDNA/genomic HGVS, short forms
    (e.g. `V600E`), gene+variant forms, or dbSNP rsIDs.

2. **Canonicalization + cross-conversion (`lib/hgvs/convert.ts`)**
  - Resolves a canonical variant using Ensembl VEP (plus fallbacks), then
    converts across HGVSp ↔ HGVSc ↔ HGVSg and across GRCh38/GRCh37 when possible.

3. **Variant enumeration (`lib/hgvs/enumerate.ts`)**
  - Expands one canonical event into many searchable strings:
    bare/with-prefix HGVS, gene-prefixed forms, one-letter and three-letter
    protein forms, transcript-specific forms, and rsID/genomic coordinate forms.
  - Groups by transcript so MANE Select / MANE Plus Clinical forms are explicit.

4. **PubMed retrieval (`lib/pubmed/entrez.ts`, `lib/entrez/base.ts`)**
  - Executes one exact-phrase Entrez `esearch` per representation.
  - Unions PMIDs across all phrases and tracks `matchedBy` attribution.
  - Fetches metadata in `esummary` batches.
  - Ranks by **best match** (more matched representations first), then by date.

5. **ClinVar retrieval + filtering (`lib/clinvar/entrez.ts`, `lib/clinvar/filter.ts`)**
  - Same phrase-union pattern on `db=clinvar`.
  - Applies gene/protein-form filtering to reduce off-target records.
  - Sorts by clinical significance priority.

6. **Upstream pacing (`lib/entrez/scheduler.ts`)**
  - Every outbound Entrez / Europe PMC call passes through a token-bucket
    limiter with a concurrency ceiling, shared process-wide so that the PubMed
    and ClinVar searches draw on one budget.
  - Tokens accrue at the published rate while several requests stay in flight,
    so round-trip latency overlaps instead of accumulating across the ~50
    representations a search expands into.
  - A retry waits for its own token before going out, so a burst of retries
    during an upstream wobble cannot push the rate over the limit. It waits on
    a token only, never a second concurrency slot, since it already holds one.
  - An upstream `Retry-After` is honoured up to a ceiling: NCBI can ask for
    longer than the whole function budget, and waiting that long guarantees the
    caller gets nothing rather than a partial result.

7. **Resilience controls (`lib/ratelimit.ts`, `lib/cache.ts`)**
  - Per-client rate limiting (optional Upstash Redis).
  - Response caching (optional Upstash Redis) for repeated variant lookups.
  - Per-request timeouts, so one hung upstream call cannot consume the whole
    serverless function budget.
  - Source diagnostics mark likely partial/rate-limited upstream retrievals.

## Penetrance and literature in one search

One search box takes an rsID, HGVS, or gene + change.
The result page shows a summary (variant, penetrance, ClinVar, literature count), then a penetrance card with 100-person icon arrays for ICD-10 and clinical algorithm definitions, then ClinVar and PubMed/Europe PMC results.
Penetrance is matched by rsID, or by GRCh38 position.
Each estimate has a 95% Wilson confidence range, and variants with fewer than 30 carriers are flagged.

Data is bundled in `public/data/etable4_penetrance.csv` (lifetime penetrance, all ages) and you can upload your own CSV with the same columns.
Add an `Age` column to provide age-specific data: rows sharing a variant form a cumulative penetrance curve, and the card shows an age slider and chart.
The "Demo: age-specific" dataset is synthetic and illustrative only.

## Performance

A search over the full 50-representation budget issues ~110 NCBI requests plus
~50 to Europe PMC. Running those serially with a fixed pause between each — one
request in flight at a time — achieved roughly 2.5 req/s of NCBI's 10 req/s
allowance, because the round-trip, not the quota, set the pace. A common query
took most of the 60s function ceiling and any upstream slowness pushed it over.

Against a simulated upstream at a 300ms round-trip
(`tests/search-throughput.test.ts`), the same work now completes in ~14s
instead of ~45s, with a measured peak of 10 req/s — NCBI's documented ceiling
with an API key, and no higher. The rate holds under failure too: with every
phrase returning 503 and each retrying twice, the measured peak is 9 req/s.

A partial or rate-limited result is cached for a minute rather than six hours,
so the retry its status message advises actually reaches NCBI again.

Note the scope of that guarantee: the limiter is per server instance, and
NCBI's quota is per API key. A deployment running several instances
concurrently can still exceed the rate in aggregate, so the defaults leave
headroom and `Retry-After` on a 429 remains the backstop.

## Sharing and export

- Searches are deep-linkable: `/?q=BRAF%20p.V600E&assembly=GRCh38` reruns the
  search on load, and browser back/forward moves between searches.
- Results export to CSV — articles, ClinVar records, and the full list of
  searched representations — for supplementary tables. Fields are quoted per
  RFC 4180 and values beginning `=`, `+`, `-` or `@` are prefixed so a
  spreadsheet reads them as text rather than formulas.

## Testing

```bash
pnpm test
```

Vitest covers the input classifier, the variant enumerator (including
consequence attribution when VEP returns duplicate or missing transcript ids),
search-term construction, CSV export, the cache wrapper, the rate limiter, and
an end-to-end throughput test that asserts both the latency budget and rate
compliance against a simulated upstream.

`lib/hgvs/convert.ts` still depends on live Ensembl VEP and is exercised
manually.

## Deployment (Vercel)

1. Import the repo on Vercel.
2. Set env vars: `NCBI_API_KEY`, `NCBI_EMAIL` (and optionally Upstash vars).
3. Deploy — no other config needed.
