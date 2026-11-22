/** Pure operations on the wall's slot list. A slot is one cell: an ask target. */
import type { AskTarget, SlotSnapshot } from '@answerwall/core/protocol';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;

/** A random id with this prefix that is not in `taken`; valid as a slot id and as a preset id. */
export function newId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    const id = `${prefix}-${Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`;
    if (!used.has(id)) return id;
  }
}

export const newSlotId = (taken: Iterable<string>): string => newId('s', taken);

/** Builds a target without `undefined` members, which the protocol types do not allow. */
export function makeTarget(
  slotId: string,
  providerId: string,
  model?: string,
  effort?: string,
): AskTarget {
  return {
    slotId,
    providerId,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

/** A plain copy of a target, or the target a snapshot's slot was asked with. */
export function copyTarget(slot: AskTarget | SlotSnapshot): AskTarget {
  return makeTarget(slot.slotId, slot.providerId, slot.model, slot.effort);
}

/** The list with the item at `from` moved to `to`; out-of-range positions are clamped. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const result = [...list];
  if (from < 0 || from >= result.length) return result;
  const [item] = result.splice(from, 1);
  result.splice(Math.max(0, Math.min(to, result.length)), 0, item as T);
  return result;
}

export function sameTargets(a: readonly AskTarget[], b: readonly AskTarget[]): boolean {
  return (
    a.length === b.length &&
    a.every((slot, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        slot.slotId === other.slotId &&
        slot.providerId === other.providerId &&
        slot.model === other.model &&
        slot.effort === other.effort
      );
    })
  );
}
