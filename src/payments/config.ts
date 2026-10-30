/** Server-held Stripe configuration. Never pass these values to an agent, a response body, or a log line. */
export interface StripeConfig {
  secretKey: string;
  webhookSecret?: string;
}

export class PaymentConfigError extends Error {}

// Sandbox and test-mode keys share these prefixes; live keys use sk_live_/rk_live_.
const SANDBOX_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9]+$/;

export function readStripeConfig(env: Record<string, string | undefined>, options: { requireWebhookSecret?: boolean } = {}): StripeConfig {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new PaymentConfigError("STRIPE_SECRET_KEY is not set");
  // MVP_LIMIT: sandbox only. Live keys are refused outright; real money needs a reviewed Connect design.
  if (!SANDBOX_KEY.test(secretKey)) {
    throw new PaymentConfigError("STRIPE_SECRET_KEY must be a sandbox/test key (sk_test_ or rk_test_); live keys are refused");
  }
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (webhookSecret !== undefined && webhookSecret !== "" && !WEBHOOK_SECRET.test(webhookSecret)) {
    throw new PaymentConfigError("STRIPE_WEBHOOK_SECRET must start with whsec_");
  }
  if (options.requireWebhookSecret && !webhookSecret) throw new PaymentConfigError("STRIPE_WEBHOOK_SECRET is not set");
  return webhookSecret ? { secretKey, webhookSecret } : { secretKey };
}
