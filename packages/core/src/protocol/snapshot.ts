import type { AskSnapshot, AskTarget, SlotSnapshot } from './ask.ts';
import type { ProviderKind } from './providers.ts';
import type { StreamEvent } from './stream.ts';

export interface InitialSnapshotInput {
  askId: string;
  conversationId: string;
  prompt: string;
  createdAt: number;
  targets: readonly (AskTarget & { kind: ProviderKind })[];
}

/** The snapshot of an ask before its first event (`seq` 0, every slot queued). */
export function initialAskSnapshot(input: InitialSnapshotInput): AskSnapshot {
  return {
    askId: input.askId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    createdAt: input.createdAt,
    status: 'running',
    seq: 0,
    slots: input.targets.map((target) => ({
      ...target,
      status: 'queued',
      text: '',
      reasoning: '',
      notices: [],
      truncated: false,
    })),
  };
}

/**
 * The one definition of what each stream event does to a snapshot, shared by
 * the server (snapshots, persistence) and the client (stream store).
 *
 * Mutates `snapshot` in place and returns it, except for a `snapshot` event,
 * whose payload is returned as the replacement. Events at or below
 * `snapshot.seq` are ignored, so replaying an overlapping range is harmless.
 */
export function applyStreamEvent(snapshot: AskSnapshot, event: StreamEvent): AskSnapshot {
  if (event.type === 'snapshot') return event.snapshot;
  if (event.seq <= snapshot.seq) return snapshot;
  snapshot.seq = event.seq;
  if (event.type === 'ask_done') {
    snapshot.status = 'done';
    return snapshot;
  }
  const slot = snapshot.slots.find((candidate) => candidate.slotId === event.slotId);
  if (slot) applySlotEvent(slot, event);
  return snapshot;
}

function applySlotEvent(
  slot: SlotSnapshot,
  event: Exclude<StreamEvent, { type: 'snapshot' | 'ask_done' }>,
): void {
  switch (event.type) {
    case 'queued':
      slot.status = 'queued';
      break;
    case 'start':
      slot.status = 'running';
      slot.streaming = event.streaming;
      slot.startedAt = event.at;
      break;
    case 'delta':
      slot.text += event.text;
      break;
    case 'reasoning':
      slot.reasoning += event.text;
      break;
    case 'notice':
      slot.notices.push({ code: event.code, message: event.message });
      if (event.code === 'output_truncated') slot.truncated = true;
      break;
    case 'done':
      slot.status = 'done';
      slot.elapsedMs = event.elapsedMs;
      if (event.usage) slot.usage = event.usage;
      break;
    case 'error':
      slot.status = 'error';
      slot.elapsedMs = event.elapsedMs;
      slot.error = { code: event.code, message: event.message };
      break;
    case 'cancelled':
    case 'timeout':
      slot.status = event.type;
      slot.elapsedMs = event.elapsedMs;
      break;
  }
}
