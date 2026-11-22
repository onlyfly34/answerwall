import { z } from 'zod';

/** `auto`: as many columns as fit `minCellWidth`. `fixed`: exactly `columns`. */
export const LayoutSettingsSchema = z.object({
  mode: z.enum(['auto', 'fixed']),
  /** CSS pixels. */
  minCellWidth: z.number().int().min(240).max(1200),
  columns: z.number().int().min(1).max(12),
});
export type LayoutSettings = z.infer<typeof LayoutSettingsSchema>;

export const LayoutPatchSchema = LayoutSettingsSchema.partial();

export const DEFAULT_LAYOUT: LayoutSettings = { mode: 'auto', minCellWidth: 360, columns: 3 };
