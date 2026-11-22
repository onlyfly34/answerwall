import type {
  Clock,
  IdGenerator,
  LogFields,
  LogLevel,
  Logger,
  RandomSource,
} from '../contracts/index.ts';

interface Timer {
  at: number;
  order: number;
  callback: () => void;
}

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private scheduled = 0;

  constructor(start = Date.UTC(2026, 0, 1)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const timer: Timer = { at: this.current + delayMs, order: this.scheduled++, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((candidate) => candidate !== timer);
    };
  }

  /**
   * Moves time forward, running due timers in order. Pending promise
   * callbacks get a chance to run after each timer, so timers they schedule
   * inside the window fire too.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await flushPromises();
      const next = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.current = next.at;
      next.callback();
    }
    this.current = target;
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

/** Lets every already-queued promise callback run. */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** `id-1`, `id-2`, … */
export function createSequentialIds(prefix = 'id'): IdGenerator {
  let count = 0;
  return { next: () => `${prefix}-${++count}` };
}

/** Deterministic bytes: 1, 2, 3, … wrapping at 256. */
export function createCountingRandom(): RandomSource {
  let count = 0;
  return { bytes: (length) => Uint8Array.from({ length }, () => ++count % 256) };
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  fields: LogFields;
}

/** A logger that records entries, for asserting on what is (and is not) logged. */
export function createMemoryLogger(): Logger & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const make = (bound: LogFields): Logger => {
    const log = (level: LogLevel) => (message: string, fields?: LogFields) => {
      entries.push({ level, message, fields: { ...bound, ...fields } });
    };
    return {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  return Object.assign(make({}), { entries });
}
