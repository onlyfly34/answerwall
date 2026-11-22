import { z } from 'zod';
import { EntityIdSchema, TimestampSchema } from './common.ts';
import { ProviderErrorCodeSchema } from './errors.ts';
import { LIMIT_SPECS } from './limits.ts';
import {
  EffortSchema,
  ModelIdSchema,
  ProviderIdSchema,
  ProviderKindSchema,
  StreamingModeSchema,
  UsageSchema,
} from './providers.ts';

/** Client-chosen identifier of one cell; unique within an ask. */
export const SlotIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export type SlotId = z.infer<typeof SlotIdSchema>;

export const AskTargetSchema = z.object({
  slotId: SlotIdSchema,
  providerId: ProviderIdSchema,
  model: ModelIdSchema.optional(),
  effort: EffortSchema.optional(),
});
export type AskTarget = z.infer<typeof AskTargetSchema>;

/**
 * The schema enforces the hard maxima only; the configured limits (targets,
 * prompt bytes, asks in flight, queue length) are enforced by the runner.
 */
export const AskRequestSchema = z.object({
  prompt: z.string().min(1),
  targets: z
    .array(AskTargetSchema)
    .min(1)
    .max(LIMIT_SPECS.maxTargetsPerAsk.max)
    .refine((targets) => new Set(targets.map((t) => t.slotId)).size === targets.length, {
      message: 'slotId must be unique within an ask',
    }),
  /** Reserved for multi-turn conversations; when omitted a new conversation is created. */
  conversationId: EntityIdSchema.optional(),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskResponseSchema = z.object({ askId: EntityIdSchema });
export type AskResponse = z.infer<typeof AskResponseSchema>;

/** `queued -> running -> done | error | cancelled | timeout` */
export const SLOT_STATUSES = [
  'queued',
  'running',
  'done',
  'error',
  'cancelled',
  'timeout',
] as const;
export const SlotStatusSchema = z.enum(SLOT_STATUSES);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

export function isTerminalSlotStatus(status: SlotStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

/** `provider`: reported by the provider. `output_truncated`: the per-slot output limit was hit. */
export const NoticeCodeSchema = z.enum(['provider', 'output_truncated']);
export type NoticeCode = z.infer<typeof NoticeCodeSchema>;

export const SlotNoticeSchema = z.object({
  code: NoticeCodeSchema,
  message: z.string(),
});
export type SlotNotice = z.infer<typeof SlotNoticeSchema>;

export const SlotErrorSchema = z.object({
  code: ProviderErrorCodeSchema,
  message: z.string(),
});
export type SlotError = z.infer<typeof SlotErrorSchema>;

/** What a slot that was queued or running when the server stopped ends with. */
export const SERVER_RESTARTED_ERROR: SlotError = { code: 'unknown', message: 'server restarted' };

export const SlotSnapshotSchema = z.object({
  slotId: SlotIdSchema,
  providerId: ProviderIdSchema,
  kind: ProviderKindSchema,
  model: ModelIdSchema.optional(),
  effort: EffortSchema.optional(),
  status: SlotStatusSchema,
  /** Known once the slot has started. */
  streaming: StreamingModeSchema.optional(),
  text: z.string(),
  reasoning: z.string(),
  notices: z.array(SlotNoticeSchema),
  /** Output beyond the per-slot limit was dropped. */
  truncated: z.boolean(),
  /** Present exactly when `status` is `error`. */
  error: SlotErrorSchema.optional(),
  usage: UsageSchema.optional(),
  startedAt: TimestampSchema.optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type SlotSnapshot = z.infer<typeof SlotSnapshotSchema>;

/** `done` once every slot is terminal. */
export const AskStatusSchema = z.enum(['running', 'done']);
export type AskStatus = z.infer<typeof AskStatusSchema>;

/**
 * Status and accumulated text of every slot. Also the shape of a history
 * entry: a stored ask is a snapshot whose status is `done`.
 */
export const AskSnapshotSchema = z.object({
  askId: EntityIdSchema,
  conversationId: EntityIdSchema,
  prompt: z.string(),
  createdAt: TimestampSchema,
  status: AskStatusSchema,
  /** Sequence number of the last stream event this snapshot includes. */
  seq: z.number().int().nonnegative(),
  /** In the order of the request's targets. */
  slots: z.array(SlotSnapshotSchema),
});
export type AskSnapshot = z.infer<typeof AskSnapshotSchema>;

/** Without `slotId` every unfinished slot of the ask is cancelled. */
export const CancelRequestSchema = z.object({
  slotId: SlotIdSchema.optional(),
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const CancelResponseSchema = z.object({
  /** Slots that were still queued or running and are now being cancelled. */
  cancelled: z.array(SlotIdSchema),
});
export type CancelResponse = z.infer<typeof CancelResponseSchema>;
