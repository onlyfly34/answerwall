/**
 * Runs once after the last worker: every test stops its own server, so
 * anything still registered here was left behind. It is ended, and the run
 * fails, because a suite that leaks processes is broken even when green.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  killProcessTree,
  recordedProcesses,
  runningProcesses,
} from '../../tools/mock-clis/src/lib/leftovers.mjs';
import { registryDir, RUN_DIR_ENV } from './environment.ts';
import type { Registration } from './server.ts';

export default async function globalTeardown(): Promise<void> {
  const dir = process.env[RUN_DIR_ENV];
  if (!dir || !existsSync(dir)) return;

  const leaked: string[] = [];
  for (const name of readdirSync(registryDir())) {
    const entry = JSON.parse(readFileSync(path.join(registryDir(), name), 'utf8')) as Registration;
    for (const pid of await runningProcesses([{ pid: entry.pid, at: entry.at }])) {
      leaked.push(`server ${pid}`);
      killProcessTree(pid);
    }
    for (const pid of await runningProcesses(recordedProcesses(entry.mockLog))) {
      leaked.push(`mock CLI ${pid}`);
      killProcessTree(pid);
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (leaked.length > 0) {
    throw new Error(`Processes were left running and had to be killed: ${leaked.join(', ')}`);
  }
}
