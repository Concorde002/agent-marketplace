import type { MatchingService, Offer, SourcingRequest } from "../contracts.js";

type RecordValue = Record<string, unknown>;

interface ValidatedRequest {
  id: string;
  buyerId: string;
  quantity: number;
  unit: string;
  destination: string;
  maximumDeliveredTotal: number;
  currency: string;
  deliverBy: number;
  requirementKeys: Set<string>;
  mandatoryKeys: Set<string>;
}

interface RankedOffer {
  offer: Offer;
  amountMinor: number;
  deliveryAt: number;
}

const offerFields = [
  "id", "requestId", "buyerId", "supplierId", "previousOfferId", "quantity", "unit", "destination",
  "deliveredTotal", "taxMinor", "deliveryMinor", "deliveryAt", "expiresAt", "confirmedRequirementKeys",
  "termsOrigin", "demo",
] as const;

/** Ranking only. Ownership, current revisions, mandates, capacity and acceptance remain platform concerns. */
export class OfferRanker implements Pick<MatchingService, "rankOffers"> {
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options) ||
        (options.now !== undefined && typeof options.now !== "function")) {
      throw new TypeError("Invalid offer comparison clock");
    }
    this.now = options.now ?? (() => new Date());
  }

  rankOffers(request: SourcingRequest, offers: Offer[]): Offer[] {
    if (!Array.isArray(offers)) throw new TypeError("Invalid offer collection");

    let clock: Date;
    try {
      clock = this.now();
    } catch {
      throw new TypeError("Invalid offer comparison clock");
    }
    if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) {
      throw new TypeError("Invalid offer comparison clock");
    }
    const now = clock.getTime();
    const validRequest = validateRequest(request, now);

    const groups = new Map<string, { fingerprint: string; value: unknown; conflicting: boolean }>();
    for (const value of offers) {
      if (!isRecord(value) || !nonblank(value.id)) continue;
      const fingerprint = offerFingerprint(value);
      const existing = groups.get(value.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) existing.conflicting = true;
      } else {
        groups.set(value.id, { fingerprint, value, conflicting: false });
      }
    }

    const ranked: RankedOffer[] = [];
    for (const group of groups.values()) {
      if (group.conflicting) continue;
      const result = qualifyOffer(group.value, validRequest, now);
      if (result) ranked.push(result);
    }

    ranked.sort((left, right) => left.amountMinor - right.amountMinor ||
      left.deliveryAt - right.deliveryAt || compareCodepoints(left.offer.id, right.offer.id));
    return ranked.map(({ offer }) => offer);
  }
}

function validateRequest(value: unknown, now: number): ValidatedRequest {
  if (!isRecord(value) || !nonblank(value.id) || !nonblank(value.buyerId) ||
      typeof value.quantity !== "number" || !Number.isFinite(value.quantity) || value.quantity <= 0 ||
      !nonblank(value.unit) || !nonblank(value.destination) || value.demo !== true ||
      !isMoney(value.maximumDeliveredTotal)) {
    throw new TypeError("Invalid sourcing request for offer comparison");
  }

  const deliverBy = timestamp(value.deliverBy);
  if (!Number.isFinite(deliverBy) || deliverBy <= now || !Array.isArray(value.requirements)) {
    throw new TypeError("Invalid sourcing request for offer comparison");
  }

  const requirementKeys = new Set<string>();
  const mandatoryKeys = new Set<string>();
  for (const requirement of value.requirements) {
    if (!isRecord(requirement) || !nonblank(requirement.key) || typeof requirement.mandatory !== "boolean" ||
        requirementKeys.has(requirement.key)) {
      throw new TypeError("Invalid sourcing request for offer comparison");
    }
    requirementKeys.add(requirement.key);
    if (requirement.mandatory) mandatoryKeys.add(requirement.key);
  }

  return {
    id: value.id,
    buyerId: value.buyerId,
    quantity: value.quantity,
    unit: value.unit,
    destination: value.destination,
    maximumDeliveredTotal: value.maximumDeliveredTotal.amountMinor,
    currency: value.maximumDeliveredTotal.currency,
    deliverBy,
    requirementKeys,
    mandatoryKeys,
  };
}

function qualifyOffer(value: unknown, request: ValidatedRequest, now: number): RankedOffer | undefined {
  if (!isRecord(value) || !nonblank(value.id) || !nonblank(value.requestId) || !nonblank(value.buyerId) ||
      !nonblank(value.supplierId) || (value.previousOfferId !== undefined && !nonblank(value.previousOfferId)) ||
      value.requestId !== request.id || value.buyerId !== request.buyerId || value.supplierId === request.buyerId ||
      value.quantity !== request.quantity || value.unit !== request.unit || value.destination !== request.destination ||
      value.demo !== true || value.termsOrigin !== "demo-supplier-declaration" || !isMoney(value.deliveredTotal) ||
      value.deliveredTotal.currency !== request.currency || value.deliveredTotal.amountMinor > request.maximumDeliveredTotal ||
      !nonnegativeSafeInteger(value.taxMinor) || !nonnegativeSafeInteger(value.deliveryMinor)) {
    return undefined;
  }

  const components = value.taxMinor + value.deliveryMinor;
  if (!Number.isSafeInteger(components) || components > value.deliveredTotal.amountMinor) return undefined;

  const deliveryAt = timestamp(value.deliveryAt);
  const expiresAt = timestamp(value.expiresAt);
  if (!Number.isFinite(deliveryAt) || deliveryAt < now || deliveryAt > request.deliverBy ||
      !Number.isFinite(expiresAt) || expiresAt <= now || !Array.isArray(value.confirmedRequirementKeys)) {
    return undefined;
  }

  const confirmed = new Set<string>();
  for (const key of value.confirmedRequirementKeys) {
    if (typeof key !== "string" || !request.requirementKeys.has(key) || confirmed.has(key)) return undefined;
    confirmed.add(key);
  }
  for (const key of request.mandatoryKeys) if (!confirmed.has(key)) return undefined;

  return {
    offer: copyOffer(value),
    amountMinor: value.deliveredTotal.amountMinor,
    deliveryAt,
  };
}

function copyOffer(value: RecordValue): Offer {
  const copy: Offer = {
    id: value.id as string,
    requestId: value.requestId as string,
    buyerId: value.buyerId as string,
    supplierId: value.supplierId as string,
    quantity: value.quantity as number,
    unit: value.unit as string,
    destination: value.destination as string,
    deliveredTotal: {
      amountMinor: (value.deliveredTotal as RecordValue).amountMinor as number,
      currency: (value.deliveredTotal as RecordValue).currency as string,
    },
    taxMinor: value.taxMinor as number,
    deliveryMinor: value.deliveryMinor as number,
    deliveryAt: value.deliveryAt as string,
    expiresAt: value.expiresAt as string,
    confirmedRequirementKeys: [...(value.confirmedRequirementKeys as string[])],
    termsOrigin: "demo-supplier-declaration",
    demo: true,
  };
  if (value.previousOfferId !== undefined) copy.previousOfferId = value.previousOfferId as string;
  return copy;
}

function isMoney(value: unknown): value is RecordValue & { amountMinor: number; currency: string } {
  return isRecord(value) && Number.isSafeInteger(value.amountMinor) && (value.amountMinor as number) > 0 &&
    typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency);
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an ISO timestamp only when it has a valid calendar date and an explicit bounded offset. */
function timestamp(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return Number.NaN;

  const datePart = match[1]!;
  const midnight = Date.parse(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== datePart) return Number.NaN;

  if (match[2] !== "Z") {
    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    if (hours > 14 || (hours === 14 && minutes !== 0)) return Number.NaN;
  }
  return Date.parse(value);
}

function offerFingerprint(value: RecordValue): string {
  const fields = offerFields.map((field) => {
    const present = Object.prototype.hasOwnProperty.call(value, field);
    const fieldValue = value[field];
    if (field === "deliveredTotal" && isRecord(fieldValue)) {
      return [field, present, [
        Object.prototype.hasOwnProperty.call(fieldValue, "amountMinor"), stableValue(fieldValue.amountMinor),
        Object.prototype.hasOwnProperty.call(fieldValue, "currency"), stableValue(fieldValue.currency),
      ]];
    }
    return [field, present, stableValue(fieldValue)];
  });
  return JSON.stringify(fields);
}

function stableValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "number") return ["number", Number.isNaN(value) ? "NaN" : String(value)];
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value !== "object") return [typeof value];
  if (ancestors.has(value)) return ["circular"];

  ancestors.add(value);
  let result: unknown[];
  if (Array.isArray(value)) {
    result = ["array", ...value.map((entry) => stableValue(entry, ancestors))];
  } else {
    const objectValue = value as RecordValue;
    result = ["object", ...Object.keys(objectValue).sort(compareCodepoints)
      .map((key) => [key, stableValue(objectValue[key], ancestors)])];
  }
  ancestors.delete(value);
  return result;
}

function compareCodepoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}
