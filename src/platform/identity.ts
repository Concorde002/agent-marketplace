import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { ActorContext, CompanyIdentity, Money, RegistrationInput } from "../contracts.js";
import type { Queryable } from "../payments/postgres-store.js";

export class IdentityError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "IdentityError";
  }
}

function invalid(): never {
  throw new IdentityError(400, "INVALID_REGISTRATION");
}

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
  return record;
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f\u007f-\u009f]/.test(value) || value.trim().length === 0) invalid();
  return value.trim();
}

/** Store the hostname, as used by candidate/account matching. This validates identity, not DNS/SSRF. */
function domain(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || /[\s\\@%?#]/.test(value) || !/^(?:https:\/\/)?[^/]+\/?$/i.test(value)) invalid();
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return invalid();
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || isIP(hostname)) invalid();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) invalid();
  if (/(^|\.)(localhost|local|localdomain|internal|lan|home|onion|arpa)$/.test(hostname)) invalid();
  return hostname;
}

function company(value: unknown): CompanyIdentity {
  const input = object(value, ["name", "officialDomain"], ["publicOrganizationId"]);
  const result: CompanyIdentity = { name: text(input.name, 200), officialDomain: domain(input.officialDomain) };
  if (Object.hasOwn(input, "publicOrganizationId")) result.publicOrganizationId = text(input.publicOrganizationId, 128);
  return result;
}

function money(value: unknown, minimum: number): Money {
  const input = object(value, ["amountMinor", "currency"]);
  if (typeof input.amountMinor !== "number" || !Number.isSafeInteger(input.amountMinor) || input.amountMinor < minimum) invalid();
  if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) invalid();
  return { amountMinor: input.amountMinor, currency: input.currency };
}

/** Date.parse alone rolls impossible calendar dates forward; require an explicit RFC3339 date first. */
function dateTime(value: unknown): string {
  if (typeof value !== "string") invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) invalid();
  const [, y, m, d, h, minute, s, , offsetHour, offsetMinute] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(h) > 23 || Number(minute) > 59 || Number(s) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid();
  return parsed.toISOString();
}

function registration(value: unknown, actor: ActorContext, now: Date): RegistrationInput {
  const input = object(value, ["company", "role", "mandate", "demo"]);
  if (input.demo !== true || (input.role !== "buyer" && input.role !== "supplier")) invalid();
  if (input.role !== actor.role) throw new IdentityError(403, "ROLE_MISMATCH");
  const identity = company(input.company);
  const fields = input.role === "buyer"
    ? ["maximumOrderTotal", "maximumRunTotal", "allowedCategories", "destination", "expiresAt", "sandboxOnly"]
    : ["minimumDeliveredTotal", "availableQuantity", "unit", "earliestDeliveryAt", "expiresAt", "sandboxOnly"];
  const mandate = object(input.mandate, fields);
  if (mandate.sandboxOnly !== true) invalid();
  const expiresAt = dateTime(mandate.expiresAt);
  if (new Date(expiresAt).getTime() <= now.getTime()) throw new IdentityError(403, "MANDATE_EXPIRED");
  if (input.role === "buyer") {
    const maximumOrderTotal = money(mandate.maximumOrderTotal, 1);
    const maximumRunTotal = money(mandate.maximumRunTotal, 1);
    if (maximumOrderTotal.currency !== maximumRunTotal.currency || maximumOrderTotal.amountMinor > maximumRunTotal.amountMinor) invalid();
    if (!Array.isArray(mandate.allowedCategories) || mandate.allowedCategories.length < 1 || mandate.allowedCategories.length > 50) invalid();
    const allowedCategories = mandate.allowedCategories.map((value: unknown) => text(value, 100));
    if (new Set(allowedCategories).size !== allowedCategories.length) invalid();
    return {
      company: identity, role: "buyer", demo: true,
      mandate: { maximumOrderTotal, maximumRunTotal, allowedCategories, destination: text(mandate.destination, 500), expiresAt, sandboxOnly: true },
    };
  }
  if (typeof mandate.availableQuantity !== "number" || !Number.isInteger(mandate.availableQuantity) || mandate.availableQuantity < 1 || mandate.availableQuantity > 2147483647) invalid();
  const earliestDeliveryAt = dateTime(mandate.earliestDeliveryAt);
  if (new Date(earliestDeliveryAt).getTime() > new Date(expiresAt).getTime()) invalid();
  return {
    company: identity, role: "supplier", demo: true,
    mandate: {
      minimumDeliveredTotal: money(mandate.minimumDeliveredTotal, 0), availableQuantity: mandate.availableQuantity,
      unit: text(mandate.unit, 64), earliestDeliveryAt, expiresAt, sandboxOnly: true,
    },
  };
}

function clock(now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new IdentityError(503, "IDENTITY_UNAVAILABLE");
}

/** Tokens are opaque operator-provisioned bearers, not passwords or a self-service signup mechanism. */
export async function authenticate(db: Queryable, token: string, now = new Date()): Promise<ActorContext> {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token)) throw new IdentityError(401, "INVALID_CREDENTIAL");
    clock(now);
    const digest = createHash("sha256").update(token, "utf8").digest("hex");
    const { rows } = await db.query<{ participant_id: string; role: "buyer" | "supplier"; demo: true }>(
      `select p.id as participant_id, p.role, p.demo
         from marketplace.api_credentials c
         join marketplace.participants p on p.id = c.participant_id
         join marketplace.operator_grants g on g.id = p.grant_id and g.role = p.role
        where c.token_hash = $1 and c.revoked_at is null and g.expires_at > $2
          and p.demo = true and g.demo = true`,
      [digest, now.toISOString()],
    );
    const row = rows[0];
    if (!row || row.demo !== true || (row.role !== "buyer" && row.role !== "supplier")) throw new IdentityError(401, "INVALID_CREDENTIAL");
    return { participantId: row.participant_id, role: row.role, demo: true };
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError(503, "IDENTITY_UNAVAILABLE");
  }
}

interface ParticipantGrant {
  id: string;
  role: "buyer" | "supplier";
  demo: boolean;
  registered_at: Date | string | null;
  grant_role: "buyer" | "supplier";
  grant_demo: boolean;
  currency: string;
  expires_at: Date | string;
  allowed_categories: string[] | null;
  max_order_total_minor: string | number | null;
  max_run_total_minor: string | number | null;
  min_delivered_total_minor: string | number | null;
  max_available_quantity: number | null;
}

function withinGrant(input: RegistrationInput, grant: ParticipantGrant): void {
  // Compare pg int8 values as bigint: converting an operator ceiling to Number could round it up.
  let exceeded = new Date(input.mandate.expiresAt).getTime() > new Date(grant.expires_at).getTime();
  const currency = input.role === "buyer" ? input.mandate.maximumOrderTotal.currency : input.mandate.minimumDeliveredTotal.currency;
  exceeded ||= currency !== grant.currency;
  if (input.role === "buyer") {
    exceeded ||= BigInt(input.mandate.maximumOrderTotal.amountMinor) > BigInt(grant.max_order_total_minor!)
      || BigInt(input.mandate.maximumRunTotal.amountMinor) > BigInt(grant.max_run_total_minor!)
      || (grant.allowed_categories !== null && input.mandate.allowedCategories.some((category) => !grant.allowed_categories!.includes(category)));
  } else {
    exceeded ||= BigInt(input.mandate.minimumDeliveredTotal.amountMinor) < BigInt(grant.min_delivered_total_minor!)
      || input.mandate.availableQuantity > grant.max_available_quantity!;
  }
  if (exceeded) throw new IdentityError(403, "MANDATE_EXCEEDS_GRANT");
}

/**
 * Caller MUST provide an open transaction on this Queryable and roll it back on any error.
 * The participant lock lasts through both writes and the caller's idempotency record/commit.
 * Registration is immutable; the caller, not this module, replays stored idempotent responses.
 */
export async function registerIdentity(db: Queryable, actor: ActorContext, input: unknown, now = new Date()): Promise<{ participantId: string }> {
  try {
    clock(now);
    if (actor.demo !== true || !actor.participantId || (actor.role !== "buyer" && actor.role !== "supplier")) throw new IdentityError(403, "IDENTITY_NOT_AUTHORIZED");
    const validated = registration(input, actor, now);
    const { rows } = await db.query<ParticipantGrant>(
      `select p.id, p.role, p.demo, p.registered_at,
              g.role as grant_role, g.demo as grant_demo, g.currency, g.expires_at, g.allowed_categories,
              g.max_order_total_minor, g.max_run_total_minor, g.min_delivered_total_minor, g.max_available_quantity
         from marketplace.participants p join marketplace.operator_grants g on g.id = p.grant_id
        where p.id = $1 for update of p`,
      [actor.participantId],
    );
    const grant = rows[0];
    if (!grant || !grant.demo || !grant.grant_demo) throw new IdentityError(403, "IDENTITY_NOT_AUTHORIZED");
    if (grant.role !== actor.role || grant.grant_role !== actor.role) throw new IdentityError(403, "ROLE_MISMATCH");
    if (new Date(grant.expires_at).getTime() <= now.getTime()) throw new IdentityError(403, "GRANT_EXPIRED");
    if (grant.registered_at !== null) throw new IdentityError(409, "ALREADY_REGISTERED");
    withinGrant(validated, grant);
    if (validated.role === "buyer") {
      const mandate = validated.mandate;
      await db.query(
        `insert into marketplace.mandates
           (participant_id, role, currency, expires_at, sandbox_only, max_order_total_minor, max_run_total_minor, allowed_categories, destination)
         values ($1, 'buyer', $2, $3, true, $4, $5, $6, $7)`,
        [actor.participantId, mandate.maximumOrderTotal.currency, mandate.expiresAt, mandate.maximumOrderTotal.amountMinor,
          mandate.maximumRunTotal.amountMinor, mandate.allowedCategories, mandate.destination],
      );
    } else {
      const mandate = validated.mandate;
      await db.query(
        `insert into marketplace.mandates
           (participant_id, role, currency, expires_at, sandbox_only, min_delivered_total_minor, available_quantity, unit, earliest_delivery_at)
         values ($1, 'supplier', $2, $3, true, $4, $5, $6, $7)`,
        [actor.participantId, mandate.minimumDeliveredTotal.currency, mandate.expiresAt, mandate.minimumDeliveredTotal.amountMinor,
          mandate.availableQuantity, mandate.unit, mandate.earliestDeliveryAt],
      );
    }
    const updated = await db.query<{ id: string }>(
      `update marketplace.participants set company_name = $2, official_domain = $3, public_org_id = $4, registered_at = $5
        where id = $1 and registered_at is null returning id`,
      [actor.participantId, validated.company.name, validated.company.officialDomain, validated.company.publicOrganizationId ?? null, now.toISOString()],
    );
    if (updated.rows.length !== 1) throw new IdentityError(409, "ALREADY_REGISTERED");
    return { participantId: actor.participantId };
  } catch (error) {
    // No SQL details, input values, credentials, causes, or private supplier limits cross this boundary.
    if (error instanceof IdentityError) throw error;
    throw new IdentityError(503, "IDENTITY_UNAVAILABLE");
  }
}
