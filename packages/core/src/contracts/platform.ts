/** Time source. Production uses the system clock; tests use `FakeClock`. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Runs `callback` once after `delayMs`. Returns a function that cancels it. */
  schedule(delayMs: number, callback: () => void): () => void;
}

/** Identifiers for stored entities (asks, conversations, devices, pairing codes). */
export interface IdGenerator {
  /** A new unique id made of `[A-Za-z0-9_-]`, at most 64 characters. */
  next(): string;
}

/** Cryptographic randomness for tokens and pairing codes. */
export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/**
 * Structured logger. Callers must never pass tokens, cookies, API keys,
 * prompts or answers; the implementation additionally masks known secret
 * field names.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every entry. */
  child(fields: LogFields): Logger;
}
