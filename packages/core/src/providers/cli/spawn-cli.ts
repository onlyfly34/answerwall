import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Clock } from '../../contracts/index.ts';
import { createTreeKiller, KILL_GRACE_MS } from './kill-tree.ts';
import type { TreeKillerOptions } from './kill-tree.ts';
import { createLineSplitter } from './line-splitter.ts';
import type { ResolvedCommand } from './resolve-executable.ts';

/** A stdout line may hold a whole answer; anything longer than this is cut. */
export const MAX_LINE_LENGTH = 16 * 1024 * 1024;
/** Only the end of stderr is kept, for diagnostics. */
export const MAX_STDERR_LENGTH = 64 * 1024;
/** How long stdout may stay open after the CLI itself has exited. */
export const EXIT_DRAIN_MS = 1_000;
/** How long after the forced kill a process that still has not ended is given up on. */
export const ABANDON_MS = 5_000;

/** Lines buffered ahead of the consumer before stdout is paused. */
const QUEUE_HIGH_WATER = 1_000;

export interface SpawnCliOptions {
  command: ResolvedCommand;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Written to stdin, which is then closed. `null`: the child gets no stdin at all. */
  stdin: string | null;
  /** Aborting it kills the whole process tree. */
  signal: AbortSignal;
  clock: Clock;
  platform: NodeJS.Platform;
  /** The server's own environment (locates `taskkill` on Windows). */
  hostEnv: NodeJS.ProcessEnv;
  killGraceMs?: number;
  maxLineLength?: number;
  maxStderrLength?: number;
  exitDrainMs?: number;
  /** Test seams for the tree killer. */
  killer?: Pick<TreeKillerOptions, 'killGroup' | 'run'>;
}

export interface CliExit {
  /** `null` when the process was killed by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The end of stderr, at most `maxStderrLength` characters. */
  stderr: string;
  /** The process could not be started. */
  spawnError?: NodeJS.ErrnoException;
  /** `signal` was aborted before the process ended. */
  aborted: boolean;
}

export type CliOutput =
  { type: 'line'; text: string; truncated: boolean } | { type: 'exit'; exit: CliExit };

/**
 * Starts a CLI without a shell and yields its stdout line by line, then
 * exactly one `exit` item. The iteration always ends, and by then the child
 * and everything it started are gone: on abort, when the consumer stops
 * early, and when a descendant keeps stdout open after the CLI has exited.
 */
export async function* spawnCli(options: SpawnCliOptions): AsyncGenerator<CliOutput, void, void> {
  const { signal, clock, platform } = options;
  if (signal.aborted) {
    yield { type: 'exit', exit: { code: null, signal: null, stderr: '', aborted: true } };
    return;
  }

  const queue: CliOutput[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let discard = false;
  let stderr = '';
  let spawnError: NodeJS.ErrnoException | undefined;
  const maxStderr = options.maxStderrLength ?? MAX_STDERR_LENGTH;
  const splitter = createLineSplitter(options.maxLineLength ?? MAX_LINE_LENGTH);

  const enqueue = (items: CliOutput[]): void => {
    if (!discard) queue.push(...items);
    wake?.();
  };
  const finish = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
    if (closed) return;
    closed = true;
    enqueue(splitter.flush().map((line) => ({ type: 'line', ...line })));
    const exit: CliExit = { code, signal: exitSignal, stderr, aborted: signal.aborted };
    if (spawnError) exit.spawnError = spawnError;
    queue.push({ type: 'exit', exit });
    wake?.();
  };

  let child: ChildProcess;
  try {
    child = spawn(options.command.file, [...options.command.prefixArgs, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      // POSIX: the child leads a new process group, so the whole tree can be signalled.
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: [options.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const exit: CliExit = { code: null, signal: null, stderr: '', aborted: false };
    exit.spawnError = error as NodeJS.ErrnoException;
    yield { type: 'exit', exit };
    return;
  }

  const killer =
    child.pid === undefined
      ? undefined
      : createTreeKiller(child.pid, {
          platform,
          clock,
          env: options.hostEnv,
          ...(options.killGraceMs === undefined ? {} : { graceMs: options.killGraceMs }),
          ...options.killer,
        });
  let cancelDrain: (() => void) | undefined;
  let cancelAbandon: (() => void) | undefined;

  const stop = (): void => {
    killer?.terminate();
    // Killing can fail (no `taskkill`, a process that cannot be signalled); the iteration ends regardless.
    cancelAbandon ??= clock.schedule((options.killGraceMs ?? KILL_GRACE_MS) + ABANDON_MS, () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null, null);
    });
  };

  child.on('error', (error: NodeJS.ErrnoException) => {
    spawnError ??= error;
    // A process that never started emits no `close`.
    if (child.pid === undefined) finish(null, null);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    enqueue(splitter.push(chunk).map((line) => ({ type: 'line', ...line })));
    if (queue.length > QUEUE_HIGH_WATER) child.stdout?.pause();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-maxStderr);
  });
  child.on('exit', () => {
    killer?.rootExited();
    // A descendant holding the pipes would keep `close` from ever arriving.
    cancelDrain = clock.schedule(options.exitDrainMs ?? EXIT_DRAIN_MS, () => {
      killer?.sweep();
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
  });
  child.on('close', (code, exitSignal) => finish(code, exitSignal));

  signal.addEventListener('abort', stop, { once: true });

  if (child.stdin) {
    // The child may exit without reading; that is its exit code's story, not an exception.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  }

  try {
    for (;;) {
      const item = queue.shift();
      if (item !== undefined) {
        yield item;
        if (item.type === 'exit') return;
        continue;
      }
      child.stdout?.resume();
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    signal.removeEventListener('abort', stop);
    if (!closed) {
      // The consumer stopped early: stop the child and wait until it is gone.
      discard = true;
      stop();
      child.stdout?.resume();
      while (!closed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
    cancelDrain?.();
    cancelAbandon?.();
    killer?.sweep();
  }
}
