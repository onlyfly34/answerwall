/**
 * Runs once before the workers start: builds the repository when the
 * compiled server or UI is missing or older than its sources, and prepares
 * the run directory with the sandbox every test server starts in.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_MAIN,
  prepareSandbox,
  ROOT,
  RUN_DIR_ENV,
  SERVER_MAIN,
  WEB_INDEX,
} from './environment.ts';

const OUTPUTS = [SERVER_MAIN, CORE_MAIN, WEB_INDEX];
const SOURCES = [
  'packages/core/src',
  'packages/core/package.json',
  'packages/web/src',
  'packages/web/public',
  'packages/web/index.html',
  'packages/web/vite.config.ts',
  'packages/web/package.json',
  'apps/server/src',
  'apps/server/package.json',
];

function newest(target: string): number {
  if (!existsSync(target)) return 0;
  const stats = statSync(target);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let latest = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    latest = Math.max(latest, newest(path.join(target, entry.name)));
  }
  return latest;
}

/** Why a build is needed, or `undefined` when the compiled output is current. */
function buildReason(): string | undefined {
  const missing = OUTPUTS.find((file) => !existsSync(file));
  if (missing) return `${path.relative(ROOT, missing)} is missing`;
  const built = Math.min(...OUTPUTS.map((file) => statSync(file).mtimeMs));
  const changed = SOURCES.find((source) => newest(path.join(ROOT, source)) > built);
  return changed ? `${changed} changed after the last build` : undefined;
}

function build(): void {
  // Under `pnpm run`, the package manager tells its children how it was started.
  const execPath = process.env['npm_execpath'];
  const viaNode = execPath !== undefined && /\.[cm]?js$/.test(execPath);
  const command = viaNode ? process.execPath : (execPath ?? 'pnpm');
  const args = [...(viaNode && execPath ? [execPath] : []), '-r', 'run', 'build'];
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    // A bare `pnpm` is a .cmd shim on Windows, which only a shell can start.
    shell: process.platform === 'win32' && execPath === undefined,
  });
  if (result.status !== 0) {
    throw new Error(`The build failed (${result.error?.message ?? `exit ${result.status}`})`);
  }
}

export default async function globalSetup(): Promise<void> {
  const mode = process.env['E2E_BUILD'] ?? 'auto';
  const reason = mode === 'always' ? 'E2E_BUILD=always' : buildReason();
  if (reason !== undefined) {
    if (mode === 'never') throw new Error(`E2E_BUILD=never, but ${reason}`);
    process.stdout.write(`[e2e] building (${reason})\n`);
    build();
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'answerwall-e2e-'));
  process.env[RUN_DIR_ENV] = dir;
  try {
    await prepareSandbox();
  } catch (error) {
    // The teardown does not run after a failed setup.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
