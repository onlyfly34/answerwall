import { z } from 'zod';
import { EntityIdSchema, TimestampSchema } from './common.ts';
import { SlotIdSchema, SlotStatusSchema } from './ask.ts';
import { ModelIdSchema, ProviderIdSchema, ProviderKindSchema } from './providers.ts';

export const HISTORY_PREVIEW_CHARS = 200;
export const HISTORY_PAGE_SIZE = { default: 30, max: 100 } as const;

/** `?q=` with an empty value means "no filter", not "match the empty string". */
const optionalText = (max: number) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.string().max(max).optional());

export const HistoryQuerySchema = z.object({
  /** Case-insensitive substring of the prompt or of an answer. */
  q: optionalText(200),
  /** Opaque; pass `nextCursor` from the previous page. */
  cursor: optionalText(200),
  limit: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(1).max(HISTORY_PAGE_SIZE.max).default(HISTORY_PAGE_SIZE.default),
  ),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/** A list row: no answer bodies. The full entry is an `AskSnapshot`. */
export const HistoryItemSchema = z.object({
  askId: EntityIdSchema,
  conversationId: EntityIdSchema,
  /** At most {@link HISTORY_PREVIEW_CHARS} characters of the prompt. */
  promptPreview: z.string(),
  createdAt: TimestampSchema,
  slots: z.array(
    z.object({
      slotId: SlotIdSchema,
      providerId: ProviderIdSchema,
      kind: ProviderKindSchema,
      model: ModelIdSchema.optional(),
      status: SlotStatusSchema,
    }),
  ),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

/** Newest first. */
export const HistoryPageSchema = z.object({
  items: z.array(HistoryItemSchema),
  nextCursor: z.string().nullable(),
});
export type HistoryPage = z.infer<typeof HistoryPageSchema>;
