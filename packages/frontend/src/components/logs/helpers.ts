import type { UsageRecord } from '../../types/usage';
import { getApiBaseType, isDecisionsTargetAccess } from '../../lib/apiFormats';

/** True when `apiType` is the Decisions ingress type or a Decisions target protocol. */
export const isDecisionsApiType = (apiType?: string | null): boolean => {
  if (!apiType) return false;
  const base = getApiBaseType(apiType);
  // Logs predate the collapse; the shared helper still recognizes the
  // legacy `openrouter-decisions` / `typesafe-decisions` target names.
  return base === 'decisions' || isDecisionsTargetAccess(base);
};

export const formatReasoningEffort = (effort?: string | null): string | null => {
  if (!effort) return null;
  return effort.charAt(0).toUpperCase() + effort.slice(1);
};

/** Tiers that get a dedicated icon. Everything else is hidden. */
export type DisplayServiceTier = 'flex' | 'priority' | 'ultrafast' | 'default' | 'auto';

const DISPLAY_SERVICE_TIERS: Record<string, DisplayServiceTier> = {
  flex: 'flex',
  priority: 'priority',
  ultrafast: 'ultrafast',
  default: 'default',
  auto: 'auto',
};

export interface ServiceTierDisplay {
  /** Tier used to pick the icon: actual when reported, otherwise requested. */
  tier: DisplayServiceTier;
  /** Whether the displayed tier reflects the provider-reported actual value. */
  isActual: boolean;
  /** Accessible label; marks requested-only when no actual tier was reported. */
  label: string;
  /** Tooltip with the actual, requested, and native/provider tier values. */
  tooltip: string;
}

const formatServiceTierValue = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Builds the service tier display for a usage row.
 *
 * The tier only shows when the request explicitly asked for one
 * (`requestedServiceTier`); a provider-reported default alone is not enough.
 * The icon follows the actual tier when reported, otherwise the requested one.
 * Values outside the display mapping (scale, reserved, performance, deferred,
 * unknown, ...) are hidden rather than guessed at.
 */
export const getServiceTierDisplay = (
  log: Pick<
    UsageRecord,
    'serviceTier' | 'requestedServiceTier' | 'serviceTierRaw' | 'requestedServiceTierRaw'
  >
): ServiceTierDisplay | null => {
  const requested = log.requestedServiceTier ?? null;
  if (!requested) return null;

  const actual = log.serviceTier ?? null;
  const effective = actual ?? requested;
  const tier = DISPLAY_SERVICE_TIERS[effective.toLowerCase()];
  if (!tier) return null;

  const tooltipParts: string[] = [];
  if (actual) {
    tooltipParts.push(`Actual tier: ${formatServiceTierValue(actual)}`);
  }
  if (log.serviceTierRaw && log.serviceTierRaw !== actual) {
    tooltipParts.push(`Native value: ${log.serviceTierRaw}`);
  }
  if (requested) {
    const matchNote = actual && requested === actual ? ' (matched)' : '';
    tooltipParts.push(`Requested tier: ${formatServiceTierValue(requested)}${matchNote}`);
  }
  if (log.requestedServiceTierRaw && log.requestedServiceTierRaw !== requested) {
    tooltipParts.push(`Requested native value: ${log.requestedServiceTierRaw}`);
  }
  if (!actual) {
    tooltipParts.push('Actual tier not reported');
  }

  return {
    tier,
    isActual: Boolean(actual),
    label: actual
      ? `Service tier: ${formatServiceTierValue(actual)}`
      : `Requested service tier: ${formatServiceTierValue(requested)}`,
    tooltip: tooltipParts.join(' • '),
  };
};

export const hasUpstreamRewrite = (
  log: Pick<UsageRecord, 'finalAttemptModel' | 'selectedModelName' | 'upstreamModel'>
): boolean => {
  const routeModel = log.finalAttemptModel ?? log.selectedModelName;
  return Boolean(log.upstreamModel) && log.upstreamModel !== routeModel;
};

export const getAttemptIndicatorLabel = (attemptCount?: number | null): string | null => {
  if (attemptCount && attemptCount > 1) return `${attemptCount}x`;
  return null;
};

export const formatDateSafely = (dateStr: string | undefined | null) => {
  if (!dateStr) return { time: '-', date: '-' };
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return { time: 'Invalid', date: 'Date' };
    return {
      time: d.toLocaleTimeString(),
      date: d.toISOString().split('T')[0],
    };
  } catch {
    return { time: 'Error', date: 'Date' };
  }
};
