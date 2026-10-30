# Structured public supplier leads

## Current implementation versus next increment

Current sourcing uses TED for buyer notices and Tavily search/extraction for supplier pages. Tavily is retrieval infrastructure, not a supplier registry. Its documented keyless mode is free and rate-limited; no paid plan or automatic upgrade is enabled. Firecrawl would also be retrieval infrastructure, not a structured supplier catalogue.

The next sourcing increment should use structured procurement award history as the primary supplier-lead source, with independently retrieved official company/capability evidence afterward. This is researched and live-read verified below, **not yet an implemented replacement for current supplier search**. No selected demo company is embedded in these notes or source code.

## TED award notices: primary EU-wide route

`POST https://api.ted.europa.eu/v3/notices/search`, anonymous public access. Unlike active buyer-opportunity collection, award history requires `scope: "ALL"` and `notice-type = can-standard`. Filter by actual category/CPV, country and date, not a preferred supplier.

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

## Poland BZP / e-Zamówienia: useful national extension

Anonymous read endpoint: `GET https://ezamowienia.gov.pl/mo-board/api/v1/notice`. A bounded result-notice query was verified with `NoticeType=TenderResultNotice`, January 2025 publication bounds and `PageSize=1`.

Parent live verification: `2026-10-30T13:50:20.506Z`, one result, response SHA-256 `ada30938ba948831fd9a4b537ce3d54339f439fe34666164d16fe6bb2712ce83`. Fields included buyer identity/national ID, CPV, publication date, procurement object/result and `contractors[]`, each with contractor name, city, country and national ID. No supplier website/domain or current capability was established. This is Poland-only procurement history.

API access/rate limits and redistribution terms must be checked before implementing or storing a wider dataset. Research found an anonymous read route with a documented low request-rate ceiling, not permission to crawl without bounds. Official [integration page](https://ezamowienia.gov.pl/pl/integracja) and linked BZP API documentation are the starting points.

## Identity and capability checks remain separate

- A public company register can corroborate legal identity and declared activity, but not automatically prove a technical capability. Poland REGON BIR is free but requires a production access key; it is not a zero-setup anonymous dependency. BRIS/KRS are not substitutes for capability evidence.
- TED Open Data can express lot/winner relationships more precisely, with coverage limitations. OCDS is a useful common format, not one universal live EU supplier API. No verified anonymous EEN supplier API was established in this research.
- Resolve an official domain using independently cited identity evidence. Keep external-registry subject binding explicit. Then assess actual requirements from official company/certificate/product text. Search indexes and extracted pages may lag.
- Freeze evidence ranking before connected-account lookup. Deterministic account matching uses normalized official domain and, when available, compatible exact public organization IDs. Names/emails are not fuzzy routing authority. Ambiguous matches and unconnected companies remain leads.
- Do not create another persistent supplier database or silently replay a prepared catalogue. Query the public sources during the run and retain immutable scoped evidence snapshots in the existing platform store.
