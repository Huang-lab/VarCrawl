"use client";

import { useEffect, useState } from "react";
import { baselineFor } from "@/lib/penetrance/baseline";
import {
  compareToBaseline,
  formatPct,
  formatRate,
  formatRatio,
  iconFills,
  penetranceAtAge,
  wilsonInterval,
} from "@/lib/penetrance/stats";
import type { PenetranceRecord } from "@/lib/penetrance/types";
import { AgeChart } from "./AgeChart";
import { LifetimeChart } from "./LifetimeChart";
import { PeopleGrid } from "./PeopleGrid";

const LOW_N = 30;

export const recordLabel = (r: PenetranceRecord) => r.disease;

interface Props {
  records: PenetranceRecord[];
  matchedBy?: "rsid" | "locus";
  synthetic?: boolean;
  footer?: React.ReactNode;
}

const VERDICT_TEXT = {
  higher: "Above the published general-population rate",
  similar: "Not clearly different from the published general-population rate",
  lower: "Below the published general-population rate",
} as const;

/** "6.1" or "12": one decimal under 10, none above. */
const short = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

/** Penetrance for one variant, read against the disease's base rate when one is known. */
export function PenetranceCard({ records, matchedBy, synthetic, footer }: Props) {
  const best = records.find((r) => r.affected > 0) ?? records[0];
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

  const pct = age !== undefined ? (penetranceAtAge(rec, age) ?? rec.pct) : rec.pct;
  const affected = age !== undefined ? (pct / 100) * rec.carriers : rec.affected;
  const ci = wilsonInterval(affected, rec.carriers);

  // Base rates are lifetime or overall figures, so they only line up with the full-lifetime view.
  const baseline = baselineFor(rec.disease);
  const comparable = age === undefined || age >= maxAge;
  const comparison = baseline && comparable ? compareToBaseline(pct, ci, baseline.pct) : undefined;
  const baselineLabel = baseline ? `General population ${baseline.kind}` : "";

  return (
    <section className="panel pen-card" aria-label="Penetrance">
      <div className="pen-header">
        <h2>How many carriers have the disease?</h2>
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

      <p className="pen-summary">
        Of <strong>{rec.carriers.toLocaleString("en-US")}</strong> people with this variant,{" "}
        <strong>{Math.round(affected * 10) / 10}</strong> ({formatPct(pct)}) have a recorded diagnosis of{" "}
        {rec.disease.toLowerCase()} {when}.
        {baseline && comparable && (
          <>
            {" "}
            In the general population ({baseline.population}) the {baseline.kind} is {formatRate(baseline.pct)}.
          </>
        )}
      </p>
      {comparison && (
        <p className={`pen-verdict verdict-${comparison.verdict}`}>
          <strong>{VERDICT_TEXT[comparison.verdict]}.</strong>{" "}
          {comparison.verdict === "similar"
            ? "The carriers' 95% range includes the general-population rate, so this data cannot show a difference."
            : `About ${formatRatio(comparison.ratio)} the published rate.`}{" "}
          <span className="muted-small">
            Not adjusted for age, sex, or ancestry, and the two groups were sampled differently
            {comparison.verdict === "lower" ? ", so this does not show the variant is protective" : ""}.
          </span>
        </p>
      )}
      {baseline && !comparable && (
        <p className="muted-small">
          The general-population rate is a lifetime or overall figure, so it is compared only at the oldest age.
        </p>
      )}
      {!baseline && (
        <p className="muted-small">No general-population rate is on file for this disease, so there is nothing to compare against.</p>
      )}

      <div className="pen-body">
        <div className="pen-groups">
          <div className="pen-measure tone-carrier">
            <h3>People with this variant</h3>
            <p className="pen-big">
              <strong>{short(pct)}</strong> <span>of 100 {when}</span>
            </p>
            <PeopleGrid
              fills={iconFills(pct, 100)}
              tone="carrier"
              label={`${short(pct)} of 100 carriers have a diagnosis of ${rec.disease} ${when}`}
            />
            <p className="pen-detail">
              {Math.round(affected * 10) / 10} of {rec.carriers.toLocaleString("en-US")}
              <br />
              <span className="muted-small">
                Likely range: {formatPct(ci.low)} to {formatPct(ci.high)}
              </span>
            </p>
          </div>

          {baseline && comparable && (
            <div className="pen-measure tone-baseline">
              <h3>General population</h3>
              <p className="pen-big">
                <strong>{short(baseline.pct)}</strong> <span>of 100 ({baseline.kind})</span>
              </p>
              <PeopleGrid
                fills={iconFills(baseline.pct, 100)}
                tone="baseline"
                label={`${short(baseline.pct)} of 100 people in the general population have ${rec.disease} (${baseline.kind})`}
              />
              <p className="pen-detail">
                {formatRate(baseline.pct)}
                <br />
                <span className="muted-small">{baseline.source}</span>
              </p>
            </div>
          )}
        </div>

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
              <AgeChart
                points={rec.ages}
                age={age}
                onAge={setAgeChoice}
                baseline={baseline && { pct: baseline.pct, label: baselineLabel }}
                synthetic={synthetic}
              />
            </>
          ) : (
            <>
              <LifetimeChart
                rows={[
                  { key: "carrier", label: "People with this variant", pct, low: ci.low, high: ci.high },
                  ...(baseline ? [{ key: "baseline" as const, label: "General population", pct: baseline.pct }] : []),
                ]}
              />
              <p className="muted-small">
                Lifetime penetrance only. The whisker is the 95% range. Load age-specific data (a CSV with an Age
                column) to see penetrance by age.
              </p>
            </>
          )}
        </div>
      </div>

      <details className="pen-help">
        <summary>How to read this</summary>
        <ul>
          <li>
            <strong>Penetrance</strong> is the share of people carrying the variant who go on to have the disease. A
            low number does not mean the variant is harmless, and a high number does not mean it is certain.
          </li>
          <li>
            <strong>Diagnosis</strong> here means an ICD-10 code in the person&apos;s health record. Undiagnosed
            disease is missed, and a code can occasionally be recorded without the disease being present.
          </li>
          <li>
            <strong>Likely range</strong> (95% confidence interval) shows how precise the estimate is. With few
            carriers it is wide, so treat the number as rough.
          </li>
          <li>
            <strong>General population</strong> figures come from published studies, not from the cohort behind these
            carriers, so differences in age, sex, and ancestry can shift the comparison. Use it for orientation, not
            as a risk calculator.
          </li>
        </ul>
      </details>
      {footer}
    </section>
  );
}
