# Platform workstream

Human owner: teammate 1, GitHub handle unassigned. Agent must read root `AGENTS.md` first.

## Owns

API, authentication, grants, storage/migrations, agreement/payment lifecycle, Stripe sandbox, demo documents, shared contracts/configuration, and the integrated handoff.

## What this means in plain language

1. Put one backend on the internet and publish its tool/API description.
2. Give each bot its own identity and permission limits, then store demo company registrations, requests, and offers.
3. Enforce exact-term agreement, spending limits, ownership, and duplicate-order protection.
4. Execute Stripe sandbox payments and read verified payment status. Create the labeled demo order/invoice document.
5. Expose authorized request/offer/order reads and events so teammate 2's bots can act and report results in their own chats.

This owner implements hosting and Stripe; Jenya does not need to duplicate them. Supplier search/ranking belongs to Jenya + Codex. Actual bot setup, listening, negotiation execution, and in-chat wording belong to teammate 2. No email provider is required.

## Current state

Scaffold implements status/docs endpoints only. Trading endpoints return 501. Typed boundaries are drafts; authentication and runtime validation do not exist. No service is hosted and no Stripe account is configured by this scaffold.

## Next task

Implement scoped participant registration and request creation with runtime validation and disposable storage tests. Coordinate request/offer read APIs with agent owner. Keep auth context server-derived and mandate limits bounded by operator grants. Then integrate sourcing and negotiation incrementally.

## Verification

Run `npm run test:platform` and `npm run check`. Replace this section with observed results in each PR. The existing tests cover only scaffold HTTP behavior and refusal to fake business success.

## Dependencies and context upkeep

Provide working authenticated tools for agent owner and an authorized request/job context for sourcing owner. Update this file in each PR, and `docs/STATUS.md` after integrated merges. Changes to shared files are coordinated here, not independently made by all three agents.
