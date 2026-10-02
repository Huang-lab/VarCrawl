"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { makeDemoDataset } from "@/lib/penetrance/demo";
import { parsePenetranceCsv } from "@/lib/penetrance/parse";
import type { PenetranceDataset } from "@/lib/penetrance/types";

const BUNDLED_URL = "/data/etable4_penetrance.csv";
export const ETABLE4_SOURCE = {
  label: "JAMA article, eTable 4",
  url: "https://jamanetwork.com/journals/jama/fullarticle/2788347",
};

export function useDatasets() {
  const [bundled, setBundled] = useState<PenetranceDataset | null>(null);
  const [uploaded, setUploaded] = useState<PenetranceDataset | null>(null);
  const [activeId, setActiveId] = useState("etable4");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(BUNDLED_URL, { signal: ctl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) =>
        setBundled({
          ...parsePenetranceCsv(text, {
            id: "etable4",
            label: "eTable 4",
            description: "Measured penetrance per variant, all ages combined.",
          }),
          source: ETABLE4_SOURCE,
        }),
      )
      .catch((e) => {
        if (e?.name !== "AbortError") setError(`Could not load the bundled penetrance data (${e.message}).`);
      });
    return () => ctl.abort();
  }, []);

  const demo = useMemo(() => (bundled ? makeDemoDataset(bundled.records) : null), [bundled]);
  const datasets = useMemo(
    () => [bundled, demo, uploaded].filter((d): d is PenetranceDataset => d !== null),
    [bundled, demo, uploaded],
  );
  const dataset = datasets.find((d) => d.id === activeId) ?? datasets[0];

  const upload = useCallback(async (file: File) => {
    const ds = parsePenetranceCsv(await file.text(), {
      id: "uploaded",
      label: file.name.length > 24 ? `${file.name.slice(0, 21)}...` : file.name,
      description: "Your file.",
    });
    if (ds.records.length === 0) {
      setError(ds.warnings[0] ?? "No usable rows found in that file.");
      return;
    }
    setError(null);
    setUploaded(ds);
    setActiveId("uploaded");
  }, []);

  return { datasets, dataset, setActiveId, upload, error };
}

export type DatasetState = ReturnType<typeof useDatasets>;
