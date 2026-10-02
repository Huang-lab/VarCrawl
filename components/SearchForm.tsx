"use client";

import type { Assembly } from "@/lib/hgvs/types";

interface Props {
  /**
   * Controlled inputs. The page owns these and keeps them in step with the
   * URL, so a shared link, a typed query and a back/forward navigation all
   * agree on what is being searched. Mirroring the URL into local state here
   * let the two drift: navigating back to a search on a different genome build
   * left the dropdown showing the build from the previous search, labelling the
   * displayed coordinates with the wrong assembly.
   */
  query: string;
  assembly: Assembly;
  onQueryChange: (query: string) => void;
  onAssemblyChange: (assembly: Assembly) => void;
  onSearch: (query: string, assembly: Assembly) => void;
  disabled: boolean;
}

// Every example has penetrance data in the bundled eTable 4, across several conditions.
const EXAMPLES = [
  "ABCA4 p.G1961E",
  "GCGR p.G40S",
  "TP53 p.R175H",
  "BRCA2 p.E1308K",
  "LDLR p.R633C",
  "CFH p.R1210C",
  "APOE p.E31K",
  "AR p.A871E",
];

export function SearchForm({
  query,
  assembly,
  onQueryChange,
  onAssemblyChange,
  onSearch,
  disabled,
}: Props) {
  return (
    <>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) onSearch(query.trim(), assembly);
        }}
      >
        <input
          type="text"
          placeholder="rsID, HGVS, or gene + change (e.g. rs80359550, BRAF p.V600E)"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={(e) => e.target.select()}
          aria-label="Variant"
          autoFocus
          disabled={disabled}
        />
        <select
          value={assembly}
          onChange={(e) => onAssemblyChange(e.target.value as Assembly)}
          disabled={disabled}
          aria-label="Genome assembly"
        >
          <option value="GRCh38">GRCh38 / hg38</option>
          <option value="GRCh37">GRCh37 / hg19</option>
        </select>
        <button type="submit" disabled={disabled || !query.trim()} aria-busy={disabled}>
          {disabled ? (
            <>
              <span className="btn-spinner" aria-hidden="true" /> Searching
            </>
          ) : (
            "Search"
          )}
        </button>
      </form>
      <p className="examples">
        Try:{" "}
        {EXAMPLES.map((ex, i) => (
          <span key={ex}>
            {i > 0 && " "}
            <button
              type="button"
              className="example-chip"
              disabled={disabled}
              onClick={() => {
                onQueryChange(ex);
                onSearch(ex, assembly);
              }}
            >
              {ex}
            </button>
          </span>
        ))}
      </p>
    </>
  );
}
