/**
 * The US Treasury's OFAC "Specially Designated Nationals" list, parsed into something a party can
 * be screened against: every listed name (the primary name, the aliases in ALT.CSV and the
 * a.k.a./f.k.a. names in the remarks) and every digital-currency address the list publishes.
 *
 * This is a name-and-address screen, not an adjudication. A name match means "stop and have a
 * person look"; it is deliberately strict (same words, any order, legal-form suffixes ignored) so
 * it produces few false alarms, and it will miss spelling variants and transliterations. It is a
 * first control that is real and free, not a replacement for a commercial screening provider.
 */

export interface SanctionsMatch {
  type: "name" | "address";
  /** What on the list matched (the listed name, or the address). */
  listed: string;
  /** OFAC's id for the listing, for the human who reviews the hit. */
  entNum: string;
}

export interface ScreeningSubject {
  legalName?: string;
  stellarAccounts?: string[];
}

/** Minimal CSV parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  // One field, then what ended it: a comma, a line break, or the end of the text.
  const token = /("(?:[^"]|"")*"|[^,\r\n]*)(,|\r\n|\n|\r|$)/y;
  let row: string[] = [];
  let pos = 0;
  while (pos <= text.length) {
    token.lastIndex = pos;
    const m = token.exec(text);
    if (!m) break;
    const raw = m[1];
    row.push(raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw);
    pos = token.lastIndex;
    if (m[2] !== ",") {
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (m[2] === "") break; // end of text
    }
    if (m[0] === "") break; // no progress: avoid spinning
  }
  return rows;
}

/** Words that name the legal form, not the entity: "Acme Ltd" and "ACME LIMITED" are the same name. */
const LEGAL_FORMS = new Set([
  "LTD", "LIMITED", "LLC", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "PLC", "LLP", "LP",
  "SA", "SAS", "SARL", "SRL", "SPA", "AG", "GMBH", "BV", "NV", "OY", "AB", "AS", "FZE", "FZC", "FZCO", "PTE", "PVT",
]);

/** Order-insensitive, punctuation-insensitive key for a name; empty when there is nothing to match on. */
export function nameKey(name: string): string {
  const tokens = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const core = tokens.filter((t) => !LEGAL_FORMS.has(t));
  return (core.length > 0 ? core : tokens).sort().join(" ");
}

const NULL_FIELD = "-0-";
const clean = (v: string | undefined) => (v && v.trim() !== NULL_FIELD ? v.trim() : "");

const AKA = /\b(?:a|f|n)\.k\.a\.\s*'([^']+)'/gi;
const DIGITAL_ADDRESS = /Digital Currency Address - ([A-Z0-9]+)\s+([A-Za-z0-9]+)/g;

export class SanctionsList {
  private readonly names = new Map<string, { listed: string; entNum: string }[]>();
  private readonly addresses = new Map<string, { listed: string; entNum: string }>();
  readonly entries: number;

  /** `altCsv` is optional: with it, the list's alias records are screened too. */
  constructor(sdnCsv: string, altCsv?: string) {
    const sdn = parseCsv(sdnCsv);
    for (const row of sdn) {
      const entNum = clean(row[0]);
      const name = clean(row[1]);
      if (!entNum || !name) continue;
      this.addName(name, name, entNum);

      const remarks = clean(row[11]);
      for (const m of remarks.matchAll(AKA)) this.addName(m[1], m[1], entNum);
      for (const m of remarks.matchAll(DIGITAL_ADDRESS)) {
        this.addresses.set(m[2].toUpperCase(), { listed: `${m[1]} ${m[2]}`, entNum });
      }
    }
    this.entries = sdn.length;

    if (altCsv) {
      for (const row of parseCsv(altCsv)) {
        const entNum = clean(row[0]);
        const alias = clean(row[3]);
        if (entNum && alias) this.addName(alias, alias, entNum);
      }
    }
  }

  private addName(name: string, listed: string, entNum: string): void {
    const key = nameKey(name);
    // A one-word key ("BANK") would match half the register; require something more specific.
    if (key.length < 5) return;
    const hits = this.names.get(key) ?? [];
    hits.push({ listed, entNum });
    this.names.set(key, hits);
  }

  screen(subject: ScreeningSubject): SanctionsMatch[] {
    const matches: SanctionsMatch[] = [];
    if (subject.legalName) {
      const key = nameKey(subject.legalName);
      for (const hit of this.names.get(key) ?? []) matches.push({ type: "name", ...hit });
    }
    for (const account of subject.stellarAccounts ?? []) {
      const hit = this.addresses.get(account.toUpperCase());
      if (hit) matches.push({ type: "address", ...hit });
    }
    return matches;
  }
}
