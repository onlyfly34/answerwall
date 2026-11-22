import type { LogFields, LogLevel, Logger } from '../contracts/index.ts';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: LogLevel;
  /** Receives one JSON document per entry; defaults to a line on stdout. */
  write?: (line: string) => void;
}

/** One JSON object per line: `time`, `level`, `msg`, then the fields. */
export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const log = (level: LogLevel) => (message: string, fields?: LogFields) => {
    if (SEVERITY[level] < SEVERITY[options.level]) return;
    write(
      JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...bound, ...fields }),
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
