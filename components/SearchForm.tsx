"use client";

import { useState } from "react";
import type { Assembly } from "@/lib/hgvs/types";

interface Props {
  onSearch: (query: string, assembly: Assembly) => void;
  loading: boolean;
  initialQuery?: string;
  initialAssembly?: Assembly;
}

const EXAMPLES = ["CFH p.R1210C", "BRAF p.V600E", "KRAS p.G12D", "TP53 p.R175H", "APOB p.R3527Q"];

export function SearchForm({ onSearch, loading, initialQuery, initialAssembly }: Props) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [assembly, setAssembly] = useState<Assembly>(initialAssembly ?? "GRCh38");

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
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          onFocus={(e) => e.target.select()}
          aria-label="Variant"
        />
        <select
          value={assembly}
          onChange={(e) => setAssembly(e.target.value as Assembly)}
          aria-label="Genome assembly"
        >
          <option value="GRCh38">GRCh38 / hg38</option>
          <option value="GRCh37">GRCh37 / hg19</option>
        </select>
        <button type="submit" disabled={loading || !query.trim()} aria-busy={loading}>
          {loading ? (
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
            <button type="button" className="example-chip" onClick={() => {
                setQuery(ex);
                onSearch(ex, assembly);
              }}>
              {ex}
            </button>
          </span>
        ))}
      </p>
    </>
  );
}
