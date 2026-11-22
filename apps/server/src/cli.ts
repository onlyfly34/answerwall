import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import { BRAND, createLogger, createPairingCode, createServer } from '@answerwall/core';
import type { Logger } from '@answerwall/core';
import { startupLines } from './banner.ts';
import { ConfigError, loadSettings, OPTIONS, serverVersion } from './config.ts';
import type { OptionOverrides, OptionSpec, ServerSettings } from './config.ts';

/**
 * Every signal that asks the process to end and can be caught. SIGHUP is a
 * closed terminal or a lost SSH session; SIGBREAK exists on Windows only.
 * Left to its default action, any of them would end the server without
 * stopping its child processes.
 */
export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK';
export const SIGNALS: readonly Signal[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];

/** How long a shutdown may take before the process exits anyway. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** What the command line needs from the process; tests substitute their own. */
export interface Runtime {
  /** Writes one line to standard output. */
  stdout(line: string): void;
  /** Writes one line to standard error. */
  stderr(line: string): void;
  stdoutIsTty: boolean;
  /** Registers a signal handler and returns the function that removes it. */
  onSignal(signal: Signal, handler: () => void): () => void;
  /**
   * Kills every child process tree now, synchronously and without a grace
   * period. Called before an exit that does not wait for the shutdown, where
   * a child that was only asked to stop would otherwise outlive the server.
   */
  killChildren?: () => void;
  /** Overrides {@link SHUTDOWN_TIMEOUT_MS}. */
  shutdownTimeoutMs?: number;
}

export type Command =
  | { name: 'serve'; overrides: OptionOverrides }
  | { name: 'pair'; overrides: OptionOverrides }
  | { name: 'help' }
  | { name: 'version' };

const COMMANDS = ['serve', 'pair'] as const;
const FLAGGED: readonly OptionSpec[] = OPTIONS.filter(
  (option: OptionSpec) => option.flag !== undefined,
);

/**
 * `[serve|pair] [--flag value ...]`; `serve` when no command is given.
 * @throws ConfigError for an unknown command or flag, or a flag without its value.
 */
export function parseCommandLine(argv: readonly string[]): Command {
  const options: ParseArgsOptionsConfig = {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  };
  for (const option of FLAGGED) {
    options[option.flag ?? ''] = { type: option.kind === 'switch' ? 'boolean' : 'string' };
  }

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
    }) as { values: Record<string, string | boolean | undefined>; positionals: string[] });
  } catch (error) {
    // The parser's own message names the flag, never a value.
    throw new ConfigError((error as Error).message.split('\n')[0] ?? 'Invalid command line');
  }

  if (values['help'] === true || positionals[0] === 'help') return { name: 'help' };
  if (values['version'] === true) return { name: 'version' };
  const [name = 'serve', ...extra] = positionals;
  if (!(COMMANDS as readonly string[]).includes(name) || extra.length > 0) {
    throw new ConfigError(`Unknown command: ${[name, ...extra].join(' ')}`);
  }

  const overrides: OptionOverrides = {};
  for (const option of FLAGGED) {
    const value = values[option.flag ?? ''];
    if (value === undefined) continue;
    overrides[option.name as keyof OptionOverrides] = value === true ? '1' : String(value);
  }
  return { name: name as (typeof COMMANDS)[number], overrides };
}

export function helpText(): string {
  const flagOf = (option: OptionSpec): string =>
    option.flag === undefined ? '' : `--${option.flag}${option.value ? ` ${option.value}` : ''}`;
  const width = Math.max(...OPTIONS.map((option: OptionSpec) => flagOf(option).length));
  const optionLines = OPTIONS.flatMap((option: OptionSpec) => [
    `  ${flagOf(option).padEnd(width)}  ${BRAND.envPrefix}${option.name}`,
    `  ${''.padEnd(width)}    ${option.description}`,
  ]);
  return [
    `${BRAND.name}: one prompt in, many answers side by side.`,
    '',
    'Usage:',
    `  ${BRAND.cliName} [serve] [options]   Start the server.`,
    `  ${BRAND.cliName} pair [options]      Print a new pairing code for the server using the same data directory.`,
    `  ${BRAND.cliName} --help | --version`,
    '',
    'Options (command-line flag, environment variable):',
    ...optionLines,
    '',
    'A flag wins over its environment variable. Unknown variables with the',
    `${BRAND.envPrefix} prefix are refused. Secrets for providers can be supplied as`,
    `${BRAND.envPrefix}SECRET_<KEY> variables.`,
  ].join('\n');
}

/** What to tell the operator about a failed start, without a stack trace. */
function describeFailure(error: unknown, settings: ServerSettings | undefined): string {
  if (!(error instanceof Error)) return 'Unexpected failure';
  const code = (error as NodeJS.ErrnoException).code;
  const { host, port } = settings?.config ?? {};
  if (code === 'EADDRINUSE') return `Port ${port} on ${host} is already in use`;
  if (code === 'EACCES') return `Binding ${host} port ${port} is not permitted`;
  if (code === 'EADDRNOTAVAIL') return `The address ${host} is not available on this machine`;
  return error.message;
}

function report(runtime: Runtime, error: unknown, settings?: ServerSettings): number {
  runtime.stderr(`${BRAND.cliName}: ${describeFailure(error, settings)}`);
  if (!(error instanceof ConfigError)) return EXIT_FAILURE;
  runtime.stderr(`Run "${BRAND.cliName} --help" for the list of options.`);
  return EXIT_USAGE;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Starts the shutdown, as a signal would. */
  stop(): void;
  /** Resolves with the exit code once the server has shut down. */
  exited: Promise<number>;
}

/**
 * Starts the server and installs the signal handlers. The first signal
 * shuts down gracefully (asks are cancelled and every child process is
 * killed); a second one, or a shutdown that takes too long, ends the wait
 * and kills the remaining child processes outright.
 * @throws whatever keeps the server from starting; nothing is left running then.
 */
export async function serve(
  settings: ServerSettings,
  env: NodeJS.ProcessEnv,
  runtime: Runtime,
): Promise<RunningServer> {
  const { config } = settings;
  const logger: Logger = createLogger({
    level: config.logLevel,
    format: settings.logFormat ?? (runtime.stdoutIsTty ? 'text' : 'json'),
    write: (line) => runtime.stdout(line),
  });

  const server = await createServer(config, { logger, env });
  let listening: { port: number; url: string };
  try {
    listening = await server.listen();
  } catch (error) {
    await server.shutdown().catch(() => undefined);
    throw error;
  }
  for (const line of startupLines(config, listening)) logger[line.level](line.message, line.fields);

  let stop: () => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    let stopping = false;
    let removers: (() => void)[] = [];
    const finish = (code: number): void => {
      for (const remove of removers) remove();
      // Anything but a completed shutdown may have left child processes behind.
      if (code !== EXIT_OK) runtime.killChildren?.();
      resolve(code);
    };
    const onSignal = (signal?: Signal): void => {
      if (stopping) {
        logger.warn('second signal: exiting without waiting for the shutdown');
        finish(EXIT_FAILURE);
        return;
      }
      stopping = true;
      logger.info('shutting down', signal === undefined ? {} : { signal });
      const timer = setTimeout(() => {
        logger.error('shutdown timed out');
        finish(EXIT_FAILURE);
      }, runtime.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
      void server
        .shutdown()
        .then(
          () => EXIT_OK,
          (error: unknown) => {
            // Only the error's class: its message may contain paths.
            logger.error('shutdown failed', {
              error: error instanceof Error ? error.name : 'unknown',
            });
            return EXIT_FAILURE;
          },
        )
        .then((code) => {
          clearTimeout(timer);
          if (code === EXIT_OK) logger.info('stopped');
          finish(code);
        });
    };
    removers = SIGNALS.map((signal) => runtime.onSignal(signal, () => onSignal(signal)));
    stop = () => onSignal();
  });

  return { url: listening.url, port: listening.port, stop, exited };
}

/** Prints a fresh pairing code for the server that uses the same data directory. */
async function pair(settings: ServerSettings, runtime: Runtime): Promise<void> {
  // The command's output is the code; only problems go to the log, on stderr.
  const logger = createLogger({
    level: 'warn',
    format: 'text',
    write: (line) => runtime.stderr(line),
  });
  const { code, expiresAt } = await createPairingCode(settings.config, { logger });
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  const half = Math.ceil(code.length / 2);
  runtime.stdout(`Pairing code: ${code.slice(0, half)} ${code.slice(half)}`);
  runtime.stdout(
    `Valid for ${minutes} minutes and for one device. Enter it on the sign-in page of ${BRAND.name}.`,
  );
}

/**
 * The whole command line. Resolves with the process exit code: at once for
 * `pair`, `--help` and errors, after the shutdown for `serve`.
 */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  runtime: Runtime,
  onListening?: (server: RunningServer) => void,
): Promise<number> {
  let settings: ServerSettings | undefined;
  try {
    const command = parseCommandLine(argv);
    if (command.name === 'help') {
      runtime.stdout(helpText());
      return EXIT_OK;
    }
    if (command.name === 'version') {
      runtime.stdout(serverVersion());
      return EXIT_OK;
    }
    settings = loadSettings(env, command.overrides);
    if (command.name === 'pair') {
      await pair(settings, runtime);
      return EXIT_OK;
    }
    const server = await serve(settings, env, runtime);
    onListening?.(server);
    return await server.exited;
  } catch (error) {
    return report(runtime, error, settings);
  }
}
