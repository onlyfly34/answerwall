import type { LoggedEvent } from './events.ts';

export interface EventLogLimits {
  /** Most events retained. */
  maxEvents: number;
  /** Most text retained, in UTF-16 code units, counting a fixed overhead per event. */
  maxChars: number;
}

/** What an event without text counts for against `maxChars`. */
const EVENT_OVERHEAD_CHARS = 64;

function weigh(event: LoggedEvent): number {
  switch (event.type) {
    case 'delta':
    case 'reasoning':
      return EVENT_OVERHEAD_CHARS + event.text.length;
    case 'notice':
    case 'error':
      return EVENT_OVERHEAD_CHARS + event.message.length;
    default:
      return EVENT_OVERHEAD_CHARS;
  }
}

/**
 * The retained tail of an ask's append-only event sequence. `seq` starts at 1
 * and grows by one per event; the oldest events are dropped once either limit
 * is exceeded, so memory stays bounded however long an ask streams.
 */
export class EventLog {
  private readonly limits: EventLogLimits;
  private events: LoggedEvent[] = [];
  /** Index in `events` of the oldest retained event. */
  private head = 0;
  private chars = 0;
  private last = 0;

  constructor(limits: EventLogLimits) {
    this.limits = limits;
  }

  /** `seq` of the newest event ever appended; 0 before the first. */
  get lastSeq(): number {
    return this.last;
  }

  /** `seq` of the oldest retained event; `lastSeq + 1` when nothing is retained. */
  get firstSeq(): number {
    return this.last - this.size + 1;
  }

  get size(): number {
    return this.events.length - this.head;
  }

  get retainedChars(): number {
    return this.chars;
  }

  append(event: LoggedEvent): void {
    if (event.seq !== this.last + 1) {
      throw new Error(`event log expected seq ${this.last + 1}, got ${event.seq}`);
    }
    this.last = event.seq;
    this.events.push(event);
    this.chars += weigh(event);
    while (
      this.size > 0 &&
      (this.size > this.limits.maxEvents || this.chars > this.limits.maxChars)
    ) {
      this.chars -= weigh(this.events[this.head++]!);
    }
    if (this.head > 0 && this.head >= this.events.length / 2) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
  }

  /** The event with this `seq`, when it is still retained. */
  get(seq: number): LoggedEvent | undefined {
    return seq < this.firstSeq ? undefined : this.events[this.head + seq - this.firstSeq];
  }
}
