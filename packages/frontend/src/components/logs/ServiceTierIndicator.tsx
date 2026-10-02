import { CircleDot, Gauge, Rabbit, Rocket, Turtle, type LucideIcon } from 'lucide-react';
import type { DisplayServiceTier, ServiceTierDisplay } from './helpers';

const TIER_ICONS: Record<DisplayServiceTier, LucideIcon> = {
  flex: Turtle,
  priority: Rabbit,
  ultrafast: Rocket,
  default: CircleDot,
  auto: CircleDot,
};

/**
 * Icon-only service tier marker shared by the desktop and mobile log rows.
 * Uses the `title`/`aria-label` from the helper so the actual/requested/native
 * details stay available without rendering text.
 */
export const ServiceTierIndicator = ({
  display,
  size = 12,
}: {
  display: ServiceTierDisplay;
  size?: number;
}) => {
  const TierIcon = TIER_ICONS[display.tier];
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      role="img"
      aria-label={display.label}
      title={display.tooltip}
    >
      <Gauge size={size} className="shrink-0 text-text-muted" aria-hidden="true" />
      <TierIcon size={size} className="shrink-0 text-cyan-400" aria-hidden="true" />
    </span>
  );
};
