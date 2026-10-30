# First live procurement retrieval

This increment is a local module, not a hosted endpoint or a complete demo. Node 22, `npm ci --ignore-scripts`, no credentials. Automated tests use synthetic responses; the following command makes a separate live read of the public TED API.

```sh
npm run build
node --input-type=module <<'JS'
import { TedClient } from './dist/src/sourcing/ted.js';

try {
  const result = await new TedClient().search({
    query: 'publication-date >= 20261001 AND notice-type = cn-standard SORT BY publication-date DESC',
    limit: 5,
    scope: 'ACTIVE',
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.sourceErrors.length) process.exitCode = 1;
} catch (error) {
  console.error({ code: error.code, url: error.url, message: error.message });
  process.exitCode = 1;
}
JS
```

Change the category/date window when researching another case; do not add the desired supplier's identity to force a match. Empty results are legitimate. Errors must remain visible; never substitute a fixture or a previous run.

## Interpret the result

- `source.url` and each notice's `evidence.url` identify the API endpoint actually retrieved. `noticeUrl` is a constructed official reading link, **not a claim that the HTML was fetched**.
- `retrievedAt` is completion time; `contentHash` is SHA-256 over the exact response-body bytes exposed by Fetch, before decoding/normalization. Quotations preserve source text and language. No legal authority, current stock or offer follows from a quotation.
- `onlyLatestVersions: true` and explicit `checkQuerySyntax: false` are sent. TED's `checkQuerySyntax: true` only validates a query and returns no search results.
- `noticeType` preserves the source value. `can-standard` is an award, not a current requirement. Even a competition notice under `ACTIVE` needs deadline, lot and cancellation/correction review before claiming an open opportunity.
- Publication dates remain calendar strings with original suffixes, not invented timestamps. Tender and request-to-participate deadline arrays are separate, raw and **unpaired** across lots. Missing values are empty arrays; missing notice type is `null`. No delivery date is derived from them.
- Check `sourceErrors` even when some notices are returned. Invalid individual records are excluded and reported by index. HTTP/network/time/size/JSON/envelope failures throw `TedSourceError` with a fixed source URL and a stable error code. A timed-out TED search is not accepted as complete.
- Defaults: first page, five records, `ACTIVE`. MVP ceilings: ten records/call, first twenty pages, 2 MiB response body, ten-second end-to-end timeout (configurable up to fifteen seconds), no automatic retries.
- No response-selected URL is fetched. The only outbound destination is the fixed TED HTTPS endpoint; redirects fail, outbound cookies/credentials are omitted. This is **not** an arbitrary-URL supplier fetcher. That needs its own DNS/private-address/redirect protections before integration.
- All retrieved text is untrusted data. Never execute it, derive tool calls from its instructions, or let it modify mandates/payment configuration.

## Verification and next boundary

Run `npm run test:sourcing` and `npm run check`; `npm run test:e2e` currently has TODOs only. Those TODOs do not prove integration. Tests do not call live sources or shared databases.

The platform owner can consume `TedClient` internally without a shared-contract change. This module does not implement `SourcingService.discover`, schedule jobs or persist audit artifacts. Before that integration, coordinate discovery ID allocation, authoritative result storage and partial-source-failure handling with the platform owner. The agent owner continues to consume only the platform boundary, not this low-level adapter. Keep private rehearsal material outside every agent's accessible context.

Next increment: implement one permitted supplier-search route and a safe public-page boundary, then extract supported requirements into existing `Evidence` / `Candidate` types. Search keys, if needed, require secure operator configuration, never prompts or committed files. Qualify cases through independent fresh runs. [Case-selection rules](demo-cases.md) expose no prepared identities and are not a candidate database.

Official references inspected: [Search API](https://docs.ted.europa.eu/api/latest/search.html), [live API specification](https://api.ted.europa.eu/api-v3.yaml). Native Web Fetch, URL, streams, TextDecoder and Web Crypto are sufficient for this narrow adapter; no dependency or MCP server was added.

## Blind evidence ranking, local module only

`EvidenceRanker` in `src/matching/evidence.ts` implements the existing `rankEvidence` signature, not offer comparison or a hosted endpoint. Construct it once per request with **trusted backend retrieval/extraction output**, never a bot-supplied `EvidenceRun`:

- Run context binds the request ID, server-controlled start/completion times, source snapshots and public-source company identities. Collection lasts at most five minutes and a completed context expires after five minutes. Old contexts cannot be reused through a long-lived ranker.
- A claim counts only when the URL, timestamp, hash and verbatim quotation match an in-window source snapshot on the company's official domain, and its name/domain/public-ID combination matches the run's extracted public identity. Unknown or conflicting identities need clarification.
- The qualifying/conditional shortlist sorts by sourced matching requirement count, then number of sourced known outcomes, then canonical public identity. Sourced mandatory mismatches are excluded from that shortlist and retained at the end as explicit `eligible: no` explanations. Duplicate claims cannot inflate scores; a sourced contradiction wins over a positive claim for the same requirement.
- Missing mandatory evidence is conditional. This applies to standards, editions, dimensions, geography and every other requirement key, not only product categories. No stock, price or commercial offer is inferred.
- Registration flags, participant IDs and other extra candidate fields are ignored and stripped. Source snapshots and outputs are copied; candidate input order does not break ties.

**Important limit:** exact quote containment is not semantic entailment, certificate validation, legal identity verification or proof that a network request happened. A fabricated raw run object could forge metadata. The future backend collector must form this internal context from actual fresh fetches, bind hashes to retrieved bodies, verify/extract company identities and supply correctly assessed semantic outcomes. There is deliberately no HTTP tool that accepts raw run contexts as authoritative. `eligible: yes` is an evidence-ranking result, never permission to transact. These integration prerequisites remain unfinished and must be coordinated with the platform owner.

External certificate-registry evidence currently remains unknown unless it is on the company domain. Support needs verified certificate-subject binding, not a desired-company exception list. Unknown certification, equivalence and expired certificates must not be promoted by an LLM's confidence.

## Bot and platform responsibilities

Current code uses no hosted LLM and consumes no platform model tokens. The integrated design is hybrid:

1. A buyer or supplier bot uses its own configured model/account to interpret its human's task and negotiate through authenticated platform tools. No bot product compatibility is assumed from its name.
2. Platform code retrieves demand, buyer identities and original requirement evidence from TED, and supplier capabilities from one permitted search provider plus official pages. Structured fields are parsed deterministically.
3. Free-text semantic extraction inside `SourcingService.discover` needs a separately configured, bounded server-side model or another explicitly agreed extractor. It does not inherit a caller's Grok subscription or API key. That provider/key/cost decision is not implemented yet. Bot-supplied claims cannot bypass provenance/identity checks.
4. The ranker applies the fixed rule. Only after the ranking is frozen may the platform resolve independently researched public identities to connected demo representatives. The platform remains authoritative for policies, exact-offer acceptance, order state and sandbox payment.

Both demand and supply must be inspectable in structured tool results and bot chats: buyer/source/need, mandatory standards and editions, supplier/source/claim, match/mismatch/unknown and supporting quotations. This does not require a new frontend. Supplier-led opportunity search is also useful, but the current shared service exposes buyer-request discovery only; coordinate any supplier-facing read tool with the platform owner instead of inventing a second API.

Use TED plus supplier search and official capability/certificate sources first. Add another procurement portal only for a concrete missing requirement or better accessible backup, not to maximize connector count. Respect source terms and avoid restricted/export-controlled or private data. Keep demo-case notes outside research-agent filesystem/context, clear prior candidate/evidence state between runs, and retain immutable audit/order history.

For a stronger live demonstration, show a blind discovery receipt with queries, timestamps, source hashes and the ranking before account lookup. Then change a mandatory standard or deadline and show a reasoned refusal. Those are proposed integration checks, not an implemented live demonstration. Simulated buyer/supplier API clients can test protocol behavior locally; only real separate client sessions prove Grok/Instinct compatibility.
