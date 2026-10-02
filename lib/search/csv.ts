/**
 * CSV serialization for search results.
 *
 * Exporting is the point at which results leave the app for a manuscript's
 * supplementary table or a spreadsheet, so the escaping has to be right:
 * article titles routinely contain commas, quotes and the occasional newline,
 * and ClinVar condition lists are semicolon-delimited.
 */

export interface CsvArticle {
  pmid: string;
  title: string;
  authors: string[];
  journal: string;
  pubDate: string;
  doi?: string;
  matchedBy: string[];
  sources?: string[];
}

export interface CsvClinvarRecord {
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

/**
 * Quote a single field per RFC 4180: wrap in double quotes when it contains a
 * delimiter, quote or line break, and double any embedded quote.
 *
 * A leading =, +, - or @ is prefixed with a single quote. Spreadsheet software
 * treats such a value as a formula, which turns exported data into executable
 * content ("CSV injection"); gene and protein notations legitimately start with
 * these characters (e.g. a `-` in a deletion).
 */
export function csvField(value: unknown): string {
  let s =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join("; ")
        : String(value);

  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;

  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Join rows with CRLF, as RFC 4180 specifies. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n");
}

export const ARTICLE_CSV_HEADERS = [
  "pmid",
  "title",
  "authors",
  "journal",
  "pub_date",
  "doi",
  "sources",
  "matched_representations",
  "pubmed_url",
];

export function articlesToCsv(articles: CsvArticle[]): string {
  return toCsv(
    ARTICLE_CSV_HEADERS,
    articles.map((a) => [
      a.pmid,
      a.title,
      a.authors,
      a.journal,
      a.pubDate,
      a.doi ?? "",
      a.sources ?? [],
      a.matchedBy,
      `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`,
    ]),
  );
}

export const CLINVAR_CSV_HEADERS = [
  "clinvar_uid",
  "accession",
  "title",
  "gene",
  "clinical_significance",
  "review_status",
  "last_evaluated",
  "conditions",
  "matched_representations",
  "clinvar_url",
];

export function clinvarToCsv(records: CsvClinvarRecord[]): string {
  return toCsv(
    CLINVAR_CSV_HEADERS,
    records.map((r) => [
      r.uid,
      r.accession ?? "",
      r.title ?? "",
      r.gene ?? "",
      r.clinicalSignificance ?? "",
      r.reviewStatus ?? "",
      r.lastEvaluated ?? "",
      r.conditions,
      r.matchedBy,
      `https://www.ncbi.nlm.nih.gov/clinvar/variation/${r.uid}/`,
    ]),
  );
}

export const VARIANT_CSV_HEADERS = ["representation", "label", "group", "transcript", "gene"];

export interface CsvVariantRow {
  text: string;
  label: string;
  group: string;
  transcript?: string;
  gene?: string;
}

export function variantsToCsv(rows: CsvVariantRow[]): string {
  return toCsv(
    VARIANT_CSV_HEADERS,
    rows.map((r) => [r.text, r.label, r.group, r.transcript ?? "", r.gene ?? ""]),
  );
}

/** Filesystem-safe filename stem for a query, e.g. "BRAF p.V600E" → "braf-p-v600e". */
export function slugifyQuery(query: string): string {
  const slug = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "variant";
}
