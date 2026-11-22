import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Clock, Logger, ProviderEvent, RunRequest } from '../../contracts/index.ts';
import type { StreamingMode, Usage } from '../../protocol/index.ts';
import { failureFromText } from '../failure.ts';
import type { Failure } from '../failure.ts';
import { resolveExecutable } from './resolve-executable.ts';
import type { ResolverFs } from './resolve-executable.ts';
import { spawnCli } from './spawn-cli.ts';
import type { CliExit } from './spawn-cli.ts';

/** What every CLI adapter is built with. */
export interface CliContext {
  /** The server's environment, before scrubbing. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  clock: Clock;
  logger: Logger;
  /** Aborted on shutdown; stops detection processes. */
  shutdownSignal: AbortSignal;
  /** Overrides for tests. */
  fs?: ResolverFs;
  killGraceMs?: number;
  exitDrainMs?: number;
  maxLineLength?: number;
  detectTimeoutMs?: number;
  /**
   * Receives every complete stdout line of a run as the CLI printed it,
   * before it is parsed. Only `pnpm smoke:real` sets it, to check what a real
   * CLI reported about its own session; the server never does.
   */
  onStdoutLine?: (line: string) => void;
}

export type ContentEvent = Extract<ProviderEvent, { type: 'delta' | 'reasoning' | 'notice' }>;

export interface ParserOutcome {
  /** The CLI reported the end of a successful turn. */
  completed: boolean;
  usage?: Usage;
  /** The CLI reported a failure; without `code` it is guessed from the message. */
  failure?: { code?: Failure['code']; message: string };
}

/** Turns one CLI's JSON events into provider events. One instance per run. */
export interface StreamParser {
  /** One JSON object from stdout. Unknown shapes return nothing. */
  event(value: Record<string, unknown>): ContentEvent[];
  outcome(): ParserOutcome;
  /**
   * `true` once the CLI announced something it must not be left to do (send
   * the question again by itself). The run is ended there, the process tree
   * is killed, and the failure of `outcome()` is reported.
   */
  stopped?(): boolean;
}

/** One invocation, as data. */
export interface CliInvocation {
  /** Bare command name, looked up on PATH. */
  executable: string;
  args: string[];
  env: Record<string, string>;
  /** Written to stdin, then stdin is closed; `null` gives the child no stdin. */
  stdin: string | null;
  /** Files created in the work dir before the start (a prompt file). */
  files?: { name: string; content: string }[];
  parser: StreamParser;
  streaming: StreamingMode;
  /**
   * Recognises, in what a failed run printed, a failure this CLI is known
   * for; its fixed message then replaces the one derived from the text.
   */
  knownFailure?: (printed: string) => Failure | undefined;
}

/** Unparsable stdout kept for the raw-text fallback. */
const MAX_RAW_LENGTH = 256 * 1024;

const error = (failure: Failure): ProviderEvent => ({ type: 'error', ...failure });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON object, or `undefined` for anything else: blank, garbage, a bare string or array. */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const text = line.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function failureFromExit(exit: CliExit, rawOutput: string, executable: string): Failure {
  if (exit.spawnError) {
    return exit.spawnError.code === 'ENOENT'
      ? { code: 'not_installed', message: `\`${executable}\` could not be found.` }
      : {
          code: 'spawn_failed',
          message: `\`${executable}\` could not be started (${exit.spawnError.code ?? 'error'}).`,
        };
  }
  const said = [exit.stderr, rawOutput].filter((part) => part.trim() !== '').join('\n');
  const how =
    exit.code === null
      ? `was terminated by ${exit.signal ?? 'a signal'}`
      : `exited with code ${exit.code}`;
  const failure = failureFromText(said, '');
  const prefix = `\`${executable}\` ${how}`;
  return {
    code: failure.code,
    message: failure.message ? `${prefix}: ${failure.message}` : `${prefix}.`,
  };
}

/**
 * Runs one CLI invocation and maps it to provider events: `start`, content,
 * then exactly one `done` or `error`. Never throws. Stdout is read as JSON
 * lines; lines that are not JSON objects are kept and shown as the answer
 * when the CLI succeeded without any parsable answer.
 */
export async function* runCli(
  invocation: CliInvocation,
  request: RunRequest,
  context: CliContext,
): AsyncGenerator<ProviderEvent, void, void> {
  const { clock } = context;
  const startedAt = clock.now();
  yield { type: 'start', streaming: invocation.streaming };

  if (request.signal.aborted) {
    yield error({ code: 'cancelled', message: 'Cancelled before the CLI was started.' });
    return;
  }
  const { executable, parser } = invocation;

  let exit: CliExit | undefined;
  let stopped = false;
  let answered = false;
  let truncatedLines = 0;
  let raw = '';
  try {
    const resolved = await resolveExecutable(executable, {
      env: context.env,
      platform: context.platform,
      ...(context.fs ? { fs: context.fs } : {}),
    });
    if (!resolved.found) {
      yield error(
        resolved.reason === 'not_found'
          ? { code: 'not_installed', message: `\`${executable}\` was not found on PATH.` }
          : {
              code: 'spawn_failed',
              message: `\`${executable}\` on PATH is a launcher script that cannot be started without a shell.`,
            },
      );
      return;
    }
    for (const file of invocation.files ?? []) {
      await writeFile(path.join(request.workDir, file.name), file.content, { mode: 0o600 });
    }

    const output = spawnCli({
      command: resolved.command,
      args: invocation.args,
      cwd: request.workDir,
      env: invocation.env,
      stdin: invocation.stdin,
      signal: request.signal,
      clock,
      platform: context.platform,
      hostEnv: context.env,
      ...(context.killGraceMs === undefined ? {} : { killGraceMs: context.killGraceMs }),
      ...(context.exitDrainMs === undefined ? {} : { exitDrainMs: context.exitDrainMs }),
      ...(context.maxLineLength === undefined ? {} : { maxLineLength: context.maxLineLength }),
    });
    for await (const item of output) {
      if (item.type === 'exit') {
        exit = item.exit;
        break;
      }
      if (item.truncated) {
        truncatedLines++;
        continue;
      }
      context.onStdoutLine?.(item.text);
      const value = parseJsonLine(item.text);
      if (value === undefined) {
        if (raw.length < MAX_RAW_LENGTH)
          raw += `${item.text}\n`.slice(0, MAX_RAW_LENGTH - raw.length);
        continue;
      }
      for (const event of parser.event(value)) {
        if (event.type === 'delta' && event.text !== '') answered = true;
        yield event;
      }
      if (parser.stopped?.()) {
        // Leaving the loop kills the process tree and waits until it is gone.
        stopped = true;
        break;
      }
    }
  } catch (cause) {
    context.logger.warn('provider run failed unexpectedly', {
      executable,
      error: cause instanceof Error ? cause.name : 'unknown',
    });
    yield error({ code: 'unknown', message: `\`${executable}\` could not be run.` });
    return;
  }
  if (truncatedLines > 0) {
    yield { type: 'notice', message: 'Part of the output was too large and was dropped.' };
  }
  if (stopped) {
    const failure = request.signal.aborted ? undefined : parser.outcome().failure;
    yield error(
      failure === undefined
        ? { code: 'cancelled', message: 'The CLI was stopped.' }
        : failureFromText(failure.message, `\`${executable}\` was stopped.`, failure.code),
    );
    return;
  }
  if (exit === undefined) {
    yield error({ code: 'unknown', message: `\`${executable}\` ended unexpectedly.` });
    return;
  }
  if (exit.aborted) {
    yield error({ code: 'cancelled', message: 'The CLI was stopped.' });
    return;
  }
  if (exit.spawnError) {
    yield error(failureFromExit(exit, '', executable));
    return;
  }
  const outcome = parser.outcome();
  if (outcome.failure) {
    yield error(
      failureFromText(
        outcome.failure.message,
        `\`${executable}\` reported an error.`,
        outcome.failure.code,
      ),
    );
    return;
  }
  const rawText = raw.trim();
  if (exit.code !== 0 && !outcome.completed) {
    yield error(
      invocation.knownFailure?.(`${exit.stderr}\n${rawText}`) ??
        failureFromExit(exit, rawText, executable),
    );
    return;
  }
  if (!answered && !outcome.completed) {
    if (rawText === '') {
      yield error({ code: 'bad_output', message: `\`${executable}\` produced no answer.` });
      return;
    }
    // Not the documented format: show what it printed rather than nothing.
    yield { type: 'delta', text: rawText };
  }
  yield {
    type: 'done',
    elapsedMs: Math.max(0, clock.now() - startedAt),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
}
