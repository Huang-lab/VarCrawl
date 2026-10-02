import { memo } from "react";

function Person() {
  return (
    <svg viewBox="0 0 10 20" aria-hidden="true" focusable="false">
      <circle cx="5" cy="3" r="2.6" />
      <rect x="1.2" y="6.4" width="7.6" height="7.4" rx="2.6" />
      <rect x="2.6" y="12.4" width="2" height="7" rx="1" />
      <rect x="5.4" y="12.4" width="2" height="7" rx="1" />
    </svg>
  );
}

interface Props {
  /** Fill fraction (0-1) for each of the 100 people. */
  fills: number[];
  tone: "carrier" | "baseline";
  label: string;
}

/** 10x10 icon array: each icon is one person out of 100; filled icons have the condition. */
export const PeopleGrid = memo(function PeopleGrid({ fills, tone, label }: Props) {
  return (
    <div className={`people-grid tone-${tone}`} role="img" aria-label={label}>
      {fills.map((f, i) => (
        <span className="person" key={i}>
          <Person />
          {f > 0 && (
            <span className="person-fill" style={f < 1 ? { clipPath: `inset(0 ${(1 - f) * 100}% 0 0)` } : undefined}>
              <Person />
            </span>
          )}
        </span>
      ))}
    </div>
  );
});
