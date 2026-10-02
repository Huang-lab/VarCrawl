"use client";

import { cleanTitle } from "@/lib/text";

interface Article {
  pmid: string;
  title: string;
  authors: string[];
  journal: string;
  pubDate: string;
  doi?: string;
  matchedBy: string[];
}

interface Props {
  data: {
    count: number;
    articles: Article[];
    status?: {
      complete: boolean;
      likelyRateLimited: boolean;
      likelyPartial: boolean;
      message?: string;
    };
  };
}

function rankPrimaryMatchedTerm(term: string): number {
  if (/^rs\d+$/i.test(term)) return 0;
  if (/^(?:chr)?(?:[0-9]{1,2}|x|y|m|mt):g\./i.test(term)) return 0;
  if (/^[A-Z]{2,4}_[0-9]+(?:\.[0-9]+)?:g\./i.test(term)) return 0;

  if (/^[A-Z][A-Z0-9-]{1,15}[\s:]/.test(term)) return 1;
  if (/^(?:NM_|NP_|ENST|ENSP|NC_|NG_|LRG_)/i.test(term)) return 2;
  if (/^(?:c\.|p\.|g\.)/i.test(term)) return 3;
  return 4;
}

function pickPrimaryMatchedTerm(terms: string[]): string {
  if (terms.length === 0) return "(unlabeled)";
  const ordered = [...terms].sort((a, b) => {
    const ra = rankPrimaryMatchedTerm(a);
    const rb = rankPrimaryMatchedTerm(b);
    if (ra !== rb) return ra - rb;
    return a.length - b.length;
  });
  return ordered[0];
}

export function ResultsList({ data }: Props) {
  const statusMessage = data.status?.message;
  const showStatusNotice = Boolean(statusMessage && !data.status?.complete);

  if (data.count === 0) {
    return (
      <div className="panel">
        <h2>PubMed results</h2>
        {showStatusNotice && <p className="notice notice-warning">{statusMessage}</p>}
        {data.status?.likelyRateLimited || data.status?.likelyPartial ? (
          <p className="muted-text">No articles shown. This is likely due to temporary limits or upstream errors, not necessarily a true zero-match result.</p>
        ) : (
          <p className="muted-text">No articles found for any representation.</p>
        )}
      </div>
    );
  }

  const grouped = new Map<string, Article[]>();
  for (const article of data.articles) {
    const primary = pickPrimaryMatchedTerm(article.matchedBy ?? []);
    if (!grouped.has(primary)) grouped.set(primary, []);
    grouped.get(primary)!.push(article);
  }

  return (
    <div className="panel">
      <h2>PubMed results ({data.count})</h2>
      {showStatusNotice && (
        <p className="notice notice-warning">{statusMessage}</p>
      )}
      <div className="pubmed-nav" aria-label="Jump to PubMed section">
        {Array.from(grouped.entries()).map(([primary, items]) => {
          const id = `pubmed-${encodeURIComponent(primary)}`;
          return (
            <a key={primary} href={`#${id}`} className="pubmed-nav-link">
              {primary} ({items.length})
            </a>
          );
        })}
      </div>

      {Array.from(grouped.entries()).map(([primary, items]) => {
        const id = `pubmed-${encodeURIComponent(primary)}`;
        return (
          <section key={primary} id={id} className="pubmed-section">
            <h3 className="pubmed-section-title">
              {primary} ({items.length})
            </h3>
            {items.map((a) => (
              <div className="article" key={`${primary}-${a.pmid}`}>
                <div className="title">
                  <a
                    href={`https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {cleanTitle(a.title) || `(no title, PMID ${a.pmid})`}
                  </a>
                </div>
                <div className="meta">
                  {a.authors.slice(0, 3).join(", ")}
                  {a.authors.length > 3 ? ", et al." : ""}
                  {a.journal ? ` — ${a.journal}` : ""}
                  {a.pubDate ? ` (${a.pubDate})` : ""}
                  {a.doi ? (
                    <>
                      {" "}·{" "}
                      <a href={`https://doi.org/${a.doi}`} target="_blank" rel="noopener noreferrer">
                        doi:{a.doi}
                      </a>
                    </>
                  ) : null}
                </div>
                <div className="matched">matched on: {a.matchedBy.join(", ")}</div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
