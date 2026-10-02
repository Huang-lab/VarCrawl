/**
 * The search operations behind the API routes.
 *
 * Keeping these here (rather than inline in each route) lets a single request
 * run the PubMed and ClinVar searches concurrently in one process, where they
 * share one Entrez rate-limit budget. Split across two HTTP requests they can
 * land on separate serverless instances, each assuming the whole NCBI quota.
 */

import type { EntrezConfig } from "@/lib/entrez/base";
import { searchPubmedForVariantsDetailed } from "@/lib/pubmed/entrez";
import { searchEuropePmcForVariantsDetailed } from "@/lib/pubmed/europepmc";
import { searchClinvarForVariantsDetailed } from "@/lib/clinvar/entrez";
import { filterClinvarRecords } from "@/lib/clinvar/filter";
import type { ClinvarRecord } from "@/lib/clinvar/entrez";
import {
  Article,
  SourceStatus,
  buildStatusFromDiagnostics,
  failedSourceStatus,
  mergeArticles,
} from "@/lib/search/results";

export interface PubmedPayload {
  count: number;
  articles: Article[];
  status: SourceStatus;
}

export interface ClinvarPayload {
  count: number;
  unfilteredCount: number;
  gene?: string;
  proteinForms: string[];
  status: SourceStatus;
  records: ClinvarRecord[];
}

export function entrezConfigFromEnv(): EntrezConfig {
  return {
    apiKey: process.env.NCBI_API_KEY,
    email: process.env.NCBI_EMAIL,
    tool: "varcrawl",
  };
}

/** A skipped literature search, reported as an explicit incomplete status. */
export function skippedPubmedPayload(message: string): PubmedPayload {
  return {
    count: 0,
    articles: [],
    status: {
      complete: false,
      likelyRateLimited: false,
      likelyPartial: false,
      message,
    },
  };
}

/** An empty payload for a source whose search threw, so the rest still renders. */
export function failedPubmedPayload(): PubmedPayload {
  return { count: 0, articles: [], status: failedSourceStatus("PubMed") };
}

export function failedClinvarPayload(
  gene: string | undefined,
  proteinForms: string[],
): ClinvarPayload {
  return {
    count: 0,
    unfilteredCount: 0,
    gene,
    proteinForms,
    status: failedSourceStatus("ClinVar"),
    records: [],
  };
}

/**
 * Search PubMed and Europe PMC for every phrase and merge by PMID. The two
 * indexes are different hosts with separate quotas, so they run concurrently.
 */
export async function runPubmedSearch(
  variants: string[],
  cfg: EntrezConfig,
): Promise<PubmedPayload> {
  const [pubmedRes, europePmcRes] = await Promise.all([
    searchPubmedForVariantsDetailed(variants, cfg),
    searchEuropePmcForVariantsDetailed(variants, { deadline: cfg.deadline }),
  ]);

  const articles = mergeArticles(
    pubmedRes.articles,
    europePmcRes.articles as Article[],
  );

  return {
    count: articles.length,
    articles,
    status: buildStatusFromDiagnostics(
      {
        likelyPartial:
          pubmedRes.diagnostics.likelyPartial || europePmcRes.diagnostics.likelyPartial,
        likelyRateLimited:
          pubmedRes.diagnostics.likelyRateLimited ||
          europePmcRes.diagnostics.likelyRateLimited,
      },
      "PubMed",
    ),
  };
}

/** Search ClinVar, then drop records that do not match the intended gene/protein. */
export async function runClinvarSearch(
  variants: string[],
  cfg: EntrezConfig,
  opts: { gene?: string; proteinForms: string[] },
): Promise<ClinvarPayload> {
  const searchRes = await searchClinvarForVariantsDetailed(variants, cfg, {
    gene: opts.gene,
    proteinForms: opts.proteinForms,
  });
  const all = searchRes.records;
  const { kept } = filterClinvarRecords(all, {
    gene: opts.gene,
    proteinForms: opts.proteinForms,
  });

  return {
    count: kept.length,
    unfilteredCount: all.length,
    gene: opts.gene,
    proteinForms: opts.proteinForms,
    status: buildStatusFromDiagnostics(searchRes.diagnostics, "ClinVar"),
    records: kept,
  };
}
