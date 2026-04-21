"use client";

import { useState } from "react";
import { SearchForm } from "@/components/SearchForm";
import { VariantPanel } from "@/components/VariantPanel";
import { ResultsList } from "@/components/ResultsList";
import { ClinvarResults } from "@/components/ClinvarResults";
import type { Assembly } from "@/lib/hgvs/types";

interface VariantString { text: string; label: string }

interface TranscriptGroup {
  gene?: string;
  transcript?: string;
  proteinAccession?: string;
  hgvsc?: string;
  hgvsp?: string;
  consequenceTerms?: string[];
  isManeSelect?: boolean;
  isManePlusClinical?: boolean;
  isCanonical?: boolean;
  maneSelectName?: string;
  variants: VariantString[];
}

interface ExpandResponse {
  input: string;
  assembly: Assembly;
  classified: { kind: string; gene?: string; accession?: string; body: string; proteinShort?: string; proteinLong?: string };
  canonical: {
    gene?: string;
    rsid?: string;
    hgvsg?: string;
    notes: string[];
    consequences: { gene?: string; hgvsc?: string; hgvsp?: string; proteinShort?: string; proteinLong?: string }[];
  };
  groups: {
    universal: VariantString[];
    perTranscript: TranscriptGroup[];
    fallback: VariantString[];
  };
  variants: VariantString[];
}

interface PubmedResponse {
  count: number;
  status?: SourceStatus;
  articles: {
    pmid: string;
    title: string;
    authors: string[];
    journal: string;
    pubDate: string;
    doi?: string;
    matchedBy: string[];
  }[];
}

interface ClinvarResponse {
  count: number;
  unfilteredCount?: number;
  gene?: string;
  proteinForms?: string[];
  status?: SourceStatus;
  records: {
    uid: string;
    accession?: string;
    title?: string;
    gene?: string;
    clinicalSignificance?: string;
    reviewStatus?: string;
    lastEvaluated?: string;
    conditions: string[];
    matchedBy: string[];
  }[];
}

interface SourceStatus {
  complete: boolean;
  likelyRateLimited: boolean;
  likelyPartial: boolean;
  message?: string;
}

function buildProteinForms(expand: ExpandResponse): string[] {
  const out = new Set<string>();
  const push = (s?: string) => {
    if (!s) return;
    const bare = s.replace(/^p\./i, "");
    if (!bare) return;
    out.add(bare);
    out.add(`p.${bare}`);
  };
  push(expand.classified.proteinShort);
  push(expand.classified.proteinLong);
  for (const c of expand.canonical.consequences) {
    push(c.proteinShort);
    push(c.proteinLong);
  }
  return Array.from(out);
}

function collectClientSideVariants(expand: ExpandResponse): string[] {
  const out = new Set<string>();
  for (const v of expand.groups.universal) {
    if (v.text?.trim()) out.add(v.text.trim());
  }
  for (const group of expand.groups.perTranscript) {
    for (const v of group.variants) {
      if (v.text?.trim()) out.add(v.text.trim());
    }
  }
  for (const v of expand.groups.fallback) {
    if (v.text?.trim()) out.add(v.text.trim());
  }
  return Array.from(out);
}

function rankPubmedTerm(term: string, ctx: { rawInput: string; gene?: string; transcripts: string[] }): number {
  const t = term.trim();
  const lower = t.toLowerCase();
  const raw = ctx.rawInput.trim().toLowerCase();

  if (lower === raw) return 0;
  if (/^rs\d+$/i.test(t)) return 1;
  if (/^(?:chr)?(?:[0-9]{1,2}|x|y|m|mt):g\./i.test(t)) return 1;
  if (/^[A-Z]{2,4}_[0-9]+(?:\.[0-9]+)?:g\./i.test(t)) return 1;

  if (ctx.gene) {
    const escapedGene = ctx.gene.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escapedGene}\\b`, "i").test(t)) return 2;
  }

  if (ctx.transcripts.some((tx) => t.includes(tx))) return 3;
  return 4;
}

function isProteinOrCdnaOnly(kind: string): boolean {
  return kind === "short" || kind === "hgvsp" || kind === "hgvsc";
}

function hasGeneSymbol(term: string, gene?: string): boolean {
  if (!gene) return false;
  const escaped = gene.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(term);
}

function buildPubmedSearchTerms(expand: ExpandResponse): string[] {
  const baseVariants = collectClientSideVariants(expand);
  const rawInput = expand.input;
  const gene = expand.canonical.gene ?? expand.classified.gene;
  const escapedGene = gene ? gene.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : undefined;
  const transcripts = Array.from(
    new Set(
      expand.groups.perTranscript
        .map((g) => g.transcript)
        .filter((t): t is string => Boolean(t && t.trim()))
        .map((t) => t.trim()),
    ),
  );
  const coordinateOnly =
    expand.classified.kind === "hgvsg" &&
    !gene &&
    transcripts.length === 0;
  const requireGeneContext = isProteinOrCdnaOnly(expand.classified.kind);

  if (coordinateOnly) {
    return Array.from(new Set(baseVariants));
  }

  const withContext: string[] = [];

  const shouldAddTranscriptContext = (variant: string): boolean => {
    // Transcript-prefixing only helps for bare HGVS c./p. forms.
    return /^c\./i.test(variant) || /^p\./i.test(variant);
  };

  for (const v of baseVariants) {
    const hasGene = !!escapedGene && new RegExp(`\\b${escapedGene}\\b`, "i").test(v);
    const hasTranscript = transcripts.some((t) => v.includes(t));
    if (!hasGene && gene) withContext.push(`${gene} ${v}`);
    if (!hasTranscript && shouldAddTranscriptContext(v)) {
      for (const tx of transcripts.slice(0, 6)) {
        withContext.push(`${tx} ${v}`);
      }
    }
  }

  // Keep strongest terms first — API trims to 50.
  // Priority: exact user input > direct genomic/rsID > gene-qualified > transcript-qualified > others.
  const merged = Array.from(new Set([...baseVariants, ...withContext]));
  const ranked = merged.sort((a, b) => {
    const ra = rankPubmedTerm(a, { rawInput, gene, transcripts });
    const rb = rankPubmedTerm(b, { rawInput, gene, transcripts });
    if (ra !== rb) return ra - rb;
    return a.length - b.length;
  });

  if (requireGeneContext && gene) {
    const geneOnly = ranked.filter((term) => hasGeneSymbol(term, gene));
    if (geneOnly.length > 0) return geneOnly;
  }

  return ranked;
}

export default function Page() {
  const [expand, setExpand] = useState<ExpandResponse | null>(null);
  const [pubmed, setPubmed] = useState<PubmedResponse | null>(null);
  const [clinvar, setClinvar] = useState<ClinvarResponse | null>(null);
  const [loading, setLoading] = useState<"idle" | "expanding" | "searching">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(query: string, assembly: Assembly) {
    setError(null);
    setExpand(null);
    setPubmed(null);
    setClinvar(null);
    setLoading("expanding");

    try {
      const r1 = await fetch("/api/expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, assembly }),
      });
      const d1 = await r1.json();
      if (!r1.ok) {
        if (r1.status === 429) {
          const retry = r1.headers.get("Retry-After");
          setError(
            retry
              ? `Too many requests — try again in ${retry}s.`
              : "Too many requests — please slow down and try again shortly.",
          );
        } else {
          setError(d1.error ?? "Failed to expand mutation.");
        }
        setLoading("idle");
        return;
      }
      setExpand(d1);

      setLoading("searching");
      const baseVariants = collectClientSideVariants(d1);
      const pubmedVariants = buildPubmedSearchTerms(d1);
      const clinvarVariants = baseVariants;
      const gene = d1.canonical.gene ?? d1.classified.gene;
      const proteinForms = buildProteinForms(d1);
      const requiresGeneForLiterature = isProteinOrCdnaOnly(d1.classified.kind);
      const skipLiteratureSearch = requiresGeneForLiterature && !gene;

      // ClinVar first, then PubMed — both hit NCBI Entrez, so running them
      // sequentially avoids doubling per-user API usage.
      const [clinvarRes] = await Promise.allSettled([
        fetch("/api/clinvar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variants: clinvarVariants, gene, proteinForms }),
        }).then(async (r) => ({ status: r.status, retryAfter: r.headers.get("Retry-After"), body: await r.json() })),
      ]);

      const [pubmedRes] = await Promise.allSettled([
        skipLiteratureSearch
          ? Promise.resolve({
              status: 200,
              retryAfter: null,
              body: {
                count: 0,
                articles: [],
                status: {
                  complete: false,
                  likelyRateLimited: false,
                  likelyPartial: false,
                  message:
                    "PubMed/PMC search skipped: amino-acid or cDNA-only queries require a gene symbol (e.g. TP53 R175H, BRCA1 c.68_69delAG).",
                },
              },
            })
          : fetch("/api/pubmed", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ variants: pubmedVariants }),
            }).then(async (r) => ({ status: r.status, retryAfter: r.headers.get("Retry-After"), body: await r.json() })),
      ]);

      const explain = (label: string, v: { status: number; retryAfter: string | null; body: { error?: string } }): string => {
        if (v.status === 429) {
          return v.retryAfter
            ? `${label}: too many requests — try again in ${v.retryAfter}s.`
            : `${label}: too many requests — please slow down.`;
        }
        return `${label}: ${v.body.error ?? "error"}`;
      };

      if (pubmedRes.status === "fulfilled" && !pubmedRes.value.body.error) {
        setPubmed(pubmedRes.value.body as PubmedResponse);
      } else if (pubmedRes.status === "fulfilled") {
        if (pubmedRes.value.status === 429) {
          const status: SourceStatus = pubmedRes.value.body?.status ?? {
            complete: false,
            likelyRateLimited: true,
            likelyPartial: true,
            message: "PubMed may be incomplete due to NCBI rate limiting. Please retry shortly.",
          };
          setPubmed({ count: 0, articles: [], status });
        } else {
          setError((e) => e ?? explain("PubMed", pubmedRes.value));
        }
      }

      if (clinvarRes.status === "fulfilled" && !clinvarRes.value.body.error) {
        setClinvar(clinvarRes.value.body as ClinvarResponse);
      } else if (clinvarRes.status === "fulfilled") {
        if (clinvarRes.value.status === 429) {
          const status: SourceStatus = clinvarRes.value.body?.status ?? {
            complete: false,
            likelyRateLimited: true,
            likelyPartial: true,
            message: clinvarRes.value.retryAfter
              ? `ClinVar request rate-limited. Retry in ${clinvarRes.value.retryAfter}s.`
              : "ClinVar request rate-limited. Retry shortly.",
          };
          setClinvar({
            count: 0,
            unfilteredCount: 0,
            gene,
            proteinForms,
            records: [],
            status,
          });
        } else {
          setError((e) => e ?? explain("ClinVar", clinvarRes.value));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading("idle");
    }
  }

  return (
    <main>
      <h1>VarCrawl</h1>
      <p className="subtitle">
        Paste a mutation in any HGVS-like notation. We expand it into every way and search PubMed, Europe PMC, and ClinVar for you.
      </p>
      <p className="subtitle" style={{ marginTop: -16 }}>
        Powered by the Huang Lab at Mount Sinai (
        <a href="https://labs.icahn.mssm.edu/kuanhuanglab/" target="_blank" rel="noopener noreferrer">
          labs.icahn.mssm.edu/kuanhuanglab
        </a>
        ) · GitHub (
        <a href="https://github.com/Huang-lab/VarCrawl" target="_blank" rel="noopener noreferrer">
          github.com/Huang-lab/VarCrawl
        </a>
        )
      </p>

      <div className="panel how-it-works" aria-label="How VarCrawl works">
        <h2>How it works</h2>
        <ol>
          <li>Classify your query, canonicalize it, and generate transcript-aware variant representations.</li>
          <li>Run exact-phrase searches per representation in PubMed/Europe PMC and ClinVar, merge PMIDs/ClinVar IDs, and track matched forms.</li>
          <li>Rank PubMed by best match (with recency tie-breaker) and flag likely incomplete upstream results.</li>
        </ol>
      </div>

      <SearchForm onSearch={handleSearch} disabled={loading !== "idle"} />

      {error && <div className="error">{error}</div>}

      {loading === "expanding" && <p className="spinner">Expanding mutation representations…</p>}
      {expand && <VariantPanel data={expand} />}

      {loading === "searching" && <p className="spinner">Searching PubMed, Europe PMC, and ClinVar…</p>}
      {clinvar && <ClinvarResults data={clinvar} />}
      {pubmed && <ResultsList data={pubmed} />}
    </main>
  );
}
