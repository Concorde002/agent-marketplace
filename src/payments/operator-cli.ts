/**
 * Operator-only setup for the Stripe sandbox. Never exposed as an HTTP route or agent tool.
 * Reads STRIPE_SECRET_KEY from the environment (see docs/workstreams/platform.md).
 */
import { parseArgs } from "node:util";
import { PaymentConfigError, readStripeConfig } from "./config.js";
import { StripeApiError, StripeClient, StripeSandboxProvider } from "./stripe.js";
import type { PaymentCredential } from "./types.js";

/**
 * Stripe test PaymentMethods. `setup` cards go through a SetupIntent, as a real buyer's card would.
 * `auth-required` is attached without setup on purpose, so its off-session charge demands authentication.
 */
const CARDS = {
  visa: { paymentMethod: "pm_card_visa", via: "setup", expect: "off-session charges succeed" },
  decline: { paymentMethod: "pm_card_chargeCustomerFail", via: "setup", expect: "setup succeeds, charges are declined" },
  "auth-required": { paymentMethod: "pm_card_authenticationRequiredOnSetup", via: "attach", expect: "off-session charges return requires_action" },
} as const;
type CardScenario = keyof typeof CARDS;

const USAGE = `Usage:
  payments:operator -- setup-buyer --participant <id> --name <company> [--card visa|decline|auth-required]
  payments:operator -- smoke-charge --customer <cus_…> --payment-method <pm_…> [--amount 1000] [--currency EUR]`;

async function setupBuyer(client: StripeClient, participantId: string, name: string, card: CardScenario): Promise<PaymentCredential> {
  const scenario = CARDS[card];
  const customer = await client.postOk<{ id: string }>("/customers", {
    name: `${name} (demo)`,
    description: "Agent Marketplace demo buyer. Simulated company representation; sandbox only.",
    "metadata[participant_id]": participantId,
    "metadata[demo]": "true",
  });

  let paymentMethodId: string;
  if (scenario.via === "setup") {
    const setup = await client.postOk<{ id: string; status: string; payment_method: string | null }>("/setup_intents", {
      customer: customer.id,
      payment_method: scenario.paymentMethod,
      "automatic_payment_methods[enabled]": true,
      "automatic_payment_methods[allow_redirects]": "never",
      usage: "off_session",
      confirm: true,
      "metadata[participant_id]": participantId,
      "metadata[demo]": "true",
    });
    if (setup.status !== "succeeded" || !setup.payment_method) {
      throw new Error(`SetupIntent ${setup.id} ended in status ${setup.status}; the card is not saved for off-session use`);
    }
    paymentMethodId = setup.payment_method;
  } else {
    const attached = await client.postOk<{ id: string }>(`/payment_methods/${scenario.paymentMethod}/attach`, { customer: customer.id });
    paymentMethodId = attached.id;
  }
  return { participantId, stripeCustomerId: customer.id, stripePaymentMethodId: paymentMethodId, sandboxOnly: true };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      participant: { type: "string" },
      name: { type: "string" },
      card: { type: "string", default: "visa" },
      customer: { type: "string" },
      "payment-method": { type: "string" },
      amount: { type: "string", default: "1000" },
      currency: { type: "string", default: "EUR" },
    },
    strict: true,
  });
  const client = new StripeClient(readStripeConfig(process.env));

  if (command === "setup-buyer") {
    if (!values.participant || !values.name) throw new UsageError();
    if (!(values.card in CARDS)) throw new UsageError(`unknown --card ${values.card}`);
    const card = values.card as CardScenario;
    const credential = await setupBuyer(client, values.participant, values.name, card);
    console.error(`Saved test card "${card}" (${CARDS[card].expect}). Store this record server-side; do not commit it.`);
    console.log(JSON.stringify(credential, null, 2));
    return 0;
  }

  if (command === "smoke-charge") {
    const customer = values.customer;
    const paymentMethod = values["payment-method"];
    if (!customer || !paymentMethod) throw new UsageError();
    const orderId = `smoke-${Date.now()}`;
    const outcome = await new StripeSandboxProvider(client).createPayment({
      orderId,
      amount: { amountMinor: Number(values.amount), currency: values.currency.toUpperCase() },
      customerRef: customer,
      paymentMethodRef: paymentMethod,
      idempotencyKey: `smoke:${orderId}`,
    });
    console.log(JSON.stringify({ orderId, ...outcome }, null, 2));
    return outcome.status === "succeeded" ? 0 : 1;
  }

  throw new UsageError(command ? `unknown command ${command}` : undefined);
}

class UsageError extends Error {}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
  if (error instanceof UsageError) console.error(`${error.message ? `${error.message}\n` : ""}${USAGE}`);
  else if (error instanceof PaymentConfigError || error instanceof StripeApiError) console.error(error.message);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
