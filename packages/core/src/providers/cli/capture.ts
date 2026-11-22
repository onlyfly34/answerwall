import os from 'node:os';
import { resolveExecutable } from './resolve-executable.ts';
import type { CliContext } from './run-cli.ts';
import { spawnCli } from './spawn-cli.ts';

/** Status and listing commands answer quickly or not at all. */
export const DETECT_TIMEOUT_MS = 15_000;

const MAX_CAPTURE_LENGTH = 8 * 1024 * 1024;

export type CaptureResult =
  | { outcome: 'exited'; code: number | null; stdout: string; stderr: string }
  | { outcome: 'not_found' | 'spawn_failed' | 'timeout' | 'aborted' };

/**
 * Runs a status or listing subcommand to completion and returns what it
 * printed. Bounded in time and size; stops on shutdown. The child gets no
 * stdin and a neutral working directory.
 */
export async function captureCli(
  executable: string,
  args: string[],
  env: Record<string, string>,
  context: CliContext,
): Promise<CaptureResult> {
  if (context.shutdownSignal.aborted) return { outcome: 'aborted' };
  const resolved = await resolveExecutable(executable, {
    env: context.env,
    platform: context.platform,
    ...(context.fs ? { fs: context.fs } : {}),
  });
  if (!resolved.found) {
    return { outcome: resolved.reason === 'not_found' ? 'not_found' : 'spawn_failed' };
  }

  const stop = new AbortController();
  let timedOut = false;
  const cancelTimeout = context.clock.schedule(context.detectTimeoutMs ?? DETECT_TIMEOUT_MS, () => {
    timedOut = true;
    stop.abort();
  });
  const onShutdown = (): void => stop.abort();
  context.shutdownSignal.addEventListener('abort', onShutdown, { once: true });

  try {
    let stdout = '';
    const output = spawnCli({
      command: resolved.command,
      args,
      cwd: os.tmpdir(),
      env,
      stdin: null,
      signal: stop.signal,
      clock: context.clock,
      platform: context.platform,
      hostEnv: context.env,
      maxLineLength: MAX_CAPTURE_LENGTH,
      ...(context.killGraceMs === undefined ? {} : { killGraceMs: context.killGraceMs }),
      ...(context.exitDrainMs === undefined ? {} : { exitDrainMs: context.exitDrainMs }),
    });
    for await (const item of output) {
      if (item.type === 'line') {
        if (stdout.length < MAX_CAPTURE_LENGTH) stdout += `${item.text}\n`;
        continue;
      }
      const { exit } = item;
      if (exit.aborted) return { outcome: timedOut ? 'timeout' : 'aborted' };
      if (exit.spawnError) {
        return { outcome: exit.spawnError.code === 'ENOENT' ? 'not_found' : 'spawn_failed' };
      }
      return { outcome: 'exited', code: exit.code, stdout, stderr: exit.stderr };
    }
    return { outcome: 'spawn_failed' };
  } finally {
    cancelTimeout();
    context.shutdownSignal.removeEventListener('abort', onShutdown);
  }
}
