import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';

export const TICK_INTERVAL_MS = 1000;

/** The current time, refreshed once per interval while `active`; one timer serves every cell. */
export function createTicker(active: Accessor<boolean>): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!active()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  });
  return now;
}
