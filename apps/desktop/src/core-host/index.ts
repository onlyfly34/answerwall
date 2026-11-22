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
      // POSIX: a session of its own, so no signal aimed at the app reaches it.
      detached: process.platform !== 'win32',
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
  exit: (code) => process.exit(code),
  schedule(ms, task) {
    const timer = setTimeout(task, ms);
    return () => clearTimeout(timer);
  },
});
