/**
 * Keeps an OFAC SDN list loaded and screens against it. Fails closed: if the list has never been
 * loaded, or the copy in memory is older than `maxAgeMs` and cannot be refreshed, screening throws
 * instead of quietly waving everyone through.
 */
import { SanctionsList, type SanctionsMatch, type ScreeningSubject } from "./sanctionsList.js";

export const OFAC_SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
export const OFAC_ALT_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV";

export class ScreeningUnavailableError extends Error {}

export interface ScreenResult {
  matches: SanctionsMatch[];
  listSource: string;
  listLoadedAt: Date;
}

export interface SanctionsScreener {
  screen(subject: ScreeningSubject): Promise<ScreenResult>;
}

export interface OfacScreenerOptions {
  sdnUrl?: string;
  altUrl?: string;
  fetchImpl?: typeof fetch;
  /** Refresh the list when the copy in memory is older than this. */
  refreshMs?: number;
  /** Stop screening (fail closed) when the copy is older than this and cannot be refreshed. */
  maxAgeMs?: number;
  now?: () => number;
}

export class OfacScreener implements SanctionsScreener {
  private list: SanctionsList | undefined;
  private loadedAt = 0;
  private inFlight: Promise<void> | undefined;
  private readonly sdnUrl: string;
  private readonly altUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: OfacScreenerOptions = {}) {
    this.sdnUrl = options.sdnUrl ?? OFAC_SDN_URL;
    this.altUrl = options.altUrl ?? OFAC_ALT_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshMs = options.refreshMs ?? 12 * 3600 * 1000;
    this.maxAgeMs = options.maxAgeMs ?? 7 * 24 * 3600 * 1000;
    this.now = options.now ?? Date.now;
  }

  private async download(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.text();
  }

  private async load(): Promise<void> {
    const [sdn, alt] = await Promise.all([this.download(this.sdnUrl), this.download(this.altUrl).catch(() => undefined)]);
    const list = new SanctionsList(sdn, alt);
    // A list that parsed to almost nothing is a broken download, not a clean register.
    if (list.entries < 1000) throw new Error(`SDN list looks truncated (${list.entries} rows)`);
    this.list = list;
    this.loadedAt = this.now();
  }

  private async ensureFresh(): Promise<void> {
    const age = this.now() - this.loadedAt;
    if (this.list && age < this.refreshMs) return;

    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    try {
      await this.inFlight;
    } catch (err) {
      if (this.list && age < this.maxAgeMs) return; // keep screening against the last good copy
      throw new ScreeningUnavailableError(
        `sanctions list unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async screen(subject: ScreeningSubject): Promise<ScreenResult> {
    await this.ensureFresh();
    return {
      matches: this.list!.screen(subject),
      listSource: "OFAC SDN",
      listLoadedAt: new Date(this.loadedAt),
    };
  }
}
