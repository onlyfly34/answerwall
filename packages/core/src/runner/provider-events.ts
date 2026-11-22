import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { ProviderErrorCodeSchema, StreamingModeSchema, UsageSchema } from '../protocol/index.ts';

/**
 * What the runner accepts from an adapter. Anything that does not match is
 * ignored; a recognisable event with an unusable optional or descriptive
 * field keeps its meaning and loses only that field.
 */
const ProviderEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    streaming: StreamingModeSchema.optional().catch(undefined),
  }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('notice'), message: z.string() }),
  z.object({
    type: z.literal('done'),
    usage: UsageSchema.optional().catch(undefined),
    elapsedMs: z.number().nonnegative().optional().catch(undefined),
  }),
  z.object({
    type: z.literal('error'),
    code: ProviderErrorCodeSchema.catch('unknown'),
    message: z.string().catch('The provider reported an error'),
  }),
]);

/** A `ProviderEvent` as received: its `done` may lack a usable `elapsedMs`. */
export type CheckedProviderEvent = z.infer<typeof ProviderEventSchema>;

/** `null` for anything that is not a provider event. */
export function checkProviderEvent(value: unknown): CheckedProviderEvent | null {
  const result = ProviderEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * The longest prefix of `text` that takes at most `maxBytes` bytes in UTF-8
 * and does not end inside a surrogate pair.
 */
export function utf8Prefix(text: string, maxBytes: number): string {
  // A UTF-16 code unit never needs more than three bytes.
  if (text.length * 3 <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}
