/**
 * Entry point of the utility process the main process starts for local mode.
 * See `host.ts` for what it does; this file only supplies the real process.
 */
import { spawn } from 'node:child_process';
import {
  createLogger,
  createServer,
  killChildProcessTrees,
  watchChildProcessTrees,
} from '@answerwall/core';
import { runHost } from './host.ts';
import type { Reaper } from './host.ts';

const logger = createLogger({ level: 'info', format: 'json' });

/** Starts the helper with this executable in plain Node mode and a pipe to its stdin. */
function startReaper(script: string): Reaper | undefined {
  try {
    const child = spawn(process.execPath, [script], {
      // Nothing of this process's environment is of use to it.
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ...(process.env['SystemRoot'] === undefined
          ? {}
          : { SystemRoot: process.env['SystemRoot'] }),
      },
      stdio: ['pipe', 'ignore', 'ignore'],
      // It must outlive this process however this one ends. POSIX: a session
      // of its own, so no signal aimed at the app reaches it. Windows: outside
      // the job object in which Node keeps the children it starts, whose
      // processes the system kills together with their parent.
      detached: true,
      windowsHide: true,
      shell: false,
    });
    const stdin = child.stdin;
    let open = true;
    const closed = (): void => {
      open = false;
    };
    child.on('error', closed);
    child.on('exit', closed);
    stdin.on('error', closed);
    // The helper must not keep this process alive.
    child.unref();
    return {
      report(pid, state) {
        if (open) stdin.write(`${state === 'started' ? '+' : '-'}${pid}\n`);
      },
    };
  } catch {
    return undefined;
  }
}

/** How often the host looks whether the main process still exists. */
const PARENT_CHECK_MS = 2_000;

function watchParent(gone: () => void): void {
  const parent = process.ppid;
  const alive = (): boolean => {
    // Adopted by another process: the one that started this one has ended.
    if (process.ppid !== parent) return false;
    try {
      process.kill(parent, 0);
      return true;
    } catch (error) {
      // Not allowed to signal it: it exists.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  const timer = setInterval(() => {
    if (alive()) return;
    clearInterval(timer);
    gone();
  }, PARENT_CHECK_MS);
  // The check alone must not keep the process running.
  timer.unref();
}

// No exit, however it comes about, may leave a CLI child behind.
process.on('exit', killChildProcessTrees);
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error: unknown) => {
    logger.error('the local server crashed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    killChildProcessTrees();
    process.exit(1);
  });
}

runHost({
  port: {
    postMessage: (message) => process.parentPort.postMessage(message),
    onMessage: (listener) => process.parentPort.on('message', (event) => listener(event.data)),
  },
  createServer,
  logger,
  env: process.env,
  watchChildren: watchChildProcessTrees,
  killChildren: killChildProcessTrees,
  startReaper,
  watchParent,
  exit: (code) => process.exit(code),
  schedule(ms, task) {
    const timer = setTimeout(task, ms);
    return () => clearTimeout(timer);
  },
});
