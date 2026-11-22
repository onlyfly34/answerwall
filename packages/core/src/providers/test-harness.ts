import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderEvent, RunRequest } from '../contracts/index.ts';
import type { CliProviderInstance, CliProviderKind } from '../protocol/index.ts';
import { systemClock } from '../system.ts';
import { createMemoryLogger } from '../testing/index.ts';
import type { CliContext } from './cli/run-cli.ts';

/** The directory of mock CLI launchers; tests put it on the PATH they hand to adapters. */
export const MOCK_BIN_DIR = fileURLToPath(
  new URL('../../../../tools/mock-clis/bin', import.meta.url),
);

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

/** Polls until `condition` holds; real time, because real processes are involved. */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether a process exists and is not merely waiting to be reaped. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  try {
    const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return status.slice(status.lastIndexOf(')') + 2, status.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** One line of the log every mock CLI invocation appends to. */
export interface MockInvocation {
  kind?: string;
  pid?: number;
  argv?: string[];
  cwd?: string;
  envNames?: string[];
  env?: Record<string, string | null>;
  scenario?: string;
  prompt?: string;
  grandchildPid?: number;
}

export interface MockCliHarness {
  context: CliContext;
  logger: ReturnType<typeof createMemoryLogger>;
  /** Aborting it is the registry's shutdown. */
  shutdown: AbortController;
  /** A fresh empty directory, as the runner would provide. */
  workDir(): Promise<string>;
  request(overrides?: Partial<RunRequest>): Promise<RunRequest>;
  /** What the mocks recorded about their invocations, oldest first. */
  invocations(): Promise<MockInvocation[]>;
  cleanup(): Promise<void>;
}

/**
 * A directory that holds Node and nothing else. The directory Node is
 * installed in often also holds real CLIs (`npm install -g` puts them there),
 * and a test must never be able to reach one of those, not even when a mock
 * is missing. Windows keeps Node's own directory: creating a link there needs
 * privileges a test cannot assume.
 */
async function isolatedNodeDir(root: string): Promise<string> {
  if (process.platform === 'win32') return path.dirname(process.execPath);
  const dir = path.join(root, 'node-bin');
  await mkdir(dir);
  await symlink(process.execPath, path.join(dir, 'node'));
  return dir;
}

/**
 * A `CliContext` whose PATH holds only the mock CLIs and Node itself, on the
 * real clock with short kill and drain delays.
 */
export async function createMockCliHarness(
  options: { env?: Record<string, string>; context?: Partial<CliContext> } = {},
): Promise<MockCliHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mock-cli-'));
  const logFile = path.join(root, 'invocations.jsonl');
  if (process.platform !== 'win32') {
    // An archive without permission bits must not make every test fail with "not installed".
    for (const kind of ['claude', 'codex', 'agy', 'grok']) {
      const launcher = path.join(MOCK_BIN_DIR, kind);
      if (((await stat(launcher)).mode & 0o111) === 0) await chmod(launcher, 0o755);
    }
  }
  const nodeDir = await isolatedNodeDir(root);
  const inherited = Object.fromEntries(
    ['SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP'].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
  const logger = createMemoryLogger();
  const shutdown = new AbortController();
  let workDirs = 0;
  const workDir = (): Promise<string> => mkdtemp(path.join(root, `work-${++workDirs}-`));
  return {
    logger,
    shutdown,
    context: {
      env: {
        ...inherited,
        PATH: [MOCK_BIN_DIR, nodeDir].join(path.delimiter),
        MOCK_CLI_LOG: logFile,
        ...options.env,
      },
      platform: process.platform,
      clock: systemClock,
      logger,
      shutdownSignal: shutdown.signal,
      killGraceMs: 150,
      exitDrainMs: 50,
      ...options.context,
    },
    workDir,
    async request(overrides = {}) {
      return {
        prompt: 'What is 2 + 2?',
        timeoutMs: 300_000,
        signal: new AbortController().signal,
        workDir: overrides.workDir ?? (await workDir()),
        ...overrides,
      };
    },
    async invocations() {
      const text = await readFile(logFile, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as MockInvocation);
    },
    async cleanup() {
      shutdown.abort();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

export function cliInstance(
  kind: CliProviderKind,
  overrides: Partial<CliProviderInstance> = {},
): CliProviderInstance {
  return {
    id: kind,
    kind,
    label: kind,
    enabled: true,
    concurrency: 1,
    models: [],
    useEnvApiKey: false,
    riskAcknowledged: kind === 'agy',
    ...overrides,
  };
}

/** The text of every `delta`, joined: the answer as the user would read it. */
export const answerOf = (events: ProviderEvent[]): string =>
  events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('');

export const reasoningOf = (events: ProviderEvent[]): string =>
  events.flatMap((event) => (event.type === 'reasoning' ? [event.text] : [])).join('');

export const noticesOf = (events: ProviderEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'notice' ? [event.message] : []));

export const typesOf = (events: ProviderEvent[]): string[] => events.map((event) => event.type);
