import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Clock } from '../../contracts/index.ts';
import { envValue } from './resolve-executable.ts';

/** How long a process group gets to exit after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 3_000;

export interface TreeKillerOptions {
  platform: NodeJS.Platform;
  clock: Clock;
  /** The server's environment; locates `taskkill` on Windows. */
  env: NodeJS.ProcessEnv;
  graceMs?: number;
  /** Signals a process group; replaced in tests. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Starts a helper process; replaced in tests. */
  run?: (file: string, args: string[]) => void;
}

export interface TreeKiller {
  /** Asks the whole tree to stop, and forces it after the grace period. Idempotent. */
  terminate(): void;
  /** Kills whatever is left of the tree now and cancels the pending escalation. */
  sweep(): void;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

function runDetached(file: string, args: string[]): void {
  const helper = spawn(file, args, { stdio: 'ignore', windowsHide: true, shell: false });
  helper.on('error', () => undefined);
  helper.unref();
}

function taskkillPath(env: NodeJS.ProcessEnv): string {
  const root = envValue(env, 'SystemRoot', 'win32');
  return root ? path.win32.join(root, 'System32', 'taskkill.exe') : 'taskkill';
}

/**
 * Kills a child and everything it started. POSIX: the child leads its own
 * process group (spawned `detached`), which gets SIGTERM and then SIGKILL.
 * Windows: `taskkill /T /F`, which is forceful from the start.
 */
export function createTreeKiller(pid: number, options: TreeKillerOptions): TreeKiller {
  const { platform, clock } = options;
  const killGroup = options.killGroup ?? signalGroup;
  const run = options.run ?? runDetached;
  let terminated = false;
  let cancelEscalation: (() => void) | undefined;

  const force = (): void => {
    if (platform === 'win32') run(taskkillPath(options.env), ['/T', '/F', '/PID', String(pid)]);
    else killGroup(pid, 'SIGKILL');
  };

  return {
    terminate() {
      if (terminated) return;
      terminated = true;
      if (platform === 'win32') {
        force();
        return;
      }
      killGroup(pid, 'SIGTERM');
      cancelEscalation = clock.schedule(options.graceMs ?? KILL_GRACE_MS, force);
    },
    sweep() {
      cancelEscalation?.();
      cancelEscalation = undefined;
      // On Windows the tree cannot be addressed once its root has exited.
      if (platform !== 'win32') killGroup(pid, 'SIGKILL');
    },
  };
}
