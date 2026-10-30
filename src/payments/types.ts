import type { IsoDateTime, Money, OrderId, ParticipantId } from "../contracts.js";

/** Operator-provisioned, server-only. Never part of RegistrationInput and never returned to a participant. */
export interface PaymentCredential {
  participantId: ParticipantId;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  sandboxOnly: true;
}

export type PaymentStatus = "creating" | "pending" | "requires_action" | "succeeded" | "failed";

export interface PaymentAttempt {
  orderId: OrderId;
  buyerId: ParticipantId;
  supplierId: ParticipantId;
  amount: Money;
  idempotencyKey: string;
  status: PaymentStatus;
  createdAt: IsoDateTime;
  providerPaymentId?: string;
  failureCode?: string;
}

export type PaymentOutcome =
  | { status: "succeeded" | "pending" | "requires_action"; providerPaymentId: string }
  | { status: "failed"; providerPaymentId?: string; code: string };

export interface PaymentAttemptInput {
  orderId: OrderId;
  amount: Money;
  customerRef: string;
  paymentMethodRef: string;
  idempotencyKey: string;
}

export interface PaymentProvider {
  readonly sandboxOnly: true;
  createPayment(input: PaymentAttemptInput): Promise<PaymentOutcome>;
}

export const TERMINAL: ReadonlySet<PaymentStatus> = new Set(["succeeded", "failed"]);
