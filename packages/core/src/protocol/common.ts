import { z } from 'zod';

/** Milliseconds since the Unix epoch. Every timestamp in the protocol uses this. */
export const TimestampSchema = z.number().int().nonnegative();

/** Server-generated identifier (asks, conversations, devices) or client-generated preset id. */
export const EntityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const EmptyBodySchema = z.object({});

/** Response of operations that have nothing else to return (logout, deletes). */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;
