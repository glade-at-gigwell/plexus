/**
 * Service-tier capture for usage logging.
 *
 * Two independent values are tracked per request:
 *   - requested: derived from the FINAL provider-bound request (body/headers),
 *     after adapters, extraBody merges, and OAuth transformations.
 *   - actual: derived ONLY from what the provider actually reported in its
 *     native response. It is never inferred from the request; absent means null.
 *
 * Provider wire forms handled (verified against provider docs):
 *   - OpenAI/OpenRouter/Gemini/Anthropic `service_tier` body field
 *   - Anthropic fast mode `speed: "fast"` request / `usage.speed` response
 *   - Anthropic priority tier `usage.service_tier` response
 *   - Bedrock Converse `serviceTier.type` (request, response, stream `metadata`)
 *   - Vertex PayGo `X-Vertex-AI-LLM-Shared-Request-Type` request header
 *   - Vertex GenerateContent `usageMetadata.trafficType` response
 *   - Gemini `x-gemini-service-tier` response header
 *
 * Note: Anthropic's `speed` is only read for Messages targets, so the numeric
 * TTS `speed` field (unrelated) can never be mistaken for a service tier.
 */

import { getApiBaseType } from '../../utils/api-format';

const HEADER_VERTEX_REQUEST_TYPE = 'x-vertex-ai-llm-shared-request-type';
const HEADER_GEMINI_SERVICE_TIER = 'x-gemini-service-tier';

/**
 * Responses API statuses that represent a final, provider-reported outcome.
 * `response.created` / `response.in_progress` echo the REQUESTED tier, so any
 * other status (including a cancelled stream's stale `in_progress` snapshot)
 * must not be read as an actual tier.
 */
const RESPONSES_TERMINAL_STATUSES = new Set(['completed', 'failed', 'incomplete']);

/** Values that all mean the ordinary/default service tier. */
const DEFAULT_ALIASES = new Set(['on_demand', 'ondemand', 'standard', 'standard_only', 'default']);
/** Values that all mean the prioritized tier (OpenAI `fast` is an alias, Anthropic fast mode). */
const PRIORITY_ALIASES = new Set(['fast', 'priority', 'on_demand_priority']);
const FLEX_ALIASES = new Set(['flex', 'on_demand_flex']);
/** Recognized tiers kept distinct from the canonical set above. */
const DISTINCT_TIERS = new Set([
  'auto',
  'performance',
  'ultrafast',
  'scale',
  'reserved',
  'deferred',
]);

/**
 * Canonical service tier for a raw provider value. Unknown values are
 * preserved verbatim (never coerced to a known tier).
 */
export function normalizeServiceTier(raw: unknown): string | null {
  if (raw == null) return null;
  const value = typeof raw === 'string' ? raw : String(raw);
  if (!value.trim()) return null;
  const lower = value.trim().toLowerCase();
  if (DEFAULT_ALIASES.has(lower)) return 'default';
  if (PRIORITY_ALIASES.has(lower)) return 'priority';
  if (FLEX_ALIASES.has(lower)) return 'flex';
  if (DISTINCT_TIERS.has(lower)) return lower;
  return value.trim();
}

export type ServiceTierCapture = {
  /** Normalized tier, or null when no tier was present. */
  tier: string | null;
  /** Provider's exact spelling, or null when no tier was present. */
  raw: string | null;
};

function readString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value;
}

function readHeader(headers: Record<string, unknown> | undefined, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof value === 'string') return value.trim() ? value : null;
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === 'string' && entry.trim());
      return typeof first === 'string' ? first : null;
    }
    return null;
  }
  return null;
}

function capture(raw: string | null): ServiceTierCapture {
  return { tier: normalizeServiceTier(raw), raw };
}

function findRequestedRaw(
  payload: any,
  headers: Record<string, unknown> | undefined,
  apiBaseType: string | undefined
): string | null {
  const body = payload && typeof payload === 'object' ? payload : {};

  // Anthropic fast mode is a `speed: "fast"` Messages field, not a tier name.
  // Only the `fast` value selects priority; any other value (e.g. a future
  // `standard` spelling) must not mask an explicit `service_tier`.
  if (apiBaseType === 'messages') {
    const speed = readString((body as any).speed);
    if (speed && speed.trim().toLowerCase() === 'fast') return speed;
  }

  // Bedrock Converse (and ConverseStream) request shape.
  const nested = (body as any).serviceTier;
  if (typeof nested === 'string') return readString(nested);
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const type = readString((nested as any).type);
    if (type) return type;
  }

  // Vertex PayGo selects the tier with a request header, and its generateContent
  // implementation IGNORES a `service_tier` body field entirely — so the header
  // is authoritative whenever both are present.
  const vertexHeader = readHeader(headers, HEADER_VERTEX_REQUEST_TYPE);
  if (vertexHeader) return vertexHeader;

  // OpenAI / OpenRouter / Gemini / Anthropic `service_tier`.
  const serviceTier = readString((body as any).service_tier);
  if (serviceTier) return serviceTier;

  return null;
}

/** Extracts the requested tier from the FINAL provider-bound request. */
export function extractRequestedServiceTier(
  payload: any,
  headers: Record<string, unknown> | undefined,
  apiBaseType?: string
): ServiceTierCapture {
  return capture(
    findRequestedRaw(payload, headers, apiBaseType ? getApiBaseType(apiBaseType) : undefined)
  );
}

function unwrapEventEnvelope(body: any): any {
  if (!body || typeof body !== 'object') return body;
  // Anthropic Messages stream event: `{ type: 'message_start', message: {...} }`.
  if (
    (body.type === 'message_start' || body.type === 'message_delta') &&
    body.message &&
    typeof body.message === 'object'
  ) {
    return unwrapEventEnvelope(body.message);
  }
  // OpenAI Responses stream event: `{ type: 'response.completed', response: {...} }`.
  if (
    typeof body.type === 'string' &&
    body.type.startsWith('response.') &&
    body.response &&
    typeof body.response === 'object'
  ) {
    return unwrapEventEnvelope(body.response);
  }
  return body;
}

function findActualRaw(rawBody: any, apiBaseType?: string): string | null {
  const body = unwrapEventEnvelope(rawBody);
  if (!body || typeof body !== 'object') return null;

  // OpenAI Responses: only a terminal response reflects the tier the provider
  // actually served. `response.created` / `response.in_progress` repeat the
  // requested tier, so a stream that dies before completion must yield null.
  if (apiBaseType === 'responses') {
    const status = readString(body.status);
    if (status && !RESPONSES_TERMINAL_STATUSES.has(status.toLowerCase())) return null;
  }

  const usage = body.usage && typeof body.usage === 'object' ? body.usage : null;

  // Anthropic fast mode (`usage.speed: "fast"`) is reported alongside a
  // separate commitment tier (`usage.service_tier`). Fast mode normalizes to
  // priority, so it MUST win over a `standard` service_tier in the same body.
  const usageSpeed = readString(usage?.speed);
  if (usageSpeed?.trim().toLowerCase() === 'fast') return usageSpeed;
  const usageServiceTier = readString(usage?.service_tier);
  if (usageServiceTier) return usageServiceTier;
  if (usageSpeed) return usageSpeed;

  // Vertex GenerateContent reports the served tier here.
  const trafficType = readString(body.usageMetadata?.trafficType);
  if (trafficType) return trafficType;

  // Bedrock Converse response (top-level), ConverseStream (`metadata` event),
  // and any provider that nests it under `usage`.
  for (const candidate of [body.serviceTier, body.metadata?.serviceTier, usage?.serviceTier]) {
    if (typeof candidate === 'string') return readString(candidate);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const type = readString((candidate as any).type);
      if (type) return type;
    }
  }

  // OpenAI / Gemini response body / Gemini Interactions output.
  const serviceTier = readString(body.service_tier);
  if (serviceTier) return serviceTier;

  return null;
}

/** Extracts the actual tier from a provider's native response body. */
export function extractActualServiceTierFromBody(
  body: any,
  apiBaseType?: string
): ServiceTierCapture {
  return capture(findActualRaw(body, apiBaseType ? getApiBaseType(apiBaseType) : undefined));
}

/** Extracts a header-reported actual tier (Gemini `x-gemini-service-tier`). */
export function extractActualServiceTierFromHeaders(
  headers: Record<string, unknown> | undefined
): ServiceTierCapture {
  return capture(readHeader(headers, HEADER_GEMINI_SERVICE_TIER));
}

/**
 * Copies a requested tier that a failed dispatch attached to the error's
 * routing context (see request-manager) onto a usage record. No-op when the
 * failure carried no requested tier.
 */
export function applyRequestedServiceTierFromError(
  usageRecord: {
    requestedServiceTier?: string | null;
    requestedServiceTierRaw?: string | null;
  },
  error: any
): void {
  const routingContext = error?.routingContext;
  if (!routingContext?.requestedServiceTierRaw) return;
  usageRecord.requestedServiceTier = routingContext.requestedServiceTier ?? null;
  usageRecord.requestedServiceTierRaw = routingContext.requestedServiceTierRaw;
}

/** Extracts the actual tier from a native response. Body/stream content is
 * authoritative for most providers; for Gemini the documented header
 * (`x-gemini-service-tier`) wins over a competing body field, since the
 * generateContent output `service_tier` is not a documented served-tier signal.
 */
export function extractActualServiceTier(
  body: any,
  headers?: Record<string, unknown>,
  apiBaseType?: string
): ServiceTierCapture {
  const base = apiBaseType ? getApiBaseType(apiBaseType) : undefined;
  const fromHeaders = extractActualServiceTierFromHeaders(headers);
  if (base === 'gemini' && fromHeaders.raw) return fromHeaders;
  const fromBody = findActualRaw(body, base);
  if (fromBody) return capture(fromBody);
  return fromHeaders;
}
