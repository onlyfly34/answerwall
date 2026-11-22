import { applyStreamEvent, isTerminalStreamEvent } from '../protocol/index.ts';
import type { AskSnapshot, StreamEvent } from '../protocol/index.ts';
import { EventLog } from './event-log.ts';
import type { EventLogLimits } from './event-log.ts';
import { cloneSnapshot } from './events.ts';
import type { LoggedEvent, UnsequencedEvent } from './events.ts';

/**
 * One ask in memory: its snapshot, the retained tail of its event log, and
 * the subscribers waiting for the next event.
 *
 * Subscribers pull. Each one is only a position in the shared log, so a slow
 * reader costs no memory and holds nothing up; one that falls behind the
 * retained tail is brought up to date with a snapshot.
 */
export class LiveAsk {
  private current: AskSnapshot;
  private readonly log: EventLog;
  private readonly wakers = new Set<() => void>();
  private closed = false;

  constructor(initial: AskSnapshot, limits: EventLogLimits) {
    this.current = initial;
    this.log = new EventLog(limits);
  }

  get askId(): string {
    return this.current.askId;
  }

  get done(): boolean {
    return this.current.status === 'done';
  }

  get seq(): number {
    return this.log.lastSeq;
  }

  /** Number of events currently retained for replay. */
  get retainedEvents(): number {
    return this.log.size;
  }

  /** A copy of the current state that later events do not change. */
  snapshot(): AskSnapshot {
    return cloneSnapshot(this.current);
  }

  /**
   * Assigns the next `seq`, folds the event into the snapshot with the shared
   * reducer and wakes the subscribers.
   */
  append(event: UnsequencedEvent): LoggedEvent {
    const sequenced: LoggedEvent = { ...event, seq: this.log.lastSeq + 1 };
    this.log.append(sequenced);
    this.current = applyStreamEvent(this.current, sequenced);
    this.wake();
    return sequenced;
  }

  /** Ends every subscription without a terminal event; the ask is no longer served. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  /** Events after `after`, then live ones, per the `AskManager.subscribe` contract. */
  async *subscribe(after: number, signal: AbortSignal): AsyncGenerator<StreamEvent, void, void> {
    let cursor = after;
    while (!signal.aborted && !this.closed) {
      const last = this.log.lastSeq;
      if (cursor === last && !this.done) {
        await this.nextChange(signal);
        continue;
      }
      // Still retained: the next event. Otherwise the point is gone, lies
      // beyond the log, or the finished ask has nothing left to replay.
      const event: StreamEvent = (cursor < last ? this.log.get(cursor + 1) : undefined) ?? {
        type: 'snapshot',
        seq: last,
        snapshot: this.snapshot(),
      };
      cursor = event.seq;
      yield event;
      if (isTerminalStreamEvent(event)) return;
    }
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  private nextChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const waker = (): void => {
        this.wakers.delete(waker);
        signal.removeEventListener('abort', waker);
        resolve();
      };
      this.wakers.add(waker);
      signal.addEventListener('abort', waker, { once: true });
    });
  }
}
