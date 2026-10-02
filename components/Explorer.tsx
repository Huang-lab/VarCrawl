"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchForm } from "@/components/SearchForm";
import { VariantPanel } from "@/components/VariantPanel";
import { VariantHeader } from "@/components/VariantHeader";
import { ResultsList } from "@/components/ResultsList";
import { ClinvarResults } from "@/components/ClinvarResults";
import { ExportBar } from "@/components/ExportBar";
import { DataSource } from "@/components/penetrance/DataSource";
import { PenetranceCard } from "@/components/penetrance/PenetranceCard";
import { useDatasets } from "@/components/penetrance/useDatasets";
import { topSignificance } from "@/lib/clinvar/significance";
import type { Assembly } from "@/lib/hgvs/types";
import { findRecords, parseLocus } from "@/lib/penetrance/lookup";
import { formatPct } from "@/lib/penetrance/stats";
import { pickHeadline } from "@/lib/variant/headline";

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

interface SourceStatus {
  complete: boolean;
  likelyRateLimited: boolean;
  likelyPartial: boolean;
  message?: string;
}

interface ExpandPart {
  input: string;
  assembly: Assembly;
  classified: {
    kind: string;
    gene?: string;
    accession?: string;
    body: string;
    proteinShort?: string;
    proteinLong?: string;
  };
  canonical: {
    gene?: string;
    rsid?: string;
    hgvsg?: string;
    notes: string[];
    consequences: {
      gene?: string;
      hgvsc?: string;
      hgvsp?: string;
      proteinShort?: string;
      proteinLong?: string;
    }[];
  };
  groups: {
    universal: VariantString[];
    perTranscript: TranscriptGroup[];
    fallback: VariantString[];
  };
  variants: VariantString[];
}

interface PubmedPart {
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
    sources?: string[];
  }[];
}

interface ClinvarPart {
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

/** Response of POST /api/search: expansion plus both searches in one payload. */
interface SearchResponse extends ExpandPart {
  searchTerms?: { pubmed: string[]; clinvar: string[] };
  pubmed: PubmedPart;
  clinvar: ClinvarPart;
  error?: string;
}

const VALID_ASSEMBLIES: Assembly[] = ["GRCh38", "GRCh37"];

function parseAssembly(raw: string | null): Assembly {
  return raw && (VALID_ASSEMBLIES as string[]).includes(raw) ? (raw as Assembly) : "GRCh38";
}

/** Link that reruns this exact search, for sharing with collaborators. */
function shareUrlFor(query: string, assembly: Assembly): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ q: query, assembly }).toString();
  url.hash = "";
  return url.toString();
}

interface Submitted {
  query: string;
  assembly: Assembly;
}

const keyOf = (s: Submitted) => `${s.assembly}|${s.query}`;

export function Explorer() {
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  // The response is stored with the request it answers, so a result is never
  // shown under a different query's header.
  const [response, setResponse] = useState<{ key: string; data: SearchResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The form is controlled from here so it cannot drift out of step with the URL.
  const [query, setQuery] = useState("");
  const [assembly, setAssembly] = useState<Assembly>("GRCh38");
  const data = useDatasets();

  // Cancels the previous search when a new one starts, so a slow earlier
  // response can never overwrite a newer one.
  const inFlight = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (query: string, assembly: Assembly, { updateUrl = true } = {}) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      const request = { query, assembly };
      setSubmitted(request);
      setResponse(null);
      setError(null);
      setLoading(true);

      if (updateUrl && typeof window !== "undefined") {
        const params = new URLSearchParams({ q: query, assembly });
        window.history.pushState({ q: query, assembly }, "", `?${params.toString()}`);
      }

      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, assembly }),
          signal: controller.signal,
        });
        const body = (await res.json()) as SearchResponse;

        if (controller.signal.aborted) return;

        if (!res.ok) {
          if (res.status === 429) {
            const retry = res.headers.get("Retry-After");
            setError(
              retry
                ? `Too many requests, try again in ${retry}s.`
                : "Too many requests, please slow down and try again shortly.",
            );
          } else {
            setError(body.error ?? "Search failed.");
          }
          return;
        }

        setResponse({ key: keyOf(request), data: body });
      } catch (e) {
        // An aborted request is a superseded search, not a failure.
        if (controller.signal.aborted || (e instanceof Error && e.name === "AbortError")) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setLoading(false);
        }
      }
    },
    [],
  );

  const goHome = useCallback((push: boolean) => {
    inFlight.current?.abort();
    inFlight.current = null;
    setLoading(false);
    setSubmitted(null);
    setResponse(null);
    setError(null);
    setQuery("");
    if (push) window.history.pushState(null, "", window.location.pathname);
  }, []);

  // Run the search named by the URL, on first load and on back/forward. The
  // form fields are set unconditionally so they always describe the URL, even
  // when the value is unchanged or empty.
  useEffect(() => {
    const fromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const q = params.get("q")?.trim() ?? "";
      const build = parseAssembly(params.get("assembly"));
      setAssembly(build);
      if (q) {
        setQuery(q);
        void runSearch(q, build, { updateUrl: false });
      } else {
        goHome(false);
      }
    };

    fromLocation();
    window.addEventListener("popstate", fromLocation);
    return () => {
      window.removeEventListener("popstate", fromLocation);
      inFlight.current?.abort();
    };
  }, [runSearch, goHome]);

  const result = submitted && response?.key === keyOf(submitted) ? response.data : null;
  const pubmed = result?.pubmed;
  const clinvar = result?.clinvar;
  const headline = result ? pickHeadline(result) : undefined;

  // Penetrance can often be matched from the typed rsID or locus before the
  // server has answered; the resolved variant refines or supplies the match.
  const penetrance = useMemo(() => {
    if (!submitted || !data.dataset) return null;
    const q = submitted.query.trim();
    const rsid = /^rs\d+$/i.test(q) ? q : result?.canonical.rsid;
    const locus =
      submitted.assembly === "GRCh38" ? (parseLocus(q) ?? parseLocus(result?.canonical.hgvsg)) : undefined;
    return findRecords(data.dataset.records, { rsid, locus });
  }, [submitted, result, data.dataset]);

  const topSig = clinvar ? topSignificance(clinvar.records) : undefined;
  const top = penetrance?.matches.find((r) => r.icd10.affected > 0 || r.algorithm.affected > 0) ?? penetrance?.matches[0];
  // A miss is only final once the dataset is loaded and the variant has been resolved.
  const penetranceChecking = !data.dataset || (loading && !result);
  const failed = !loading && !result && !!error;

  return (
    <main className={submitted ? "" : "landing"}>
      <header className="app-header">
        <h1>
          <button type="button" className="home-link" onClick={() => goHome(true)}>
            VarCrawl
          </button>
        </h1>
        <p className="subtitle">Look up a variant: penetrance, ClinVar, and literature in one search.</p>
      </header>

      <SearchForm
        query={query}
        assembly={assembly}
        onQueryChange={setQuery}
        onAssemblyChange={setAssembly}
        onSearch={(q, a) => void runSearch(q, a)}
        disabled={loading}
      />
      {loading && <div className="progress" role="progressbar" aria-label="Searching" />}

      {data.error && <div className="error" role="alert">{data.error}</div>}
      {error && <div className="error" role="alert">{error}</div>}

      {submitted && (
        <>
          <VariantHeader query={submitted.query} headline={headline} resolving={loading && !result} failed={failed} />

          <div className="summary" aria-label="Summary">
            <div className="tile">
              <span className="tile-label">Penetrance</span>
              <strong className="tile-value">
                {top ? `${formatPct(top.icd10.pct)} / ${formatPct(top.algorithm.pct)}` : penetranceChecking ? "Checking..." : "No data"}
              </strong>
              <span className="tile-sub">
                {top ? `${top.disease} (ICD-10 / algorithm)` : penetranceChecking ? "Looking up the variant" : "Not in the selected dataset"}
              </span>
            </div>
            <div className={`tile${clinvar || !loading ? "" : " pending"}`}>
              <span className="tile-label">ClinVar</span>
              {topSig ? (
                <strong className="tile-value"><span className={`sig-badge ${topSig.cls}`}>{topSig.label}</span></strong>
              ) : (
                <strong className="tile-value">{clinvar ? "No records" : loading ? "Searching..." : "Unavailable"}</strong>
              )}
              <span className="tile-sub">
                {clinvar ? `${clinvar.count} record${clinvar.count === 1 ? "" : "s"}` : loading ? "Checking ClinVar" : "Search failed"}
              </span>
            </div>
            <div className={`tile${pubmed || !loading ? "" : " pending"}`}>
              <span className="tile-label">Literature</span>
              <strong className="tile-value">
                {pubmed ? pubmed.count.toLocaleString("en-US") : loading ? "Searching..." : "Unavailable"}
              </strong>
              <span className="tile-sub">PubMed / Europe PMC articles</span>
            </div>
          </div>

          {penetrance && penetrance.matches.length > 0 ? (
            <PenetranceCard
              records={penetrance.matches}
              matchedBy={penetrance.by}
              synthetic={data.dataset?.synthetic}
              footer={<DataSource data={data} />}
            />
          ) : penetranceChecking ? null : (
            <section className="panel" aria-label="Penetrance">
              <h2>Penetrance</h2>
              <p className="muted-text">
                No penetrance data for this variant in {data.dataset?.label ?? "the selected dataset"}.
                Matching uses the rsID, or the GRCh38 position.
              </p>
              <DataSource data={data} />
            </section>
          )}

          {result && (
            <>
              <ExportBar
                query={result.input}
                shareUrl={shareUrlFor(result.input, result.assembly)}
                articles={pubmed?.articles ?? []}
                records={clinvar?.records ?? []}
                groups={result.groups}
              />
              {clinvar && <ClinvarResults data={clinvar} />}
              {pubmed && <ResultsList data={pubmed} />}
              <details className="forms">
                <summary>All forms of this variant ({result.variants.length})</summary>
                <VariantPanel data={result} />
              </details>
            </>
          )}
        </>
      )}

      <footer className="site-footer">
        Powered by the Huang Lab at Mount Sinai (
        <a href="https://labs.icahn.mssm.edu/kuanhuanglab/" target="_blank" rel="noopener noreferrer">
          labs.icahn.mssm.edu/kuanhuanglab
        </a>
        ) · GitHub (
        <a href="https://github.com/Huang-lab/VarCrawl" target="_blank" rel="noopener noreferrer">
          github.com/Huang-lab/VarCrawl
        </a>
        )
      </footer>
    </main>
  );
}
