"use client";

import { useEffect, useState } from "react";
import { formatPct, iconFills, penetranceAtAge, wilsonInterval } from "@/lib/penetrance/stats";
import { MEASURE_LABELS, type MeasureKey, type PenetranceRecord } from "@/lib/penetrance/types";
import { AgeChart } from "./AgeChart";
import { LifetimeChart } from "./LifetimeChart";
import { PeopleGrid } from "./PeopleGrid";

const LOW_N = 30;
const MEASURES: MeasureKey[] = ["icd10", "algorithm"];

export const recordLabel = (r: PenetranceRecord) => r.disease;

interface Props {
  records: PenetranceRecord[];
  matchedBy?: "rsid" | "locus";
  synthetic?: boolean;
  footer?: React.ReactNode;
}

/** Penetrance for one variant: 100 people per definition, plus an age curve when available. */
export function PenetranceCard({ records, matchedBy, synthetic, footer }: Props) {
  const best = records.find((r) => r.icd10.affected > 0 || r.algorithm.affected > 0) ?? records[0];
  const [selectedId, setSelectedId] = useState(best.id);
  const [ageChoice, setAgeChoice] = useState<number | null>(null);
  useEffect(() => {
    setSelectedId(best.id);
    setAgeChoice(null);
  }, [best.id, records]);

  const rec = records.find((r) => r.id === selectedId) ?? best;
  const maxAge = rec.ages ? rec.ages[rec.ages.length - 1].age : 0;
  const minAge = rec.ages ? rec.ages[0].age : 0;
  const age = rec.ages ? Math.min(ageChoice ?? maxAge, maxAge) : undefined;
  const when = age !== undefined ? `by age ${age}` : "over a lifetime";

  const values = MEASURES.map((m) => {
    const pct = age !== undefined ? (penetranceAtAge(rec, m, age) ?? rec[m].pct) : rec[m].pct;
    const affected = age !== undefined ? (pct / 100) * rec.carriers : rec[m].affected;
    return { measure: m, pct, affected, ci: wilsonInterval(affected, rec.carriers) };
  });

  return (
    <section className="panel pen-card" aria-label="Penetrance">
      <div className="pen-header">
        <h2>Penetrance</h2>
        {records.length > 1 && (
          <div className="seg" role="group" aria-label="Condition">
            {records.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={r.id === rec.id}
                className={r.id === rec.id ? "active" : ""}
                onClick={() => {
                  setSelectedId(r.id);
                  setAgeChoice(null);
                }}
              >
                {recordLabel(r)}
                {records.filter((o) => o.disease === r.disease).length > 1 ? ` ${r.ref}>${r.alt}` : ""}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="pen-sub">
        <strong>{rec.disease}</strong> · {rec.carriers.toLocaleString("en-US")} carriers
        {matchedBy === "locus" && " · matched by position (GRCh38)"}
      </p>
      {synthetic && (
        <p className="notice notice-warning" role="note">
          <strong>Demo data.</strong> Age curves are synthetic and illustrative only.
        </p>
      )}
      {rec.carriers < LOW_N && (
        <p className="notice notice-warning" role="note">
          Only {rec.carriers} carrier{rec.carriers === 1 ? "" : "s"}: estimates are very imprecise.
        </p>
      )}

      <div className="pen-body">
        {values.map(({ measure, pct, affected, ci }) => {
          const shown = pct;
          const shownText = shown >= 10 ? Math.round(shown) : Math.round(shown * 10) / 10;
          return (
            <div key={measure} className={`pen-measure tone-${measure}`}>
              <h3>{MEASURE_LABELS[measure]}</h3>
              <p className="pen-big">
                <strong>{shownText}</strong> <span>of 100 {when}</span>
              </p>
              <PeopleGrid
                fills={iconFills(pct, 100)}
                tone={measure}
                label={`${shownText} of 100 carriers affected by ${MEASURE_LABELS[measure]} ${when}`}
              />
              <p className="pen-detail">
                {formatPct(pct)} · {Math.round(affected * 10) / 10} of {rec.carriers.toLocaleString("en-US")}
                <br />
                <span className="muted-small">95% CI {formatPct(ci.low)} to {formatPct(ci.high)}</span>
              </p>
            </div>
          );
        })}

        <div className="pen-side">
          {rec.ages && age !== undefined ? (
            <>
              <label className="age-slider">
                <span>
                  Age <strong>{age}</strong>
                </span>
                <input
                  type="range"
                  min={minAge}
                  max={maxAge}
                  step={1}
                  value={age}
                  onChange={(e) => setAgeChoice(Number(e.target.value))}
                  aria-label="Age in years"
                />
              </label>
              <AgeChart points={rec.ages} age={age} onAge={setAgeChoice} synthetic={synthetic} />
            </>
          ) : (
            <>
              <LifetimeChart
                rows={values.map((v) => ({ measure: v.measure, pct: v.pct, low: v.ci.low, high: v.ci.high }))}
              />
              <p className="muted-small">
                Lifetime penetrance only. Bars show the estimate; whiskers show the 95% confidence range. Load
                age-specific data (a CSV with an Age column) to see penetrance by age.
              </p>
            </>
          )}
        </div>
      </div>
      {footer}
    </section>
  );
}
