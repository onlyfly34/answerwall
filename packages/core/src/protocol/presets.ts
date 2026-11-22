import { z } from 'zod';
import { EntityIdSchema, TimestampSchema } from './common.ts';
import { AskTargetSchema } from './ask.ts';
import { LayoutSettingsSchema } from './layout.ts';
import { LIMIT_SPECS } from './limits.ts';

export const MAX_PRESETS = 100;

/** Body of `PUT /api/presets/:id`; the client chooses the id. Slot order is the wall order. */
export const PresetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slots: z
    .array(AskTargetSchema)
    .min(1)
    .max(LIMIT_SPECS.maxTargetsPerAsk.max)
    .refine((slots) => new Set(slots.map((s) => s.slotId)).size === slots.length, {
      message: 'slotId must be unique within a preset',
    }),
  /** Overrides the layout settings while this preset is active. */
  layout: LayoutSettingsSchema.optional(),
});
export type PresetInput = z.infer<typeof PresetInputSchema>;

export const PresetSchema = PresetInputSchema.extend({
  id: EntityIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Preset = z.infer<typeof PresetSchema>;

export const PresetsResponseSchema = z.object({ presets: z.array(PresetSchema) });
export type PresetsResponse = z.infer<typeof PresetsResponseSchema>;
