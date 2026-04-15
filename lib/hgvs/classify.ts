import { AA1_TO_3, AA3_TO_1, ClassifiedInput, HgvsKind } from "./types";

// Protein short form like V600E, R175H, *572Gln, Trp24*, etc.
// Accepts leading "p." and optional parens, handles 1-letter or 3-letter codes.
const SHORT_PROTEIN_RE =
  /^(?:p\.)?\(?([A-Z]|[A-Z][a-z]{2})(\d+)([A-Z]|[A-Z][a-z]{2}|\*|=|fs\*?\d*|del|dup|ins[A-Za-z]+)?\)?$/;

const ACCESSION_PREFIXES = {
  NM: "hgvsc",
  XM: "hgvsc",
  NR: "hgvsn",
  XR: "hgvsn",
  ENST: "hgvsc",
  LRG: "hgvsc",
  NP: "hgvsp",
  XP: "hgvsp",
  ENSP: "hgvsp",
  NC: "hgvsg",
  NG: "hgvsg",
  CM: "hgvsg",
} as const;

function inferKindFromBody(body: string): HgvsKind {
  if (/^c\./i.test(body)) return "hgvsc";
  if (/^g\./i.test(body)) return "hgvsg";
  if (/^m\./i.test(body)) return "hgvsg"; // mitochondrial, genomic-ish
  if (/^n\./i.test(body)) return "hgvsn";
  if (/^p\./i.test(body)) return "hgvsp";
  if (/^r\./i.test(body)) return "hgvsc";
  return "unknown";
}

function inferKindFromAccession(acc: string): HgvsKind {
  const m = acc.match(/^([A-Z]{2,4})[_\d]/);
  if (!m) return "unknown";
  const pfx = m[1] as keyof typeof ACCESSION_PREFIXES;
  return (ACCESSION_PREFIXES[pfx] ?? "unknown") as HgvsKind;
}

/**
 * Best-effort classification of a user-entered mutation string.
 *
 * Handled forms:
 *   NM_004333.6:c.1799T>A      → hgvsc
 *   NP_004324.2:p.Val600Glu    → hgvsp
 *   NC_000007.14:g.140753336A>T → hgvsg
 *   chr7:g.140753336A>T         → hgvsg
 *   7:g.140753336A>T            → hgvsg
 *   BRAF:p.V600E                → hgvsp (gene-prefixed)
 *   BRAF p.V600E                → hgvsp (gene-prefixed, space)
 *   BRAF V600E                  → short (gene-prefixed)
 *   V600E, p.Val600Glu, p.(V600E) → short
 *   rs113488022                 → rsid
 */
export function classify(raw: string): ClassifiedInput {
  const trimmed = raw.trim();

  // rsID
  if (/^rs\d+$/i.test(trimmed)) {
    return { raw, kind: "rsid", body: trimmed.toLowerCase() };
  }

  // Allow a gene symbol + space + HGVS-ish body (e.g. "BRAF p.V600E" or "BRAF V600E")
  const geneSpace = trimmed.match(/^([A-Z][A-Z0-9-]{0,15})\s+(.+)$/);
  if (geneSpace && !/^(chr|NC_|NM_|NP_|NR_|NG_|ENST|ENSP|LRG_)/i.test(geneSpace[1])) {
    const gene = geneSpace[1];
    const rest = classify(geneSpace[2]);
    return { ...rest, raw, gene };
  }

  // Colon-prefixed form: ACC:body  OR  chr7:g.pos OR BRAF:p.body
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx);
    const body = trimmed.slice(colonIdx + 1);
    const kindFromBody = inferKindFromBody(body);

    // Chromosome prefix
    const chrMatch = prefix.match(/^(chr)?([0-9]{1,2}|X|Y|M|MT)$/i);
    if (chrMatch && kindFromBody === "hgvsg") {
      return {
        raw,
        kind: "hgvsg",
        chrom: chrMatch[2].toUpperCase().replace("MT", "M"),
        body,
      };
    }

    // Accession prefix (NM_, NP_, NC_, ENST, ENSP, LRG_)
    if (/^(NM_|XM_|NR_|XR_|NP_|XP_|NC_|NG_|ENST|ENSP|LRG_)/i.test(prefix)) {
      const kindFromAcc = inferKindFromAccession(prefix);
      const kind: HgvsKind =
        kindFromBody !== "unknown" ? kindFromBody : kindFromAcc;
      return { raw, kind, accession: prefix, body, ...shortProtein(body) };
    }

    // Gene symbol prefix (e.g. "BRAF:p.V600E")
    if (/^[A-Z][A-Z0-9-]{0,15}$/.test(prefix) && kindFromBody !== "unknown") {
      return { raw, kind: kindFromBody, gene: prefix, body, ...shortProtein(body) };
    }
  }

  // No colon: maybe a bare HGVS body like "c.1799T>A"
  const bareKind = inferKindFromBody(trimmed);
  if (bareKind !== "unknown") {
    return { raw, kind: bareKind, body: trimmed, ...shortProtein(trimmed) };
  }

  // Short protein form (V600E, Val600Glu, p.V600E)
  const short = shortProtein(trimmed);
  if (short.proteinShort || short.proteinLong) {
    return { raw, kind: "short", body: trimmed, ...short };
  }

  return { raw, kind: "unknown", body: trimmed };
}

function shortProtein(s: string): Partial<ClassifiedInput> {
  // Strip a leading p. and optional parens before matching
  const cleaned = s.replace(/^p\./i, "").replace(/^\(([^)]+)\)$/, "$1");
  const m = cleaned.match(SHORT_PROTEIN_RE);
  if (!m) return {};
  const [, ref, pos, alt] = m;
  const ref1 = toOne(ref);
  const ref3 = toThree(ref1);
  if (!ref1 || !ref3) return {};

  // alt may be missing (e.g. just position mention), 1-letter, 3-letter, fs, del, dup, ins
  let alt1: string | undefined;
  let alt3: string | undefined;
  if (alt) {
    if (/^fs/i.test(alt) || /^(del|dup|ins)/i.test(alt) || alt === "=") {
      alt1 = alt;
      alt3 = alt;
    } else if (alt === "*") {
      alt1 = "*";
      alt3 = "Ter";
    } else {
      alt1 = toOne(alt);
      alt3 = toThree(alt1);
      // If an alternate AA was provided but is not a valid AA code,
      // reject this short-protein parse entirely to avoid incorrect annotation.
      if (!alt3) return {};
    }
  }

  const proteinShort = alt1 ? `${ref1}${pos}${alt1}` : `${ref1}${pos}`;
  const proteinLong = alt3 ? `p.${ref3}${pos}${alt3}` : `p.${ref3}${pos}`;
  return { proteinShort, proteinLong };
}

function toOne(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code.length === 1) {
    const one = code.toUpperCase();
    return AA1_TO_3[one] ? one : undefined;
  }
  if (code.length === 3) return AA3_TO_1[normalizeCase3(code)];
  return undefined;
}

function toThree(one: string | undefined): string | undefined {
  if (!one) return undefined;
  return AA1_TO_3[one.toUpperCase()];
}

function normalizeCase3(code: string): string {
  return code[0].toUpperCase() + code.slice(1).toLowerCase();
}
