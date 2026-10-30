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
