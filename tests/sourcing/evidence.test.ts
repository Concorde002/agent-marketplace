import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candidate, Evidence, SourcingRequest } from "../../src/contracts.js";
import { EvidenceRanker, type EvidenceRun, type SourceSnapshot } from "../../src/matching/evidence.js";

const time = "2026-10-30T11:00:01.000Z";
const source: SourceSnapshot = {
  url: "https://manufacturer.example.com/capabilities",
  retrievedAt: time,
  contentHash: `sha256:${"a".repeat(64)}`,
  // Deliberately conflicting excerpts exercise conservative resolution, not semantic extraction.
  text: "Industrial cables. ISO 9001:2015 certified. Delivery region: France. ISO 9001:2015 certificate expired. No delivery to France. No industrial cables.",
};
const run: EvidenceRun = {
  requestId: "request-1",
  startedAt: "2026-10-30T11:00:00.000Z", completedAt: "2026-10-30T11:00:02.000Z",
  sources: [source, ...["alpha", "beta", "gamma", "zeta"].map((name) => ({ ...source, url: `https://${name}.example.com/capabilities` }))],
  companies: ["manufacturer", "alpha", "beta", "gamma", "zeta"].map((name) => ({ name, officialDomain: `${name}.example.com` })),
};
const request: SourcingRequest = {
  id: "request-1", buyerId: "buyer-1", category: "cables", description: "Industrial cables",
  quantity: 10, unit: "metre", destination: "France", maximumDeliveredTotal: { amountMinor: 10000, currency: "EUR" },
  deliverBy: "2026-12-01T12:00:00Z", demo: true,
  requirements: [
    { key: "industrial", description: "Industrial cables", mandatory: true },
    { key: "quality", description: "ISO 9001:2015 certification", mandatory: true },
    { key: "region", description: "France delivery", mandatory: false },
  ],
};

function evidence(quotation = "Industrial cables.", overrides: Partial<Evidence> = {}): Evidence {
  return { url: source.url, retrievedAt: time, contentHash: source.contentHash, quotation, ...overrides };
}

function candidate(domain: string, claims: Candidate["claims"] = []): Candidate {
  return {
    company: { name: domain.split(".")[0]!, officialDomain: domain },
    claims: claims.map((claim) => ({ ...claim, ...(claim.evidence ? {
      evidence: { ...claim.evidence, url: claim.evidence.url === source.url
        ? `https://${domain.toLowerCase()}/capabilities` : claim.evidence.url },
    } : {}) })),
  };
}

const industrial = { requirementKey: "industrial", outcome: "match" as const, evidence: evidence() };
const quality = { requirementKey: "quality", outcome: "match" as const, evidence: evidence("ISO 9001:2015 certified.") };
const region = { requirementKey: "region", outcome: "match" as const, evidence: evidence("Delivery region: France.") };

function makeRanker(context: EvidenceRun = run) {
  return new EvidenceRanker(context, { now: () => new Date(context.completedAt) });
}

test("ranks sourced requirement matches, then evidence completeness, then stable public identity", () => {
  const one = candidate("zeta.example.com", [industrial]);
  const two = candidate("beta.example.com", [industrial, quality]);
  const three = candidate("gamma.example.com", [industrial, quality, region]);
  const tied = candidate("alpha.example.com", [industrial, quality]);
  const result = makeRanker().rankEvidence(request, [one, three, two, tied]);
  assert.deepEqual(result.map((item) => item.candidate.company.officialDomain), [
    "gamma.example.com", "alpha.example.com", "beta.example.com", "zeta.example.com",
  ]);
  assert.deepEqual(result.map((item) => item.rank), [1, 2, 3, 4]);
  assert.deepEqual(result.map((item) => item.eligible), ["yes", "yes", "yes", "conditional"]);
  assert.match(result[3]!.explanation, /quality/);
});

test("keeps proven mandatory mismatches rejected, even with more positive claims", () => {
  const no = candidate("alpha.example.com", [industrial, quality, region,
    { requirementKey: "quality", outcome: "mismatch", evidence: evidence("ISO 9001:2015 certificate expired.") }]);
  const conditional = candidate("zeta.example.com", [industrial]);
  const result = makeRanker().rankEvidence(request, [no, conditional]);
  assert.equal(result[0]!.candidate.company.officialDomain, "zeta.example.com");
  assert.equal(result[1]!.eligible, "no");
  assert.match(result[1]!.explanation, /quality/);
});

test("optional mismatches do not disqualify and supply the documented-outcome tie break", () => {
  const lessComplete = candidate("alpha.example.com", [industrial, quality]);
  const moreComplete = candidate("zeta.example.com", [industrial, quality,
    { requirementKey: "region", outcome: "mismatch", evidence: evidence("No delivery to France.") }]);
  const result = makeRanker().rankEvidence(request, [lessComplete, moreComplete]);
  assert.equal(result[0]!.candidate.company.officialDomain, "zeta.example.com");
  assert.equal(result[0]!.eligible, "yes");
});

test("missing mandatory standards stay conditional, even when claimed without source evidence", () => {
  const input = candidate("alpha.example.com", [industrial, { requirementKey: "quality", outcome: "match" }]);
  const result = makeRanker().rankEvidence(request, [input])[0]!;
  assert.equal(result.eligible, "conditional");
  assert.equal(result.candidate.claims.find((claim) => claim.requirementKey === "quality")!.outcome, "unknown");
  assert.match(result.explanation, /quality/);
});

test("a source URL, hash, timestamp and verbatim quotation must all match a current-run snapshot", () => {
  for (const bad of [
    evidence("invented certification"), evidence(""), evidence("   "),
    evidence("Industrial cables.", { url: "https://elsewhere.example.com/capabilities" }),
    evidence("Industrial cables.", { contentHash: `sha256:${"b".repeat(64)}` }),
    evidence("Industrial cables.", { retrievedAt: "2026-10-29T11:00:01Z" }),
    evidence("Industrial cables.", { retrievedAt: "tomorrow" }),
  ]) {
    const result = makeRanker().rankEvidence(request, [candidate("alpha.example.com", [
      { requirementKey: "industrial", outcome: "match", evidence: bad }, quality,
    ])])[0]!;
    assert.equal(result.eligible, "conditional");
    assert.equal(result.candidate.claims[0]!.outcome, "unknown");
  }
});

test("a fresh run cannot reuse previous-run source records or positive candidate claims", () => {
  const input = candidate("alpha.example.com", [industrial, quality]);
  const first = makeRanker().rankEvidence(request, [input]);
  const coldRun = { ...run, startedAt: "2026-10-31T11:00:00Z", completedAt: "2026-10-31T11:00:02Z" };
  const next = makeRanker(coldRun).rankEvidence(request, [input]);
  assert.equal(first[0]!.eligible, "yes");
  assert.equal(next[0]!.eligible, "conditional");
  assert.ok(next[0]!.candidate.claims.every((claim) => claim.outcome === "unknown"));
});

test("registration metadata and input order never affect ranking or leak into the returned candidates", () => {
  const alpha = candidate("alpha.example.com", [industrial, quality]);
  const beta = candidate("beta.example.com", [industrial, quality]);
  const ranker = makeRanker();
  const expected = ranker.rankEvidence(request, [alpha, beta]);
  const registeredBeta = { ...beta, registered: true, participantId: "connected", company: { ...beta.company, connected: true } };
  const hiddenAlpha = { ...alpha, registered: false };
  assert.deepEqual(ranker.rankEvidence(request, [registeredBeta, hiddenAlpha]), expected);
  assert.deepEqual(ranker.rankEvidence(request, [beta, alpha]), expected);
});

test("duplicate and irrelevant claims cannot inflate scores; conflicting sourced outcomes fail conservatively", () => {
  const input = candidate("alpha.example.com", [industrial, industrial, quality,
    { requirementKey: "not-requested", outcome: "match", evidence: evidence() },
    { requirementKey: "industrial", outcome: "mismatch", evidence: evidence("No industrial cables.") }]);
  const result = makeRanker().rankEvidence(request, [input])[0]!;
  assert.equal(result.eligible, "no");
  assert.equal(result.candidate.claims.length, request.requirements.length);
  assert.equal(result.candidate.claims[0]!.outcome, "mismatch");
});

test("no requirements or no matching evidence does not become unconditional eligibility", () => {
  const ranker = makeRanker();
  assert.equal(ranker.rankEvidence({ ...request, requirements: [] }, [candidate("alpha.example.com")])[0]!.eligible, "conditional");
  assert.equal(ranker.rankEvidence(request, [candidate("alpha.example.com")])[0]!.eligible, "conditional");
  assert.deepEqual(ranker.rankEvidence(request, []), []);
});

test("ranking copies snapshots and candidates, and never mutates research inputs", () => {
  const snapshot = { ...source, url: "https://alpha.example.com/capabilities" };
  const ranker = makeRanker({ ...run, sources: [snapshot] });
  snapshot.text = "Changed after construction";
  const input = candidate("ALPHA.EXAMPLE.COM", [industrial, quality]);
  const before = structuredClone(input);
  const result = ranker.rankEvidence(request, [input]);
  assert.equal(result[0]!.eligible, "yes");
  assert.equal(result[0]!.candidate.company.officialDomain, "alpha.example.com");
  result[0]!.candidate.claims[0]!.evidence!.quotation = "edited output";
  assert.deepEqual(input, before);
});

test("rejects malformed identity, ambiguous duplicate companies and duplicate requirement keys", () => {
  const ranker = makeRanker();
  for (const domain of ["", "https://alpha.example.com", "alpha.example.com/path", "name@alpha.example.com", "alpha.example.com:443"]) {
    assert.throws(() => ranker.rankEvidence(request, [candidate(domain)]), /identity/i);
  }
  assert.throws(() => ranker.rankEvidence(request, [candidate("alpha.example.com"), candidate("ALPHA.EXAMPLE.COM")]), /duplicate/i);
  assert.throws(() => ranker.rankEvidence({ ...request, requirements: [request.requirements[0]!, request.requirements[0]!] }, []), /requirement/i);
  assert.throws(() => ranker.rankEvidence(request, [{ ...candidate("alpha.example.com"),
    company: { name: "alpha", officialDomain: "alpha.example.com", publicOrganizationId: " id " } }]), /identity/i);
});

test("invalid run boundaries fail, while future/out-of-window source entries cannot support claims", () => {
  assert.throws(() => makeRanker({ ...run, startedAt: "yesterday" }), /run/i);
  assert.throws(() => makeRanker({ ...run, completedAt: "2026-10-29T11:00:00Z" }), /run/i);
  const ranker = makeRanker({ ...run, sources: [{ ...source, retrievedAt: "2026-11-01T11:00:00Z" }] });
  const input = candidate("alpha.example.com", [industrial, quality]);
  assert.equal(ranker.rankEvidence(request, [input])[0]!.eligible, "conditional");
});

test("a supplier cannot borrow another company's quoted capability or certification", () => {
  const input = candidate("alpha.example.com", [industrial, quality]);
  for (const claim of input.claims) claim.evidence!.url = source.url;
  const result = makeRanker().rankEvidence(request, [input])[0]!;
  assert.equal(result.eligible, "conditional");
  assert.ok(result.candidate.claims.every((claim) => claim.outcome === "unknown"));
});

test("historical/future run envelopes and cross-request reuse are rejected", () => {
  assert.throws(() => new EvidenceRanker(run, { now: () => new Date("2026-10-31T11:00:00Z") }), /run/i);
  assert.throws(() => new EvidenceRanker(run, { now: () => new Date("2026-10-29T11:00:00Z") }), /run/i);
  assert.throws(() => makeRanker().rankEvidence({ ...request, id: "other-request" }, []), /request/i);
  assert.throws(() => makeRanker({ ...run, startedAt: "2026-10-29T11:00:00Z" }), /run/i);
});

test("unconfirmed or spoofed company labels cannot borrow credit through a real domain", () => {
  const input = candidate("alpha.example.com", [industrial, quality]);
  input.company.name = "Borrower Inc";
  const result = makeRanker().rankEvidence(request, [input])[0]!;
  assert.equal(result.eligible, "conditional");
  assert.match(result.explanation, /identity/i);
  const absent = makeRanker({ ...run, companies: [] }).rankEvidence(request, [candidate("alpha.example.com", [industrial, quality])])[0]!;
  assert.equal(absent.eligible, "conditional");
});

test("an existing ranker expires rather than becoming reusable rehearsal memory", () => {
  let clock = new Date(run.completedAt);
  const ranker = new EvidenceRanker(run, { now: () => clock });
  assert.equal(ranker.rankEvidence(request, [candidate("alpha.example.com", [industrial, quality])])[0]!.eligible, "yes");
  clock = new Date(clock.getTime() + 300_001);
  assert.throws(() => ranker.rankEvidence(request, [candidate("alpha.example.com", [industrial, quality])]), /expired/i);
});

test("conflicting source records cannot masquerade behind one URL/time/hash", () => {
  assert.throws(() => makeRanker({ ...run, sources: [source, { ...source, text: "Different content" }] }), /conflicting source/i);
});

test("public organization identifiers must agree with the extracted identity", () => {
  const ranker = makeRanker({ ...run, companies: [{ name: "alpha", officialDomain: "alpha.example.com", publicOrganizationId: "A" }] });
  for (const publicOrganizationId of [undefined, "B", "A"]) {
    const input = candidate("alpha.example.com", [industrial, quality]);
    if (publicOrganizationId !== undefined) input.company.publicOrganizationId = publicOrganizationId;
    const result = ranker.rankEvidence(request, [input])[0]!;
    assert.equal(result.eligible, publicOrganizationId === "A" ? "yes" : "conditional");
  }
});

test("conflicting extracted company names require identity resolution", () => {
  assert.throws(() => makeRanker({ ...run, companies: [
    { name: "alpha", officialDomain: "alpha.example.com" },
    { name: "Different Company", officialDomain: "ALPHA.EXAMPLE.COM" },
  ] }), /conflicting source identity/i);
});

test("the five-minute consumption boundary is inclusive and expires one millisecond later", () => {
  let clock = new Date(Date.parse(run.completedAt) + 300_000);
  const ranker = new EvidenceRanker(run, { now: () => clock });
  assert.equal(ranker.rankEvidence(request, [candidate("alpha.example.com", [industrial, quality])])[0]!.eligible, "yes");
  clock = new Date(clock.getTime() + 1);
  assert.throws(() => ranker.rankEvidence(request, []), /expired/i);
});
