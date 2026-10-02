"use client";

import { useState } from "react";
import {
  articlesToCsv,
  clinvarToCsv,
  slugifyQuery,
  variantsToCsv,
  type CsvVariantRow,
} from "@/lib/search/csv";

interface TranscriptGroupLike {
  gene?: string;
  transcript?: string;
  variants: { text: string; label: string }[];
}

interface Props {
  query: string;
  shareUrl: string;
  articles: Parameters<typeof articlesToCsv>[0];
  records: Parameters<typeof clinvarToCsv>[0];
  groups?: {
    universal: { text: string; label: string }[];
    perTranscript: TranscriptGroupLike[];
    fallback: { text: string; label: string }[];
  };
}

/**
 * Hand the browser a generated file without leaking the object URL.
 *
 * The leading U+FEFF is for Excel on Windows, which ignores the charset in the
 * MIME type when opening a local file and falls back to the system code page —
 * without the BOM, an author name like "Müller" lands in a supplementary table
 * as "MÃ¼ller". It is written here rather than in `toCsv` so the serializer
 * stays byte-exact for programmatic callers.
 */
function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([`\ufeff${text}`], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Deferred by a tick: Firefox and Safari read the blob asynchronously after
  // the click, so revoking in the same task cancels the download silently.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

function variantRows(groups: Props["groups"]): CsvVariantRow[] {
  if (!groups) return [];
  const rows: CsvVariantRow[] = [];
  for (const v of groups.universal) {
    rows.push({ text: v.text, label: v.label, group: "universal" });
  }
  for (const g of groups.perTranscript) {
    for (const v of g.variants) {
      rows.push({
        text: v.text,
        label: v.label,
        group: "transcript",
        transcript: g.transcript,
        gene: g.gene,
      });
    }
  }
  for (const v of groups.fallback) {
    rows.push({ text: v.text, label: v.label, group: "fallback" });
  }
  return rows;
}

export function ExportBar({ query, shareUrl, articles, records, groups }: Props) {
  const [copied, setCopied] = useState(false);
  const stem = slugifyQuery(query);
  const rows = variantRows(groups);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the URL bar already holds the link.
      setCopied(false);
    }
  }

  return (
    <div className="export-bar" aria-label="Export and share results">
      <span className="export-label">Export</span>
      <button
        type="button"
        onClick={() => downloadText(`${stem}-pubmed.csv`, articlesToCsv(articles))}
        disabled={articles.length === 0}
        title={articles.length === 0 ? "No articles to export" : "Download articles as CSV"}
      >
        Articles CSV ({articles.length})
      </button>
      <button
        type="button"
        onClick={() => downloadText(`${stem}-clinvar.csv`, clinvarToCsv(records))}
        disabled={records.length === 0}
        title={records.length === 0 ? "No ClinVar records to export" : "Download ClinVar records as CSV"}
      >
        ClinVar CSV ({records.length})
      </button>
      <button
        type="button"
        onClick={() => downloadText(`${stem}-representations.csv`, variantsToCsv(rows))}
        disabled={rows.length === 0}
        title="Download every searched representation as CSV"
      >
        Representations CSV ({rows.length})
      </button>
      <button type="button" onClick={copyLink} title="Copy a link that reruns this search">
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}
