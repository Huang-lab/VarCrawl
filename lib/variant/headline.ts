const THREE_TO_ONE: Record<string, string> = {
  Ala: "A", Arg: "R", Asn: "N", Asp: "D", Cys: "C", Gln: "Q", Glu: "E", Gly: "G", His: "H", Ile: "I",
  Leu: "L", Lys: "K", Met: "M", Phe: "F", Pro: "P", Ser: "S", Thr: "T", Trp: "W", Tyr: "Y", Val: "V",
  Sec: "U", Ter: "*",
};

/** "NP_000050.3:p.Ser1982ArgfsTer22" -> "p.Ser1982ArgfsTer22". */
export function stripAccession(hgvs: string | undefined): string | undefined {
  if (!hgvs) return undefined;
  const m = /(?:^|:)(p\.[^:]+|c\.[^:]+)$/.exec(hgvs.trim());
  return m ? m[1] : hgvs.trim();
}

/** "p.Ser1982ArgfsTer22" -> "p.S1982Rfs*22". Leaves non-protein strings untouched. */
export function toOneLetter(hgvsp: string): string {
  if (!/^p\./.test(hgvsp)) return hgvsp;
  return hgvsp.replace(/[A-Z][a-z]{2}/g, (aa) => THREE_TO_ONE[aa] ?? aa);
}

interface Group {
  gene?: string;
  transcript?: string;
  hgvsc?: string;
  hgvsp?: string;
  consequenceTerms?: string[];
  isManeSelect?: boolean;
  isCanonical?: boolean;
}

export interface HeadlineInput {
  input: string;
  classified: { gene?: string; proteinLong?: string };
  canonical: {
    gene?: string;
    rsid?: string;
    hgvsg?: string;
    consequences: { gene?: string; hgvsc?: string; hgvsp?: string; consequenceTerms?: string[] }[];
  };
  groups: { perTranscript: Group[] };
}

export interface Headline {
  gene?: string;
  /** Protein change, three-letter, without accession. */
  protein?: string;
  /** Same change in one-letter notation. */
  proteinShort?: string;
  /** Coding change with its transcript, e.g. NM_000059.4:c.5946del. */
  cdna?: string;
  genomic?: string;
  rsid?: string;
  consequence?: string;
}

/** Chooses the MANE Select (else canonical, else first coding) transcript to headline the variant. */
export function pickHeadline(e: HeadlineInput): Headline {
  const groups = e.groups.perTranscript;
  const g =
    groups.find((x) => x.isManeSelect) ??
    groups.find((x) => x.isCanonical && x.hgvsp) ??
    groups.find((x) => x.hgvsp) ??
    groups[0];
  const c = e.canonical.consequences.find((x) => x.hgvsp) ?? e.canonical.consequences[0];
  const protein = stripAccession(g?.hgvsp ?? c?.hgvsp ?? e.classified.proteinLong);
  const term = (g?.consequenceTerms ?? c?.consequenceTerms)?.[0];
  return {
    gene: e.canonical.gene ?? e.classified.gene ?? g?.gene,
    protein,
    proteinShort: protein && /^p\.[A-Z][a-z]{2}/.test(protein) ? toOneLetter(protein) : undefined,
    cdna: g?.hgvsc ?? c?.hgvsc,
    genomic: e.canonical.hgvsg,
    rsid: e.canonical.rsid,
    consequence: term?.replace(/_/g, " "),
  };
}
