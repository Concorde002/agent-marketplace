import {
  DEFAULT_NEGOTIATION_DEADLINE_MS,
  DEFAULT_NEGOTIATION_MAX_REVISIONS,
  MAX_NEGOTIATION_DEADLINE_MS,
  MAX_NEGOTIATION_REVISIONS,
} from "./policy.js";
import type { ParticipantRole } from "./types.js";

export type AgentEnvironment = Record<string, string | undefined>;

export interface RequirementConfig {
  key: string;
  description: string;
  mandatory: boolean;
}

export interface BuyerMandateConfig {
  maxOrderMinor: number;
  maxRunMinor: number;
  destination: string;
  expiresAt: string;
  category: string;
  item: string;
  quantity: number;
  unit: string;
  deliverBy: string;
  requirements: RequirementConfig[];
}

export interface SupplierMandateConfig {
  minTotalMinor: number;
  quantity: number;
  unit: string;
  earliestDeliveryAt: string;
  expiresAt: string;
}

export interface AgentConfigBase {
  marketplaceUrl: string;
  token: string;
  companyName: string;
  companyDomain: string;
  companyOrgId?: string;
  currency: string;
  stateDir: string;
  pollIntervalMs: number;
  pollMaxIntervalMs: number;
  negotiationMaxRevisions: number;
  negotiationDeadlineMs: number;
  requestTimeoutMs: number;
  sandboxOnly: true;
}

export interface BuyerAgentConfig extends AgentConfigBase {
  role: "buyer";
  buyer: BuyerMandateConfig;
}

export interface SupplierAgentConfig extends AgentConfigBase {
  role: "supplier";
  supplier: SupplierMandateConfig;
}

export type AgentConfig = BuyerAgentConfig | SupplierAgentConfig;

const DEFAULT_STATE_DIR = ".agent-state";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_MAX_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const POSITIVE_NUMBER_PATTERN = /^\d+(?:\.\d+)?$/;

/** Thrown when configuration is missing or invalid; never includes values. */
export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const unique = [...new Set(variables)];
    super(`Invalid or missing configuration: ${unique.join(", ")}`);
    this.name = "ConfigError";
    this.variables = unique;
  }
}

function readValue(env: AgentEnvironment, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(
  env: AgentEnvironment,
  name: string,
  errors: string[],
): string {
  const value = readValue(env, name);
  if (value === undefined) {
    errors.push(name);
    return "";
  }
  return value;
}

function requireUnsignedInteger(
  env: AgentEnvironment,
  name: string,
  errors: string[],
): number {
  const value = requireString(env, name, errors);
  if (value === "") {
    return 0;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(value)) {
    errors.push(name);
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    errors.push(name);
    return 0;
  }
  return parsed;
}

function optionalUnsignedInteger(
  env: AgentEnvironment,
  name: string,
  fallback: number,
  errors: string[],
): number {
  const value = readValue(env, name);
  if (value === undefined) {
    return fallback;
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(value)) {
    errors.push(name);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    errors.push(name);
    return fallback;
  }
  return parsed;
}

function requirePositiveNumber(
  env: AgentEnvironment,
  name: string,
  errors: string[],
): number {
  const value = requireString(env, name, errors);
  if (value === "") {
    return 0;
  }
  if (!POSITIVE_NUMBER_PATTERN.test(value)) {
    errors.push(name);
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(name);
    return 0;
  }
  return parsed;
}

function requireIsoDate(
  env: AgentEnvironment,
  name: string,
  errors: string[],
): string {
  const value = requireString(env, name, errors);
  if (value === "") {
    return "";
  }
  if (!Number.isFinite(Date.parse(value))) {
    errors.push(name);
  }
  return value;
}

function readRole(
  env: AgentEnvironment,
  errors: string[],
): ParticipantRole | undefined {
  const value = requireString(env, "PARTICIPANT_ROLE", errors);
  if (value === "") {
    return undefined;
  }
  if (value === "buyer" || value === "supplier") {
    return value;
  }
  errors.push("PARTICIPANT_ROLE");
  return undefined;
}

function readMarketplaceUrl(
  env: AgentEnvironment,
  errors: string[],
): string {
  const value = requireString(env, "MARKETPLACE_URL", errors);
  if (value === "") {
    return "";
  }
  try {
    const url = new URL(value);
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    const allowedProtocol =
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLocal);
    if (!allowedProtocol || url.username !== "" || url.password !== "") {
      errors.push("MARKETPLACE_URL");
    }
  } catch {
    errors.push("MARKETPLACE_URL");
  }
  return value;
}

function readCompanyDomain(
  env: AgentEnvironment,
  errors: string[],
): string {
  const value = requireString(env, "COMPANY_DOMAIN", errors);
  if (value === "") {
    return "";
  }
  const domain = value.toLowerCase();
  if (!DOMAIN_PATTERN.test(domain)) {
    errors.push("COMPANY_DOMAIN");
  }
  return domain;
}

function readCurrency(env: AgentEnvironment, errors: string[]): string {
  const value = requireString(env, "CURRENCY", errors);
  if (value === "") {
    return "";
  }
  if (!CURRENCY_PATTERN.test(value)) {
    errors.push("CURRENCY");
    return "";
  }
  return value.toUpperCase();
}

function readRequirements(
  env: AgentEnvironment,
  errors: string[],
): RequirementConfig[] {
  const raw = readValue(env, "BUYER_REQUIREMENTS_JSON");
  if (raw === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push("BUYER_REQUIREMENTS_JSON");
    return [];
  }

  if (!Array.isArray(parsed)) {
    errors.push("BUYER_REQUIREMENTS_JSON");
    return [];
  }

  const requirements: RequirementConfig[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      errors.push("BUYER_REQUIREMENTS_JSON");
      return [];
    }
    const record = entry as Record<string, unknown>;
    const key = record.key;
    const description = record.description;
    const mandatory = record.mandatory;
    if (
      typeof key !== "string" ||
      key.trim() === "" ||
      typeof description !== "string" ||
      typeof mandatory !== "boolean"
    ) {
      errors.push("BUYER_REQUIREMENTS_JSON");
      return [];
    }
    requirements.push({
      key: key.trim(),
      description,
      mandatory,
    });
  }
  return requirements;
}

function readBuyerMandate(
  env: AgentEnvironment,
  errors: string[],
): BuyerMandateConfig {
  return {
    maxOrderMinor: requireUnsignedInteger(env, "BUYER_MAX_ORDER_MINOR", errors),
    maxRunMinor: requireUnsignedInteger(env, "BUYER_MAX_RUN_MINOR", errors),
    destination: requireString(env, "BUYER_DESTINATION", errors),
    expiresAt: requireIsoDate(env, "BUYER_EXPIRES_AT", errors),
    category: requireString(env, "BUYER_CATEGORY", errors),
    item: requireString(env, "BUYER_ITEM", errors),
    quantity: requirePositiveNumber(env, "BUYER_QUANTITY", errors),
    unit: requireString(env, "BUYER_UNIT", errors),
    deliverBy: requireIsoDate(env, "BUYER_DELIVER_BY", errors),
    requirements: readRequirements(env, errors),
  };
}

function readSupplierMandate(
  env: AgentEnvironment,
  errors: string[],
): SupplierMandateConfig {
  return {
    minTotalMinor: requireUnsignedInteger(
      env,
      "SUPPLIER_MIN_TOTAL_MINOR",
      errors,
    ),
    quantity: requirePositiveNumber(env, "SUPPLIER_QUANTITY", errors),
    unit: requireString(env, "SUPPLIER_UNIT", errors),
    earliestDeliveryAt: requireIsoDate(
      env,
      "SUPPLIER_EARLIEST_DELIVERY",
      errors,
    ),
    expiresAt: requireIsoDate(env, "SUPPLIER_EXPIRES_AT", errors),
  };
}

/**
 * Load and validate the process environment. Every missing/invalid variable is
 * reported by name; values are never echoed in the error message.
 */
export function loadConfig(env: AgentEnvironment = process.env): AgentConfig {
  const errors: string[] = [];

  const role = readRole(env, errors);
  const marketplaceUrl = readMarketplaceUrl(env, errors);
  const token = requireString(env, "MARKETPLACE_TOKEN", errors);
  const companyName = requireString(env, "COMPANY_NAME", errors);
  const companyDomain = readCompanyDomain(env, errors);
  const companyOrgId = readValue(env, "COMPANY_ORG_ID");
  const currency = readCurrency(env, errors);
  const stateDir = readValue(env, "AGENT_STATE_DIR") ?? DEFAULT_STATE_DIR;
  const pollIntervalMs = optionalUnsignedInteger(
    env,
    "POLL_INTERVAL_MS",
    DEFAULT_POLL_INTERVAL_MS,
    errors,
  );
  const pollMaxIntervalMs = optionalUnsignedInteger(
    env,
    "POLL_MAX_INTERVAL_MS",
    DEFAULT_POLL_MAX_INTERVAL_MS,
    errors,
  );
  if (pollMaxIntervalMs < pollIntervalMs) {
    errors.push("POLL_MAX_INTERVAL_MS");
  }
  const negotiationMaxRevisions = Math.min(
    optionalUnsignedInteger(
      env,
      "NEGOTIATION_MAX_REVISIONS",
      DEFAULT_NEGOTIATION_MAX_REVISIONS,
      errors,
    ),
    MAX_NEGOTIATION_REVISIONS,
  );
  const negotiationDeadlineMs = Math.min(
    optionalUnsignedInteger(
      env,
      "NEGOTIATION_DEADLINE_MS",
      DEFAULT_NEGOTIATION_DEADLINE_MS,
      errors,
    ),
    MAX_NEGOTIATION_DEADLINE_MS,
  );
  const requestTimeoutMs = optionalUnsignedInteger(
    env,
    "REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    errors,
  );

  const buyer = role === "buyer" ? readBuyerMandate(env, errors) : undefined;
  const supplier =
    role === "supplier" ? readSupplierMandate(env, errors) : undefined;

  if (errors.length > 0) {
    throw new ConfigError(errors);
  }

  const base: AgentConfigBase = {
    marketplaceUrl,
    token,
    companyName,
    companyDomain,
    ...(companyOrgId === undefined ? {} : { companyOrgId }),
    currency,
    stateDir,
    pollIntervalMs,
    pollMaxIntervalMs,
    negotiationMaxRevisions,
    negotiationDeadlineMs,
    requestTimeoutMs,
    sandboxOnly: true,
  };

  if (role === "buyer" && buyer !== undefined) {
    return { ...base, role: "buyer", buyer };
  }
  if (role === "supplier" && supplier !== undefined) {
    return { ...base, role: "supplier", supplier };
  }

  // Unreachable after validation; keeps the return type exhaustive.
  throw new ConfigError(["PARTICIPANT_ROLE"]);
}
