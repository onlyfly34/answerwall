/** What a cell shows for a slot, derived from its snapshot. */
import type { AskSnapshot, SlotSnapshot } from '@answerwall/core/protocol';

/**
 * `idle`: the slot is not part of the ask on the wall. `waiting`: running,
 * nothing received yet. `streaming`: running with text.
 */
export const SLOT_PHASES = [
  'idle',
  'queued',
  'waiting',
  'streaming',
  'done',
  'error',
  'cancelled',
  'timeout',
] as const;
export type SlotPhase = (typeof SLOT_PHASES)[number];

export function slotPhase(slot: SlotSnapshot | undefined): SlotPhase {
  if (!slot) return 'idle';
  if (slot.status !== 'running') return slot.status;
  return slot.text === '' && slot.reasoning === '' ? 'waiting' : 'streaming';
}

export function isActivePhase(phase: SlotPhase): boolean {
  return phase === 'queued' || phase === 'waiting' || phase === 'streaming';
}

/**
 * A queued slot's place among the queued slots of the same provider in this
 * ask, starting at 1. Slots of one provider start in this order; other asks
 * in flight are not visible from here.
 */
export function queuePosition(ask: AskSnapshot, slotId: string): number | undefined {
  const slot = ask.slots.find((candidate) => candidate.slotId === slotId);
  if (slot?.status !== 'queued') return undefined;
  let position = 0;
  for (const candidate of ask.slots) {
    if (candidate.status === 'queued' && candidate.providerId === slot.providerId) position += 1;
    if (candidate === slot) break;
  }
  return position;
}

/** `7 s` / `1:05` while ticking; `7.4 s` / `1:05` once final. */
export function formatDuration(ms: number, final: boolean): string {
  const safe = Math.max(0, ms);
  if (safe >= 60_000) {
    const seconds = Math.floor(safe / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return final ? `${(safe / 1000).toFixed(1)} s` : `${Math.floor(safe / 1000)} s`;
}

/** Size of a string on the wire. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
