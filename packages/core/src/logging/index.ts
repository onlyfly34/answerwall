import type { LogFields, LogLevel, Logger } from '../contracts/index.ts';
import { maskFields, maskText } from './mask.ts';

export { maskFields, maskText, REDACTED } from './mask.ts';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFormat = 'json' | 'text';

export interface LoggerOptions {
  level: LogLevel;
  /** `json`: one JSON document per entry (the default). `text`: one readable line per entry. */
  format?: LogFormat;
  /** Receives one line per entry, without the line break; defaults to stdout. */
  write?: (line: string) => void;
  /** Milliseconds since the epoch for the entry's `time`; defaults to the system clock. */
  now?: () => number;
}

const writeToStdout = (line: string): void => {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // A closed stdout must not take the server down.
  }
};

const BARE_VALUE = /^[A-Za-z0-9_./:@[\]-]+$/;

function formatTextValue(value: unknown): string {
  if (typeof value === 'string') return BARE_VALUE.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? 'undefined';
}

function formatText(time: string, level: LogLevel, message: string, fields: LogFields): string {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${formatTextValue(value)}`);
  return [time, level.toUpperCase().padEnd(5), message, ...pairs].join(' ');
}

/**
 * Structured logger. Every entry carries `time`, `level`, `msg` and the
 * fields. Messages and fields pass through the masking rules of `mask.ts`
 * before they are written, so a credential that reaches the logger by
 * mistake is not persisted.
 */
export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const write = options.write ?? writeToStdout;
  const now = options.now ?? Date.now;
  const threshold = SEVERITY[options.level];

  const log = (level: LogLevel) => (message: string, fields?: LogFields) => {
    if (SEVERITY[level] < threshold) return;
    const time = new Date(now()).toISOString();
    const msg = maskText(message);
    const masked = maskFields({ ...bound, ...fields });
    write(
      options.format === 'text'
        ? formatText(time, level, msg, masked)
        : // Assigned twice: first for the key order, last so that no field can replace them.
          JSON.stringify(Object.assign({ time, level, msg }, masked, { time, level, msg })),
    );
  };

  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}
