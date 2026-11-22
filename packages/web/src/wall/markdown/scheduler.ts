/**
 * Decides when a cell re-renders its answer: at once when idle, then at most
 * once per interval while text keeps arriving. The interval grows with the
 * measured cost of the last render, so a slow render (a very long answer, a
 * slow device) takes a bounded share of the main thread instead of all of it.
 */
export const RENDER_INTERVAL_MS = 80;
export const RENDER_INTERVAL_MAX_MS = 1000;
/** A render may use at most 1/COST_FACTOR of the time between renders. */
const COST_FACTOR = 4;

export interface RenderSchedulerOptions {
  render(): void;
  /** Monotonic milliseconds; injectable for tests. */
  now?: () => number;
  baseInterval?: number;
  maxInterval?: number;
}

export interface RenderScheduler {
  /** The content changed; render now or when the interval allows. */
  request(): void;
  /** Render now if a request is pending (the answer finished). */
  flush(): void;
  /** While paused (the cell is hidden) requests are remembered, not rendered. */
  setPaused(paused: boolean): void;
  dispose(): void;
}

export function createRenderScheduler(options: RenderSchedulerOptions): RenderScheduler {
  const now = options.now ?? (() => performance.now());
  const baseInterval = options.baseInterval ?? RENDER_INTERVAL_MS;
  const maxInterval = options.maxInterval ?? RENDER_INTERVAL_MAX_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let paused = false;
  let earliestNext = Number.NEGATIVE_INFINITY;

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function run(): void {
    clearTimer();
    pending = false;
    const startedAt = now();
    options.render();
    const finishedAt = now();
    const interval = Math.min(
      maxInterval,
      Math.max(baseInterval, (finishedAt - startedAt) * COST_FACTOR),
    );
    earliestNext = finishedAt + interval;
  }

  function schedule(): void {
    if (!pending || paused || timer !== undefined) return;
    const wait = earliestNext - now();
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  }

  return {
    request() {
      pending = true;
      schedule();
    },
    flush() {
      if (pending && !paused) run();
    },
    setPaused(next) {
      paused = next;
      if (paused) clearTimer();
      else schedule();
    },
    dispose() {
      clearTimer();
      pending = false;
    },
  };
}
