import type { Candidate, CompanyIdentity, Evidence, IsoDateTime, MatchingService, RankedCandidate, RequestId, SourcingRequest } from "../contracts.js";

/** Trusted retrieval output, never accepted from a bot as proof that a fetch occurred. */
export interface SourceSnapshot {
  url: string;
  retrievedAt: IsoDateTime;
  contentHash: string;
  /** Search/HTML adapters provide readable text derived from the body identified by contentHash. */
  text: string;
}

export interface EvidenceRun {
  requestId: RequestId;
  startedAt: IsoDateTime;
  completedAt: IsoDateTime;
  sources: readonly SourceSnapshot[];
  /** Public-source extraction identities, not registered participants or demo aliases. */
  companies: readonly CompanyIdentity[];
}

/** Ranking only. This neither extracts semantic claims nor authorizes commercial actions.
 * EvidenceRun is trusted in-process collector output, NOT an authenticated RPC payload.
 * The caller must bind body hashes, source identities and extraction to actual backend fetches.
 */
export class EvidenceRanker implements Pick<MatchingService, "rankEvidence"> {
  private readonly documents = new Map<string, string>();
  private readonly companies = new Map<string, CompanyIdentity>();
  private readonly now: () => Date;
  private readonly completedAt: number;
  private readonly requestId: RequestId;

  constructor(run: EvidenceRun, options: { now?: () => Date } = {}) {
    const start = timestamp(run?.startedAt);
    const end = timestamp(run?.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 300_000 || !Array.isArray(run.sources) ||
        !Array.isArray(run.companies) || !text(run.requestId)) {
      throw new TypeError("Invalid evidence run boundaries");
    }
    this.now = options.now ?? (() => new Date());
    this.completedAt = end;
    this.requestId = run.requestId;
    this.assertFresh();
    for (const identity of run.companies) {
      const company = companyIdentity(identity);
      const key = companyKey(company);
      const previous = this.companies.get(key);
      if (previous && normalizedName(previous.name) !== normalizedName(company.name)) throw new TypeError("Conflicting source identity");
      this.companies.set(key, company);
    }
    for (const source of run.sources) {
      if (!record(source) || !validEvidenceMetadata(source) || typeof source.text !== "string") continue;
      const retrieved = timestamp(source.retrievedAt);
      if (retrieved < start || retrieved > end) continue;
      const key = documentKey(source);
      if (this.documents.has(key) && this.documents.get(key) !== source.text) throw new TypeError("Conflicting source snapshot");
      this.documents.set(key, source.text);
    }
  }

  rankEvidence(request: SourcingRequest, candidates: Candidate[]): RankedCandidate[] {
    this.assertFresh();
    if (request?.id !== this.requestId) throw new TypeError("Evidence run belongs to a different request");
    const requirements = request?.requirements;
    if (!Array.isArray(requirements) || !Array.isArray(candidates)) throw new TypeError("Invalid ranking inputs");
    const keys = new Set<string>();
    for (const requirement of requirements) {
      if (!record(requirement) || !text(requirement.key) || typeof requirement.mandatory !== "boolean" || keys.has(requirement.key)) {
        throw new TypeError("Invalid or duplicate requirement key");
      }
      keys.add(requirement.key);
    }
    const identities = new Set<string>();
    const scored = candidates.map((input) => {
      const company = companyIdentity(input?.company);
      const identity = companyKey(company);
      const sourceCompany = this.companies.get(identity);
      const identityConfirmed = !!sourceCompany && normalizedName(sourceCompany.name) === normalizedName(company.name);
      if (identities.has(identity)) throw new TypeError("Duplicate candidate identity requires upstream resolution");
      identities.add(identity);
      if (!Array.isArray(input.claims)) throw new TypeError("Invalid candidate claims");
      let matches = 0;
      let documented = 0;
      const mismatched: string[] = [];
      const missing: string[] = [];
      const claims: Candidate["claims"] = requirements.map((requirement) => {
        const supported = input.claims.filter((claim) => identityConfirmed && record(claim) && claim.requirementKey === requirement.key &&
          (claim.outcome === "match" || claim.outcome === "mismatch") && this.supports(claim.evidence, company.officialDomain));
        // One outcome/requirement; sourced contradictions cannot be erased by duplicate positive claims.
        supported.sort((a, b) => compare(a.outcome === "mismatch" ? "0" : "1", b.outcome === "mismatch" ? "0" : "1") ||
          compare(JSON.stringify(copyEvidence(a.evidence!)), JSON.stringify(copyEvidence(b.evidence!))));
        const selected = supported[0];
        if (!selected) {
          if (requirement.mandatory) missing.push(requirement.key);
          return { requirementKey: requirement.key, outcome: "unknown" };
        }
        documented++;
        if (selected.outcome === "match") matches++;
        else if (requirement.mandatory) mismatched.push(requirement.key);
        return { requirementKey: requirement.key, outcome: selected.outcome, evidence: copyEvidence(selected.evidence!) };
      });
      const eligible = mismatched.length ? "no" : missing.length || matches === 0 ? "conditional" : "yes";
      const explanation = (identityConfirmed ? "" : "Company identity is not confirmed by this run's public-source extraction. ") +
        `${matches} current-run quoted matches; ${documented} documented outcomes. ` +
        (mismatched.length ? `Mandatory mismatches: ${mismatched.join(", ")}.` :
          missing.length ? `Missing mandatory evidence: ${missing.join(", ")}.` :
            matches === 0 ? "No matching requirement evidence confirmed." : "All mandatory supplied claims have quoted support.");
      return { candidate: { company, claims }, eligible, explanation, matches, documented, identity };
    });
    scored.sort((a, b) => Number(a.eligible === "no") - Number(b.eligible === "no") ||
      b.matches - a.matches || b.documented - a.documented || compare(a.identity, b.identity));
    return scored.map(({ candidate, eligible, explanation }, index) => ({
      candidate, eligible: eligible as RankedCandidate["eligible"], explanation, rank: index + 1,
    }));
  }

  private assertFresh(): void {
    const now = this.now().getTime();
    // MVP_LIMIT: consume completed retrieval within five minutes; start a new run after that.
    if (!Number.isFinite(now) || now < this.completedAt || now - this.completedAt > 300_000) {
      throw new TypeError("Evidence run is expired or in the future");
    }
  }

  private supports(evidence: unknown, domain: string): evidence is Evidence {
    if (!record(evidence) || !validEvidenceMetadata(evidence) || !text(evidence.quotation)) return false;
    const hostname = new URL(evidence.url).hostname.replace(/^www\./, "");
    // MVP_LIMIT: official-domain capability evidence only. External certificate registries need
    // a verified subject-identity binding before their claims can count, not a domain exception list.
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) return false;
    return this.documents.get(documentKey(evidence))?.includes(evidence.quotation) === true;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(Z|[+-](0\d|1[0-4]):[0-5]\d)$/.test(value)) return NaN;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}

function validEvidenceMetadata(value: Record<string, unknown>): value is Record<string, unknown> & Omit<Evidence, "quotation"> {
  if (!text(value.url) || !Number.isFinite(timestamp(value.retrievedAt)) ||
      typeof value.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.contentHash)) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

function documentKey(value: Omit<Evidence, "quotation">): string {
  return JSON.stringify([value.url, value.retrievedAt, value.contentHash]);
}

function companyIdentity(value: unknown): Candidate["company"] {
  if (!record(value) || !text(value.name) || !text(value.officialDomain) || /[\s\/:@?#]/.test(value.officialDomain)) {
    throw new TypeError("Invalid company identity");
  }
  let domain: string;
  try { domain = new URL(`https://${value.officialDomain}`).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, ""); }
  catch { throw new TypeError("Invalid company identity"); }
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) || /^\d+(?:\.\d+)+$/.test(domain)) throw new TypeError("Invalid company identity");
  if (value.publicOrganizationId !== undefined && (!text(value.publicOrganizationId) || value.publicOrganizationId !== value.publicOrganizationId.trim())) {
    throw new TypeError("Invalid company identity");
  }
  return { name: value.name.trim(), officialDomain: domain,
    ...(value.publicOrganizationId !== undefined ? { publicOrganizationId: value.publicOrganizationId } : {}) };
}

function companyKey(company: CompanyIdentity): string {
  return JSON.stringify([company.officialDomain, company.publicOrganizationId ?? ""]);
}

function normalizedName(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
}

function copyEvidence(value: Evidence): Evidence {
  return { url: value.url, retrievedAt: value.retrievedAt, contentHash: value.contentHash, quotation: value.quotation };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
