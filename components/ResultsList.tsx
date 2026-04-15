"use client";

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
  data: { count: number; articles: Article[] };
}

export function ResultsList({ data }: Props) {
  if (data.count === 0) {
    return (
      <div className="panel">
        <h2>PubMed results</h2>
        <p style={{ color: "var(--muted)" }}>No articles found for any representation.</p>
      </div>
    );
  }

  const grouped = new Map<string, Article[]>();
  for (const article of data.articles) {
    const primary = article.matchedBy[0] ?? "(unlabeled)";
    if (!grouped.has(primary)) grouped.set(primary, []);
    grouped.get(primary)!.push(article);
  }

  return (
    <div className="panel">
      <h2>PubMed results ({data.count})</h2>
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
                    {a.title || `(no title, PMID ${a.pmid})`}
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
