/**
 * Entry point of the utility process the main process starts for local mode.
 * See `host.ts` for what it does; this file only supplies the real process.
 */
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import {
  createLogger,
  createServer,
  killChildProcessTrees,
  watchChildProcessTrees,
} from '@answerwall/core';
import { runHost } from './host.ts';
import type { Reaper } from './host.ts';
import { watchParentProcess } from './parent-watch.ts';
import type { ParentWatch } from './parent-watch.ts';

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

/**
 * The creation time of the process with this id, which no other process with
 * the same id shares. Windows only: elsewhere a process whose parent ended
 * is adopted, which shows in `process.ppid`. Asked of the system's own
 * PowerShell, since Node has no call for it; `undefined` when that fails.
 */
function identifyProcess(pid: number): Promise<string | undefined> {
  const systemRoot = process.env['SystemRoot'];
  if (process.platform !== 'win32' || systemRoot === undefined || !Number.isInteger(pid)) {
    return Promise.resolve(undefined);
  }
  const powershell = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return new Promise((resolve) => {
    try {
      execFile(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
        ],
        { windowsHide: true, timeout: 15_000 },
        (error, stdout) => {
          const value = stdout.trim();
          resolve(error === null && /^\d+$/.test(value) ? value : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

function watchParent(gone: () => void): ParentWatch {
  return watchParentProcess(
    {
      parentPid: () => process.ppid,
      exists(pid) {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          // Not allowed to signal it: it exists.
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      },
      identify: identifyProcess,
      every(ms, task) {
        const timer = setInterval(task, ms);
        // The check alone must not keep the process running.
        timer.unref();
        return () => clearInterval(timer);
      },
    },
    gone,
  );
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
