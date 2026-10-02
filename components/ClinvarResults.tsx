"use client";

import { sigClass } from "@/lib/clinvar/significance";
import { cleanTitle, decodeEntities } from "@/lib/text";

interface ClinvarRecord {
  uid: string;
  accession?: string;
  title?: string;
  gene?: string;
  clinicalSignificance?: string;
  reviewStatus?: string;
  lastEvaluated?: string;
  conditions: string[];
  matchedBy: string[];
}

interface Props {
  data: {
    count: number;
    unfilteredCount?: number;
    gene?: string;
    proteinForms?: string[];
    status?: {
      complete: boolean;
      likelyRateLimited: boolean;
      likelyPartial: boolean;
      message?: string;
    };
    records: ClinvarRecord[];
  };
}

function filterLabel(gene?: string, forms?: string[]): string {
  const parts: string[] = [];
  if (gene) parts.push(gene);
  // Prefer the shortest form (typically the 1-letter notation) for display.
  if (forms && forms.length > 0) {
    const shortest = [...forms].sort((a, b) => a.length - b.length)[0];
    if (shortest) parts.push(shortest);
  }
  return parts.join(" ");
}

function normalizeConditionsForDisplay(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (name: string) => {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };

  for (const raw of values) {
    const decoded = decodeEntities(raw ?? "").trim();
    if (!decoded) continue;

    const embedded = Array.from(
      decoded.matchAll(/<ClassifiedCondition\b[^>]*>([\s\S]*?)<\/ClassifiedCondition>/g),
      (m) => m[1],
    );
    if (embedded.length > 0) {
      for (const name of embedded) push(name);
      continue;
    }

    const noTags = decoded.replace(/<[^>]+>/g, " ").trim();
    if (!noTags) continue;
    for (const part of noTags.split(/\s*;\s*/)) push(part);
  }

  return out;
}

export function ClinvarResults({ data }: Props) {
  const label = filterLabel(data.gene, data.proteinForms);
  const statusMessage = data.status?.message;

  if (data.count === 0) {
    return (
      <div className="panel">
        <h2>ClinVar records</h2>
        {statusMessage && <p className="notice notice-warning">{statusMessage}</p>}
        {data.status?.likelyRateLimited || data.status?.likelyPartial ? (
          <p className="muted-text">
            No ClinVar records shown
            {label ? ` for ${label}` : ""}. This is likely due to temporary limits or upstream errors, not necessarily a true zero-match result.
          </p>
        ) : (
          <p className="muted-text">
            No ClinVar records matched any representation
            {label ? ` for ${label}` : ""}.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>ClinVar records ({data.count})</h2>
      {statusMessage && (data.status?.likelyRateLimited || data.status?.likelyPartial) && (
        <p className="notice notice-warning">{statusMessage}</p>
      )}
      {data.records.map((r) => {
        const displayConditions = normalizeConditionsForDisplay(r.conditions);
        return (
          <div className="clinvar-row" key={r.uid}>
            <div className="title">
              <a
                href={`https://www.ncbi.nlm.nih.gov/clinvar/variation/${r.uid}/`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {(r.title && cleanTitle(r.title)) || r.accession || `ClinVar UID ${r.uid}`}
              </a>
            </div>
            {r.clinicalSignificance && (
              <div className="meta">
                Clinical significance:{" "}
                <span className={`sig-badge ${sigClass(r.clinicalSignificance)}`}>
                  {r.clinicalSignificance}
                </span>
              </div>
            )}
            <div className="meta">
              {r.accession && <span>{r.accession}</span>}
              {r.gene && <span> · {r.gene}</span>}
              {r.reviewStatus && <span> · {r.reviewStatus}</span>}
              {r.lastEvaluated && <span> · evaluated {r.lastEvaluated}</span>}
            </div>
            {displayConditions.length > 0 && (
              <div className="meta">
                Conditions: {displayConditions.slice(0, 6).join("; ")}
                {displayConditions.length > 6 ? `; +${displayConditions.length - 6} more` : ""}
              </div>
            )}
            <div className="matched">Matched on: {r.matchedBy.join(", ")}</div>
          </div>
        );
      })}
    </div>
  );
}
