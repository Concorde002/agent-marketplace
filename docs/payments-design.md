# How payments work

Stripe **sandbox** only: test cards, no real money. Owner: platform. Evidence and details: [platform.md](workstreams/platform.md).

## The idea

A person sets up the buyer's card and spending limits **once, before the demo**. After that, the bots can make a deal and pay without anyone approving each step. The bots never see the card, Stripe, or any secret. They only say "pay order 7". The backend checks the rules and charges the card.

## Who has what

| | Has | Never has |
|---|---|---|
| **Buyer** | A saved test card in Stripe, and spending limits | Its card details in our system |
| **Supplier** | Its own limits (lowest price, how much it can sell) | A Stripe account in the demo. It gets the result, not money |
| **Marketplace (our backend)** | The one Stripe account and the database | Anyone else's Stripe key |
| **Bots** | A login token, and the right to act within their limits | Cards, keys, or any way to raise their limits |

## Setup, once

1. Run the setup script ([operator-cli.ts](../src/payments/operator-cli.ts)): it creates the buyer in Stripe and saves a test card.
2. Store the card's two Stripe IDs (`cus_…`, `pm_…`) in the database. These are references, not card numbers.
3. Set each side's limits, for example "at most €5,000 per order and €8,000 in total".
4. In Stripe, point the webhook at `https://<our service>/webhooks/stripe`.

## One payment, step by step

1. Both bots accept the same offer, and the database creates one order.
2. The buyer bot asks to pay that order.
3. The backend checks: is this the order's buyer? Is the price within the limits? The price always comes from the order, never from the bot.
4. The backend tells Stripe to charge the saved card. The order ID labels the request, so a repeat never charges twice.
5. Stripe confirms with a webhook. The backend checks that it really came from Stripe and marks the order paid.
6. Both bots are told once, and each reports the result in its own chat.

## Safety rules

- **The bots can't change the money.** The amount comes from the agreed offer, and the limits come from the operator.
- **One payment per order**, even if a request is retried or two arrive at once. The database enforces this.
- **Only Stripe decides "paid".** A bot saying "done" changes nothing.
- **Fake or repeated webhooks don't count.** A bad signature is rejected, and a duplicate is applied once.
- **Live keys are refused.** The backend won't start with a real-money Stripe key.

## When things go wrong

| What happens | Result |
|---|---|
| Card declined | The order stays agreed. The payment is marked "failed", with the reason. |
| The bank wants the cardholder to confirm | Marked "needs action". We stop; we never get around it. |
| Over the limit | Refused before Stripe is called. |
| Our server crashes mid-payment | Stripe's webhook still marks it paid. |

## Status

- **Working:** charging a saved card, checking webhooks, saving to Supabase, and the setup script. All of this is proven against the real Stripe sandbox, including a webhook delivered to Cloud Run.
- **Not built yet:** the "pay this order" endpoint, which needs bot login and orders first.

## In a real product, later

- **Suppliers get paid** through Stripe Connect. Each supplier links its own Stripe account, and we keep only its account ID, never its key.
- **Buyers add their own card**, or use bank debit or invoices, and approve their own limits.
- **Live keys**, a fee for the marketplace, and handling refunds and disputes.

## Where the code is

[settlement.ts](../src/payments/settlement.ts) holds the rules. [stripe.ts](../src/payments/stripe.ts) talks to Stripe. [webhook.ts](../src/payments/webhook.ts) checks signatures. [postgres-store.ts](../src/payments/postgres-store.ts) saves to the database. [The migration](../supabase/migrations/20261030120000_initial_schema.sql) makes the database enforce the rules.
