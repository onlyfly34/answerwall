import { z } from 'zod';
import { TimestampSchema } from './common.ts';
import { ProviderErrorCodeSchema } from './errors.ts';
import { AskSnapshotSchema, NoticeCodeSchema, SlotIdSchema } from './ask.ts';
import { ProviderIdSchema, StreamingModeSchema, UsageSchema } from './providers.ts';

/**
 * Wire format: one SSE message per event with `id: <seq>`, `event: <type>` and
 * the JSON-encoded event as `data`. `seq` starts at 1 and increases by one per
 * event within an ask. A `: ping` comment is sent every
 * {@link SSE_PING_INTERVAL_MS}.
 */
export const SSE_PING_INTERVAL_MS = 15_000;

/** Request header and query parameter a client uses to resume after a known `seq`. */
export const SSE_RESUME_HEADER = 'Last-Event-ID';
export const SSE_RESUME_QUERY = 'after';

const seq = z.number().int().nonnegative();
const slotEvent = { seq, slotId: SlotIdSchema, providerId: ProviderIdSchema };
const elapsedMs = z.number().int().nonnegative();

/**
 * Sent first when the requested resume point is no longer available. It
 * replaces everything the client has; its `seq` equals `snapshot.seq`.
 */
export const SnapshotEventSchema = z.object({
  type: z.literal('snapshot'),
  seq,
  snapshot: AskSnapshotSchema,
});
export const QueuedEventSchema = z.object({ type: z.literal('queued'), ...slotEvent });
export const StartEventSchema = z.object({
  type: z.literal('start'),
  ...slotEvent,
  at: TimestampSchema,
  streaming: StreamingModeSchema,
});
export const DeltaEventSchema = z.object({
  type: z.literal('delta'),
  ...slotEvent,
  text: z.string(),
});
export const ReasoningEventSchema = z.object({
  type: z.literal('reasoning'),
  ...slotEvent,
  text: z.string(),
});
export const NoticeEventSchema = z.object({
  type: z.literal('notice'),
  ...slotEvent,
  code: NoticeCodeSchema,
  message: z.string(),
});
export const DoneEventSchema = z.object({
  type: z.literal('done'),
  ...slotEvent,
  usage: UsageSchema.optional(),
  elapsedMs,
});
export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  ...slotEvent,
  code: ProviderErrorCodeSchema,
  message: z.string(),
  elapsedMs,
});
export const CancelledEventSchema = z.object({
  type: z.literal('cancelled'),
  ...slotEvent,
  elapsedMs,
});
export const TimeoutEventSchema = z.object({
  type: z.literal('timeout'),
  ...slotEvent,
  elapsedMs,
});
/** Always the last event of an ask; the server closes the stream after it. */
export const AskDoneEventSchema = z.object({ type: z.literal('ask_done'), seq });

export const StreamEventSchema = z.discriminatedUnion('type', [
  SnapshotEventSchema,
  QueuedEventSchema,
  StartEventSchema,
  DeltaEventSchema,
  ReasoningEventSchema,
  NoticeEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
  CancelledEventSchema,
  TimeoutEventSchema,
  AskDoneEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type StreamEventType = StreamEvent['type'];
export type SlotStreamEvent = Exclude<StreamEvent, { type: 'snapshot' | 'ask_done' }>;

export const StreamQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
});
