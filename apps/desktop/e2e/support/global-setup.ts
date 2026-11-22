/**
 * Runs once before the tests: checks that what they start has been built and
 * prepares the run directory with the same sandbox the server suite uses (a
 * `PATH` that holds the mock CLIs and Node and nothing else).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  prepareSandbox,
  ROOT,
  RUN_DIR_ENV,
  SERVER_MAIN,
} from '../../../../e2e/support/environment.ts';
import { APP_MAIN, PACKAGED_EXECUTABLE } from './app.ts';

export default async function globalSetup(): Promise<void> {
  const needed = [
    // The remote-mode tests connect the app to a real server.
    [SERVER_MAIN, 'pnpm build'],
    ...(PACKAGED_EXECUTABLE === undefined
      ? [[APP_MAIN, 'pnpm --filter @answerwall/desktop build']]
      : [[PACKAGED_EXECUTABLE, 'pnpm --filter @answerwall/desktop package']]),
  ];
  for (const [file, command] of needed) {
    if (file === undefined || !existsSync(file)) {
      throw new Error(`${path.relative(ROOT, file ?? '')} is missing: run \`${command}\` first.`);
    }
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'answerwall-desktop-e2e-'));
  process.env[RUN_DIR_ENV] = dir;
  try {
    await prepareSandbox();
  } catch (error) {
    // The teardown does not run after a failed setup.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
