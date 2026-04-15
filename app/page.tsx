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

function buildPubmedSearchTerms(expand: ExpandResponse): string[] {
  const baseVariants = expand.variants.map((v) => v.text).filter((v) => v.length > 0);
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

  if (coordinateOnly) {
    return Array.from(new Set(baseVariants));
  }

  const withContext: string[] = [];
  for (const v of baseVariants) {
    const hasGene = !!escapedGene && new RegExp(`\\b${escapedGene}\\b`, "i").test(v);
    const hasTranscript = transcripts.some((t) => v.includes(t));
    if (!hasGene && gene) withContext.push(`${gene} ${v}`);
    if (!hasTranscript) {
      for (const tx of transcripts.slice(0, 6)) {
        withContext.push(`${tx} ${v}`);
      }
    }
  }

  return Array.from(new Set([...withContext, ...baseVariants]));
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
      const pubmedVariants = buildPubmedSearchTerms(d1);
      const clinvarVariants = d1.variants.map((v: VariantString) => v.text);
      const gene = d1.canonical.gene ?? d1.classified.gene;
      const proteinForms = buildProteinForms(d1);

      // Fan out to PubMed and ClinVar in parallel — they are independent.
      const [pubmedRes, clinvarRes] = await Promise.allSettled([
        fetch("/api/pubmed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variants: pubmedVariants }),
        }).then(async (r) => ({ status: r.status, retryAfter: r.headers.get("Retry-After"), body: await r.json() })),
        fetch("/api/clinvar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variants: clinvarVariants, gene, proteinForms }),
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
        setError((e) => e ?? explain("PubMed", pubmedRes.value));
      }

      if (clinvarRes.status === "fulfilled" && !clinvarRes.value.body.error) {
        setClinvar(clinvarRes.value.body as ClinvarResponse);
      } else if (clinvarRes.status === "fulfilled") {
        setError((e) => e ?? explain("ClinVar", clinvarRes.value));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading("idle");
    }
  }

  return (
    <main>
      <h1>AskMutation</h1>
      <p className="subtitle">
        Paste a mutation in any HGVS-like notation. We expand it into every way it might
        appear in the literature and search PubMed and ClinVar for each.
      </p>

      <SearchForm onSearch={handleSearch} disabled={loading !== "idle"} />

      {error && <div className="error">{error}</div>}

      {loading === "expanding" && <p className="spinner">Expanding mutation representations…</p>}
      {expand && <VariantPanel data={expand} />}

      {loading === "searching" && <p className="spinner">Searching PubMed and ClinVar…</p>}
      {clinvar && <ClinvarResults data={clinvar} />}
      {pubmed && <ResultsList data={pubmed} />}
    </main>
  );
}
