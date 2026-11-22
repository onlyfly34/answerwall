/** The grid's geometry, derived from the layout settings and the viewport. */
import { LayoutSettingsSchema } from '@answerwall/core/protocol';
import type { LayoutSettings } from '@answerwall/core/protocol';

export type Viewport = 'phone' | 'tablet' | 'desktop';

export const TABLET_DEFAULT_COLUMNS = 2;

function bounds(schema: { minValue: number | null; maxValue: number | null }): {
  min: number;
  max: number;
} {
  return { min: schema.minValue ?? 0, max: schema.maxValue ?? Number.MAX_SAFE_INTEGER };
}

/** The ranges the protocol accepts, read from its schema. */
export const LAYOUT_BOUNDS = {
  columns: bounds(LayoutSettingsSchema.shape.columns),
  minCellWidth: bounds(LayoutSettingsSchema.shape.minCellWidth),
} as const;

export function clampLayoutValue(field: keyof typeof LAYOUT_BOUNDS, value: number): number {
  const { min, max } = LAYOUT_BOUNDS[field];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The layout in effect: the one chosen on this device (by hand or by a
 * preset), else the shared settings — which a tablet shows in two columns.
 */
export function effectiveLayout(
  chosen: LayoutSettings | null,
  settings: LayoutSettings,
  viewport: Viewport,
): LayoutSettings {
  if (chosen) return chosen;
  return viewport === 'tablet'
    ? { ...settings, mode: 'fixed', columns: TABLET_DEFAULT_COLUMNS }
    : settings;
}

export function gridTemplateColumns(layout: LayoutSettings): string {
  return layout.mode === 'fixed'
    ? `repeat(${layout.columns}, minmax(0, 1fr))`
    : `repeat(auto-fill, minmax(min(100%, ${layout.minCellWidth}px), 1fr))`;
}
