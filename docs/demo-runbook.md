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

The current follow-up adds direct supplier-search and content-extraction API clients. No custom website crawler is part of the chosen production path. The client agent interprets the retrieved text; the platform validates source provenance and applies deterministic rules. Higher-quota keys, if needed, require secure operator configuration, never prompts or committed files. Qualify cases through independent fresh runs. [Case-selection rules](demo-cases.md) expose no prepared identities and are not a candidate database.

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
3. **The client agent owns free-text semantic interpretation and uses its own model credits. There is no backend LLM provider to configure.** It proposes structured assessments against server-issued source IDs. The deterministic platform validates quotations, identity/source bindings, standards and ranking inputs. It must not accept caller-supplied trusted run contexts, hashes or policy changes. The evidence-read/assessment tools need the shared coordination in [issue #5](https://github.com/yauhenifutryn/agent-marketplace/issues/5).
4. The ranker applies the fixed rule. Only after the ranking is frozen may the platform resolve independently researched public identities to connected demo representatives. The platform remains authoritative for policies, exact-offer acceptance, order state and sandbox payment.

Both demand and supply must be inspectable in structured tool results and bot chats: buyer/source/need, mandatory standards and editions, supplier/source/claim, match/mismatch/unknown and supporting quotations. This does not require a new frontend. Supplier-led opportunity search is also useful, but the current shared service exposes buyer-request discovery only; coordinate any supplier-facing read tool with the platform owner instead of inventing a second API.

Use the TED API plus a supplier-search API and an API that returns cited source text or registry records. Add another procurement/registry API only for a concrete missing requirement or better accessible backup, not to maximize connector count. Respect source terms and avoid restricted/export-controlled or private data. Keep demo-case notes outside research-agent filesystem/context, clear prior candidate/evidence state between runs, and retain immutable audit/order history.

## API-direct supplier research

`TavilySearch` and `TavilyExtract` call only the fixed public `https://api.tavily.com/search` and `/extract` endpoints. The selected initial access mode is the documented free, rate-limited `X-Tavily-Access-Mode: keyless` mode. No account, paid billing, provider LLM account, MCP installation or extra dependency was introduced. Operator-injected bearer access can replace keyless mode when higher limits are explicitly provisioned; the code never signs up or silently upgrades a plan.

- Search returns bounded lead URLs and index snippets. Scores, snippets and provider instructions never become verified capability claims or a forced candidate selection. The API may return irrelevant news, directories or listicles. The client agent must assess/refine the search independently.
- Extraction submits a batch of at most five HTTPS source URLs, requests basic plain-text output and checks both success/failure arrays, including HTTP 200 partial failures. Only requested URLs can become documents. Conflicting duplicates, oversized/empty text and omitted sources remain errors.
- No source website URL is dialed by this backend. Outbound calls use fixed API destinations with no redirects, cookies or referrers and explicit time/byte limits. Source URL syntax rejects credentials, ports, IP literals and private/local hostnames before submission. The provider operates its own upstream retrieval; this is not a claim that our backend controls that provider's DNS/redirect policy.
- Each document records `method: provider-api-extract`, an extracted-text hash and the API response's URL, completion time and response-body hash. `originRetrievedAt` is `null`: the API does not report when it actually fetched the original site. Do not call the extracted-text hash the hash of original HTML or claim guaranteed origin freshness, current inventory or certificate validity.
- Keyless quota errors and provider failures terminate/report that phase. There are no automatic retries or saved-result fallback. API response text, including rate-limit sign-up instructions, is untrusted data and cannot change configuration, credentials, policy or payment routing.

Live local proof on 2026-10-30: a generic supplier query returned three leads at `12:19:47.493Z`, search-response hash `sha256:02b434a101292325e5f825835c9968e4e930cbf6d45707d93b113fe896532a7d`; one API batch returned three text documents at `12:19:48.414Z`, API-response hash `sha256:48362549cf647dc9ec67d9131e2633686efeef9dfec1f8c3ed63215173cefaae`. No original-source retrieval times or supplier eligibility were established. Selected company identities remain outside the public runbook.

Official API references: [keyless access](https://docs.tavily.com/documentation/keyless.md), [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract.md). Managed extraction supplies evidence text, not our application's semantic matching decision.

For a stronger live demonstration, show a blind discovery receipt with queries, timestamps, source hashes and the ranking before account lookup. Then change a mandatory standard or deadline and show a reasoned refusal. Those are proposed integration checks, not an implemented live demonstration. Simulated buyer/supplier API clients can test protocol behavior locally; only real separate client sessions prove Grok/Instinct compatibility.

## Independent testing with TesterArmy e2e, investigated but not installed

The official [TesterArmy e2e framework](https://e2e.tester.army/) can use a configured model/subscription for agent steps or expose deterministic app tools through its MCP server to an external coding agent. Those are different modes: a Grok model inside the runner is not proof that a particular Grokbot client works. The runner's configured provider pays for its model calls; an external bot pays for its own reasoning. Backend semantic extraction, if added, is a separate model budget.

This project is backend-only. The shipped e2e engines target web/mobile apps, so a marketplace API tool adapter/custom executor or engine integration must be designed first. Do not invent a frontend, expose an admin console or add a public tunnel just to satisfy the runner. Start with disposable deterministic API integration tests; add independent agent exploration after actual marketplace routes work.

Before enabling it:

- Coordinate package/configuration changes with the platform owner and MCP/client adapters with the agent owner. No TesterArmy package, skill or MCP server was installed by this increment.
- The inspected npm release `e2e@0.21.3` requires Node `^22.22.3 || >=24.8.0`; this checkout's observed runtime was `22.22.2`. Updating to a supported Node 22 patch also preserves the project's existing Node 22 engine constraint.
- Choose/provision the model account securely and cap model calls, actions, elapsed time and cost. Keep buyer/supplier credentials separate and inject them through the test tool boundary, not prompts or reports. Do not grant deployment, production data, cloud/provider secrets or real-payment access.
- Use fresh sessions and `cache: 'off'` or `e2e run --no-cache` for independent-discovery acceptance. The framework normally replays verified actions; changing models alone does not invalidate that replay cache. Its `explore`/MCP exploration sessions do not use replay, but tests launched through an MCP session can. Inspect reports, model usage and actual fresh source receipts, not an agent's success statement alone.
- Give testers generic need/constraint descriptions and tool documentation only. Never supply prepared supplier identities, saved candidate lists or private rehearsal notes. Prevent filesystem access to evaluator material. Keep platform account resolution after the independently frozen rank.

The eventual black-box suite should cover fresh buyer/supplier/standards evidence, unchanged evidence rank when registration changes, missing certification staying unknown, expired/source-failure paths, incompatible budget/deadline refusal, participant isolation, retries and accurate authoritative order/payment reporting. Require machine assertions and reproducible failures in addition to semantic critique. No live E2E, named-bot compatibility or sandbox settlement has been established yet.

Sources inspected: [models](https://e2e.tester.army/docs/models.md), [project tools](https://e2e.tester.army/docs/tools.md), [MCP server](https://e2e.tester.army/docs/reference/mcp.md), [replay cache](https://e2e.tester.army/docs/cache.md). Published support is not a verified integration with the team's selected bots.
