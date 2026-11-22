import type { AskSnapshot, SlotStreamEvent, StreamEvent } from '../protocol/index.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Everything that is appended to an ask's log; a `snapshot` is only ever synthesised for one subscriber. */
export type LoggedEvent = Exclude<StreamEvent, { type: 'snapshot' }>;

/** A log event before the ask assigns its `seq`. */
export type UnsequencedEvent = DistributiveOmit<LoggedEvent, 'seq'>;

/** A slot event as the slot's run produces it; the ask adds `seq`, `slotId` and `providerId`. */
export type SlotEventBody = DistributiveOmit<SlotStreamEvent, 'seq' | 'slotId' | 'providerId'>;

/**
 * An independent copy of a snapshot. Strings are immutable and shared, so the
 * cost does not depend on the amount of accumulated text.
 */
export function cloneSnapshot(snapshot: AskSnapshot): AskSnapshot {
  return {
    ...snapshot,
    slots: snapshot.slots.map((slot) => ({
      ...slot,
      notices: slot.notices.map((notice) => ({ ...notice })),
      ...(slot.error ? { error: { ...slot.error } } : {}),
      ...(slot.usage ? { usage: { ...slot.usage } } : {}),
    })),
  };
}
