import type { Headline } from "@/lib/variant/headline";

interface Props {
  query: string;
  headline?: Headline;
  resolving: boolean;
  /** Variant resolution failed; the error banner explains why. */
  failed?: boolean;
}

/** Names the variant the way people say it: gene + protein change first, identifiers beneath. */
export function VariantHeader({ query, headline: h, resolving, failed }: Props) {
  const main = h?.proteinShort ?? h?.protein ?? h?.cdna ?? h?.rsid ?? query;
  const longForm = h?.proteinShort ? h.protein : undefined;
  const meta = [longForm, h?.rsid, h?.protein ? h.cdna : undefined, h?.genomic].filter(Boolean) as string[];

  return (
    <section className="variant-head" aria-label="Variant">
      <h2 className="vh-title">
        {h?.gene && <span className="vh-gene">{h.gene}</span>}
        <span className="vh-protein">{main}</span>
        {h?.consequence && <span className="consequence-pill">{h.consequence}</span>}
      </h2>
      <p className="vh-meta">
        {resolving ? "Resolving variant..." : failed ? null : meta.length > 0 ? meta.map((m, i) => (
          <span key={m}>{i > 0 && " · "}<code>{m}</code></span>
        )) : "Could not resolve this variant to a gene; searching on the text as typed."}
      </p>
    </section>
  );
}
