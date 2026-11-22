import { getCookie } from 'hono/cookie';
import { BRAND } from '../brand.ts';
import { AppError } from '../contracts/index.ts';
import type { AppMiddleware, Clock } from '../contracts/index.ts';
import { API_PATHS } from '../protocol/index.ts';
import { rateLimitKey } from './addresses.ts';

export const AUTH_FAILURE_WINDOW_MS = 60_000;
/** Upper bound on the number of client addresses tracked at once. */
export const MAX_TRACKED_CLIENTS = 10_000;

export interface FailureLimiter {
  /** Milliseconds until `key` may try again; `0` when it is under `limit`. */
  retryAfterMs(key: string, limit: number): number;
  /** Counts one failed attempt now. */
  record(key: string): void;
  /** Marks an unauthenticated sign-in attempt as running; call the result when it has finished. */
  begin(key: string): () => void;
  /** Number of keys currently held in memory. */
  readonly size: number;
}

/**
 * Sliding-window counter of failed attempts per key. Memory is bounded: a
 * key keeps at most `maxFailuresKept` timestamps, expired keys are dropped
 * as they are met, and beyond `maxKeys` the key that failed longest ago goes.
 */
export function createFailureLimiter(options: {
  clock: Clock;
  windowMs?: number;
  maxKeys?: number;
  maxFailuresKept: number;
}): FailureLimiter {
  const { clock, maxFailuresKept } = options;
  const windowMs = options.windowMs ?? AUTH_FAILURE_WINDOW_MS;
  const maxKeys = options.maxKeys ?? MAX_TRACKED_CLIENTS;
  /** Failure times per key, oldest first. Keys are ordered by their latest failure. */
  const failures = new Map<string, number[]>();
  const running = new Map<string, number>();

  const recent = (key: string): number[] => {
    const times = failures.get(key);
    if (!times) return [];
    const cutoff = clock.now() - windowMs;
    const kept = times.filter((time) => time > cutoff);
    if (kept.length === 0) failures.delete(key);
    else if (kept.length !== times.length) failures.set(key, kept);
    return kept;
  };

  const dropExpired = (): void => {
    for (const key of [...failures.keys()]) recent(key);
  };

  return {
    retryAfterMs(key, limit) {
      const times = recent(key);
      const pending = running.get(key) ?? 0;
      if (times.length + pending < limit) return 0;
      // Held back only by attempts that are still running: they finish soon.
      if (times.length < limit) return 1000;
      // The attempt that has to leave the window before one more fits.
      const blocking = times[times.length - limit] ?? clock.now();
      return Math.max(1, blocking + windowMs - clock.now());
    },

    record(key) {
      const times = recent(key);
      times.push(clock.now());
      // Re-inserting moves the key to the end: eviction order is "failed longest ago".
      failures.delete(key);
      failures.set(key, times.slice(-maxFailuresKept));
      if (failures.size > maxKeys) dropExpired();
      while (failures.size > maxKeys) {
        const oldest = failures.keys().next();
        if (oldest.done) break;
        failures.delete(oldest.value);
      }
    },

    begin(key) {
      running.set(key, (running.get(key) ?? 0) + 1);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const left = (running.get(key) ?? 1) - 1;
        if (left <= 0) running.delete(key);
        else running.set(key, left);
      };
    },

    get size() {
      return failures.size;
    },
  };
}

/** The sign-in routes: every request to them is an attempt to prove a credential. */
const SIGN_IN_ROUTES: ReadonlySet<string> = new Set([
  `POST ${API_PATHS.authPair}`,
  `POST ${API_PATHS.authSession}`,
]);

/**
 * Stops a client address that keeps presenting wrong credentials.
 *
 * Only requests that end with `authFailure` are counted. While an address is
 * over the limit, every request from it that presents a credential (bearer
 * token, session cookie, or a sign-in attempt) is refused before the
 * credential is looked at; requests without one still get through, so the
 * sign-in page keeps loading and can explain what happened.
 *
 * Sign-in attempts that are still running count as failures until they
 * finish, so a burst of parallel guesses cannot outrun the counter.
 */
export function createAuthRateLimit(deps: {
  /** The current failed-attempt limit per window. */
  limit: () => number;
  limiter: FailureLimiter;
}): AppMiddleware {
  const { limiter } = deps;
  return async (c, next) => {
    const signIn = SIGN_IN_ROUTES.has(`${c.req.method} ${c.req.path}`);
    const presentsCredential =
      signIn ||
      c.req.header('Authorization') !== undefined ||
      getCookie(c, BRAND.sessionCookie) !== undefined;
    if (!presentsCredential) return next();

    const key = rateLimitKey(c.var.client.address);
    const retryAfterMs = limiter.retryAfterMs(key, deps.limit());
    if (retryAfterMs > 0) {
      c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      throw new AppError('rate_limited', 'Too many failed sign-in attempts. Try again later.');
    }

    const finish = signIn ? limiter.begin(key) : undefined;
    try {
      await next();
    } finally {
      finish?.();
    }
    if (c.var.authFailure) limiter.record(key);
  };
}
