# Structured public supplier leads

## First demo implementation

`src/sourcing/directory.ts` implements the lean first path: TED supplier leads plus Poland BZP buyer notices. It uses the existing bounded native Fetch transport and adds no dependency. HTTP/MCP mounting and directory-mode account resolution remain platform/agent work, not implemented by the adapter. The older TED buyer plus Tavily page-assessment workflow remains separate, not a prerequisite.

See [ADR 0001](architecture/0001-lean-procurement-directory.md) for search semantics, identity/unknown boundaries, open-source reuse and owner handoffs. No selected demo company is embedded in these notes or source code. General website capability verification is not mandatory for this directory path; unproved capability remains unknown.

## TED award notices: primary EU-wide route

`POST https://api.ted.europa.eu/v3/notices/search`, anonymous public access. Unlike active buyer-opportunity collection, award history requires `scope: "ALL"` and `notice-type = can-standard`. The implemented filters are category/CPV, plain keywords and publication dates, not a preferred supplier. Country is returned where unambiguous, but no country-filter input is currently exposed.

Example verified request fields:

```json
{
  "query": "publication-date > 20250101 AND notice-type = can-standard",
  "fields": ["publication-number", "publication-date", "notice-type", "classification-cpv", "winner-name", "winner-identifier", "winner-country", "winner-internet-address", "winner-selection-status"],
  "page": 1,
  "limit": 2,
  "scope": "ALL",
  "checkQuerySyntax": false,
  "onlyLatestVersions": true
}
```

Parent live verification: `2026-10-30T13:48:07.184Z`, two `can-standard` notices, `timedOut: false`, response SHA-256 `88e6e4dd3b2bd599de303d20b10cdc5e833d617b79401059d4773725d07bbdc9`. Both had winner names, identifiers, countries and CPV fields. Neither supplied a winner internet address. A response hash/time documents this API read, not original-site freshness or a qualification decision.

Award notices identify organizations **reported to have won previous contracts**. This is systematic historical category evidence, not current inventory, price, certification, capacity or willingness to trade. `winner-identifier` varies by publisher and is not automatically a stable EU-wide company ID. Repeated lot/winner arrays must not be zipped by position: exact relationships may require the official notice XML or eProcurement RDF. Missing or ambiguous linkage stays explicit.

Official references: [Search API](https://docs.ted.europa.eu/api/latest/search.html), [API schema](https://api.ted.europa.eu/api-v3.yaml), [field list](https://docs.ted.europa.eu/ODS/latest/reuse/field-list.html).

## Poland BZP / e-Zamówienia: buyer needs

Anonymous read endpoint: `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice`. A bounded result-notice query was verified with `NoticeType=TenderResultNotice`, January 2025 publication bounds and `PageSize=1`.

The implemented buyer path instead selects **`ContractNotice`**, with required publication bounds and page size, optional `CpvCode`/`OrderObject`. It preserves buyer identity, order object, CPV and deadline. Live BZP CPV strings contain Polish labels, for example `39100000-3 (Meble)`; parsing is covered by a regression test. Publication timestamps can have seven fractional digits. Deadlines without timezone remain unknown, not silently converted.

Parent live verification: `2026-10-30T13:50:20.506Z`, one result, response SHA-256 `ada30938ba948831fd9a4b537ce3d54339f439fe34666164d16fe6bb2712ce83`. Fields included buyer identity/national ID, CPV, publication date, procurement object/result and `contractors[]`, each with contractor name, city, country and national ID. No supplier website/domain or current capability was established. This is Poland-only procurement history.

API access/rate limits and redistribution terms must be checked before implementing or storing a wider dataset. Research found an anonymous read route with a documented low request-rate ceiling, not permission to crawl without bounds. Official [integration page](https://ezamowienia.gov.pl/pl/integracja) and linked BZP API documentation are the starting points.

## Identity and capability checks remain separate

- A public company register can corroborate legal identity and declared activity, but not automatically prove a technical capability. Poland REGON BIR is free but requires a production access key; it is not a zero-setup anonymous dependency. BRIS/KRS are not substitutes for capability evidence.
- TED Open Data can express lot/winner relationships more precisely, with coverage limitations. OCDS is a useful common format, not one universal live EU supplier API. No verified anonymous EEN supplier API was established in this research.
- The richer website-evidence path may resolve official domains and assess certificates. The lean path does not fabricate those fields or depend on that optional workflow.
- Freeze comparison before connected-account lookup. Platform must establish compatible identifier scheme/country and unique exact identity, not raw cross-country identifier equality. Names/emails are not fuzzy routing authority. Ambiguous matches and unconnected companies remain leads.
- Do not create another persistent supplier database or silently replay a prepared catalogue. Query the public sources during the run and retain immutable scoped evidence snapshots in the existing platform store.

## Implemented adapter live proof and repeatable check

At `2026-10-30T14:20:47.992Z`, `findSuppliers` with CPV `39100000`, publication dates `2025-01-01` through `2026-10-30`, limit 3 returned 3 supplier leads. One had an unambiguous source-reported identifier; two preserved ambiguous identities as unknown. Response hash: `sha256:a6fbb5f0a5a6d3b5ccaa6201ed150b4d8b90ac378dfc229ec4f7688e872dc751`.

At `2026-10-30T14:20:48.245Z`, `findBuyers` with CPV `39100000`, dates `2026-10-01` through `2026-10-30`, limit 2 returned 2 buyer needs with identifiers and zero record errors. One submission deadline was past and one future at retrieval. Response hash: `sha256:d0564889042331656931af976e42751517a2222591ea4b71422ac41d10f70d64`. Both bounded pages indicated more may exist. No selected company identities or private case inputs are published here.

After the review's timestamp-validation fix, the BZP query was independently rerun at `2026-10-30T14:23:49.919Z`: the same response hash, 2 entries, zero record errors, one past and one future deadline. Final local suite: 316 passed/4 TODO, sourcing 73 passed/2 TODO, integration 12 passed/2 TODO. No failures/cancellations. These are source and disposable-fixture observations, not hosted business-flow evidence.

TED literal-keyword query `FT ~ "furniture"` separately returned HTTP 200 through the implemented adapter at `2026-10-30T14:17:04.753Z`, response hash `sha256:8021d74ab8198bb54579366c282b8c93f36213bbb4e3adbc59d815252f299e9b`. Full-text can match any notice text; it is not a verified supplier capability.

Anonymous public read only, no credentials or database needed:

```sh
npm run build
node --input-type=module <<'JS'
import { ProcurementDirectory } from './dist/src/sourcing/directory.js';
const directory = new ProcurementDirectory();
const query = { cpvCode: '39100000', publishedFrom: '2026-10-01', publishedTo: '2026-10-30', limit: 3 };
for (const operation of ['findSuppliers', 'findBuyers']) {
  const result = await directory[operation](query);
  console.log(JSON.stringify({ operation, source: result.source,
    count: result.entries.length, coverage: result.coverage, errors: result.sourceErrors,
    deadlineStatuses: result.entries.map(entry => entry.deadlineStatus) }, null, 2));
}
JS
```

Choose a relevant current date window for a rehearsal, inspect actual records privately for case selection, and do not call expired notices active. This check proves source retrieval only, not HTTP/MCP mounting, comparison, connected-account identity, agreement or payment. Query/date/limit plus the exact response hash must accompany any stored platform run. Repeated reads can return the same hash legitimately; no cached fallback is used.


Continuation verification at `2026-10-30T14:36:08Z`: two bounded anonymous calls through the built adapter returned 10 BZP buyer needs (2 future, 8 past deadlines; zero normalization errors) and 20 TED supplier lead rows from 10 award notices (6 notices with explicitly unbound identity fields). Both pages report more may exist. BZP response hash `sha256:482315992ae631a614b60533dfc8eb6370b378c0d7b8a98b38977bea64d47985`; TED response hash `sha256:8e7ce34859372dd37b51860458e4024d5ad1f4b277a621c9f2ec611c12d49ca5`. These results establish live retrieval, not compatible suppliers or a qualified demo pair. Exact candidate identities remain private evaluator research, outside public fixtures and discovery inputs.
