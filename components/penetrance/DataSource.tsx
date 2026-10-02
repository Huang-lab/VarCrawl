"use client";

import { useRef } from "react";
import type { DatasetState } from "./useDatasets";

/** Attribution plus the (rarely needed) dataset switch and CSV upload. */
export function DataSource({ data }: { data: DatasetState }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const ds = data.dataset;
  if (!ds) return null;

  return (
    <div className="data-source">
      <span>
        {ds.source ? (
          <>
            Source:{" "}
            <a href={ds.source.url} target="_blank" rel="noopener noreferrer">
              {ds.source.label}
            </a>
            .
          </>
        ) : ds.synthetic ? (
          "Synthetic age curves derived from eTable 4. Not measured."
        ) : (
          `Source: ${ds.label}.`
        )}
      </span>
      <span className="data-source-controls">
        <label>
          Dataset{" "}
          <select
            value={ds.id}
            onChange={(e) => data.setActiveId(e.target.value)}
            aria-label="Penetrance dataset"
          >
            {data.datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id === "demo" ? "Demo: age-specific (synthetic)" : d.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="link-button" onClick={() => fileRef.current?.click()}>
          Upload CSV
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void data.upload(f);
            e.target.value = "";
          }}
        />
      </span>
    </div>
  );
}
