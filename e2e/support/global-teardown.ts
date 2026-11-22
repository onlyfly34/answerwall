/**
 * Runs once after the last worker: every test stops its own server, so
 * anything still registered here was left behind. It is ended, and the run
 * fails, because a suite that leaks processes is broken even when green.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { registryDir, RUN_DIR_ENV } from './environment.ts';
import { isAlive, killTree, mockPids } from './server.ts';

interface Registration {
  pid: number;
  mockLog: string;
}

export default async function globalTeardown(): Promise<void> {
  const dir = process.env[RUN_DIR_ENV];
  if (!dir || !existsSync(dir)) return;

  const leaked: string[] = [];
  for (const name of readdirSync(registryDir())) {
    const entry = JSON.parse(readFileSync(path.join(registryDir(), name), 'utf8')) as Registration;
    if (isAlive(entry.pid)) {
      leaked.push(`server ${entry.pid}`);
      killTree(entry.pid);
    }
    for (const pid of mockPids(entry.mockLog).filter(isAlive)) {
      leaked.push(`mock CLI ${pid}`);
      killTree(pid);
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (leaked.length > 0) {
    throw new Error(`Processes were left running and had to be killed: ${leaked.join(', ')}`);
  }
}
