/**
 * One compiled server per test: an ephemeral loopback port, a temporary data
 * directory and the sandbox `PATH`. Nothing inside the server is faked.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  killProcessTree,
  recordedProcesses,
  runningProcesses,
} from '../../tools/mock-clis/src/lib/leftovers.mjs';
import { registryDir, runDir, sandboxEnv, SERVER_MAIN } from './environment.ts';
import type { CliKind, MockSet } from './environment.ts';

export interface ServerOptions {
  /** The mock CLIs on the server's `PATH`. */
  mocks: MockSet;
  /** Milliseconds between the lines of a mock's `slow` scenario. */
  mockDelayMs: number;
  /** Extra environment, for example `MOCK_CLI_SCENARIO`. */
  env: Record<string, string>;
}

export const DEFAULT_SERVER_OPTIONS: ServerOptions = { mocks: 'all', mockDelayMs: 120, env: {} };

export interface AskTarget {
  slotId: string;
  providerId: string;
  model?: string;
  effort?: string;
}

export interface SlotSnapshot extends AskTarget {
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'timeout';
  text: string;
  reasoning: string;
  streaming?: 'token' | 'block' | 'unknown';
  error?: { code: string; message: string };
}

export interface AskSnapshot {
  askId: string;
  prompt: string;
  status: 'running' | 'done';
  seq: number;
  slots: SlotSnapshot[];
}

export interface ProviderInstance {
  id: string;
  kind: CliKind | 'openai-compat';
  label: string;
  enabled: boolean;
  concurrency: number;
  models: string[];
  defaultModel?: string;
  [key: string]: unknown;
}

export interface ProviderStatus {
  instance: ProviderInstance;
  detection: {
    installed: boolean;
    version?: string;
    loggedIn: 'yes' | 'no' | 'unknown';
    streaming: 'token' | 'block' | 'unknown';
  } | null;
  models: { id: string }[];
}

export interface PresetInput {
  name: string;
  slots: AskTarget[];
  layout?: { mode: 'auto' | 'fixed'; minCellWidth: number; columns: number };
}

export interface ApiResponse<T = unknown> {
  status: number;
  json: T;
}

/** One line a mock CLI wrote about its own invocation. */
export interface MockInvocation {
  kind?: string;
  pid?: number;
  argv?: string[];
  scenario?: string;
  prompt?: string | null;
  grandchildPid?: number;
}

export interface TestServer {
  /** The origin, for example `http://127.0.0.1:41873`. */
  base: string;
  port: number;
  /** The static token of this server (`ANSWERWALL_TOKEN`), which the test harness signs in with. */
  token: string;
  /** The one-time code the server logged for its first device. */
  firstPairingCode(): Promise<string>;
  /** A fresh pairing code, as a signed-in device would create one. */
  mintPairingCode(): Promise<string>;
  /** Runs `answerwall pair` against the same data directory and returns the code it prints. */
  pairCommand(): Promise<string>;

  /** A request as a non-browser client: bearer token, JSON body. */
  api<T = unknown>(method: string, pathname: string, body?: unknown): Promise<ApiResponse<T>>;
  /** Changes CLI provider instances by id and adds or replaces endpoint instances. */
  setProviders(
    changes: Partial<Record<CliKind, Partial<ProviderInstance>>>,
    endpoints?: ProviderInstance[],
  ): Promise<void>;
  setLimits(limits: Record<string, number>): Promise<void>;
  providers(): Promise<ProviderStatus[]>;
  /** Resolves once every enabled provider has a detection result. */
  detected(): Promise<ProviderStatus[]>;
  putPreset(id: string, preset: PresetInput): Promise<void>;
  ask(prompt: string, targets: AskTarget[]): Promise<string>;
  snapshot(askId: string): Promise<AskSnapshot>;
  /** Resolves with the final snapshot once the ask is done. */
  finished(askId: string): Promise<AskSnapshot>;

  /** What the mock CLIs recorded, oldest first. */
  mockInvocations(): MockInvocation[];
  /** Process ids of mock CLIs (and their children) that are still running. */
  liveMockPids(): Promise<number[]>;
  /** The server's log so far, one JSON object per line. */
  logText(): string;
  /** Stops the server gracefully and removes its directory. Returns the process ids that outlived it. */
  stop(): Promise<number[]>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  what: string,
  condition: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

export function readMockLog(file: string): MockInvocation[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as MockInvocation);
}

/**
 * What a running test server left in the registry of the run: its own process
 * and the file its mock CLIs record themselves in.
 */
export interface Registration {
  pid: number;
  /** When the server had been started; see `leftovers.mjs` for why this is kept. */
  at: number;
  mockLog: string;
}

interface LogEntry {
  msg?: string;
  url?: string;
}

export async function startServer(options: ServerOptions): Promise<TestServer> {
  const temp = await mkdtemp(path.join(runDir(), 'server-'));
  const dataDir = path.join(temp, 'data');
  const home = path.join(temp, 'home');
  const mockLog = path.join(temp, 'mock-invocations.jsonl');
  await mkdir(dataDir);
  await mkdir(home);

  const token = randomBytes(24).toString('hex');
  const env = sandboxEnv({
    mocks: options.mocks,
    home,
    extra: {
      MOCK_CLI_LOG: mockLog,
      MOCK_CLI_DELAY_MS: String(options.mockDelayMs),
      ANSWERWALL_TOKEN: token,
      ...options.env,
    },
  });

  const child: ChildProcess = spawn(
    process.execPath,
    [
      SERVER_MAIN,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      dataDir,
      '--tls',
      'off',
      '--log-format',
      'json',
    ],
    { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  const lines: string[] = [];
  const entries: LogEntry[] = [];
  let buffered = '';
  child.stdout?.setEncoding('utf8').on('data', (text: string) => {
    buffered += text;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      lines.push(line);
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        entries.push({ msg: line });
      }
    }
  });
  child.stderr?.setEncoding('utf8').on('data', (text: string) => lines.push(`[stderr] ${text}`));
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );

  const registration = path.join(registryDir(), `${child.pid}.json`);
  const registered: Registration = { pid: child.pid ?? 0, at: Date.now(), mockLog };
  await writeFile(registration, JSON.stringify(registered));

  const listening = await Promise.race([
    until('the server to listen', () =>
      entries.find((entry) => /is listening/.test(entry.msg ?? '')),
    ),
    exited.then((code) => {
      throw new Error(`The server exited with ${code} before listening:\n${lines.join('\n')}`);
    }),
  ]);
  // The log names the host `localhost`; the socket is bound to the IPv4 loopback address.
  const port = Number(new URL(listening.url ?? '').port);
  const base = `http://127.0.0.1:${port}`;

  async function api<T>(method: string, pathname: string, body?: unknown): Promise<ApiResponse<T>> {
    const response = await fetch(new URL(pathname, base), {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json: json as T };
  }

  async function ok<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const response = await api<T>(method, pathname, body);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `${method} ${pathname} answered ${response.status}: ${JSON.stringify(response.json)}`,
      );
    }
    return response.json;
  }

  const providers = async (): Promise<ProviderStatus[]> =>
    (await ok<{ providers: ProviderStatus[] }>('GET', '/api/providers')).providers;

  const detected = (): Promise<ProviderStatus[]> =>
    until('provider detection', async () => {
      const list = await providers();
      return list.every((status) => !status.instance.enabled || status.detection !== null)
        ? list
        : undefined;
    });

  let stopped: Promise<number[]> | undefined;

  async function stop(): Promise<number[]> {
    if (child.exitCode === null && child.signalCode === null) {
      // Windows cannot deliver SIGTERM; the server takes the same request over IPC.
      if (process.platform === 'win32') child.send('shutdown');
      else child.kill('SIGTERM');
      const code = await Promise.race([exited, sleep(15_000).then(() => 'timeout' as const)]);
      if (code === 'timeout') {
        child.kill('SIGKILL');
        await exited;
      }
    }
    // The server ends its children before it exits; the system may need a moment to reap them.
    let left = recordedProcesses(mockLog);
    let survivors = await runningProcesses(left);
    for (const deadline = Date.now() + 2000; survivors.length > 0 && Date.now() < deadline;) {
      await sleep(50);
      left = left.filter((process) => survivors.includes(process.pid));
      survivors = await runningProcesses(left);
    }
    for (const pid of survivors) killProcessTree(pid);
    await rm(registration, { force: true });
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return survivors;
  }

  return {
    base,
    port,
    token,
    api,

    async firstPairingCode() {
      const entry = await until('the first pairing code in the log', () =>
        entries.find((candidate) => /one-time code: \d{4} \d{4}/.test(candidate.msg ?? '')),
      );
      const match = /(\d{4}) (\d{4})/.exec(entry.msg ?? '');
      return `${match?.[1]}${match?.[2]}`;
    },

    async mintPairingCode() {
      return (await ok<{ code: string }>('POST', '/api/auth/pairing-codes')).code;
    },

    async pairCommand() {
      const pair = spawn(process.execPath, [SERVER_MAIN, 'pair', '--data-dir', dataDir], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      pair.stdout.setEncoding('utf8').on('data', (text: string) => (output += text));
      pair.stderr.setEncoding('utf8').on('data', (text: string) => (output += text));
      const [code] = (await once(pair, 'exit')) as [number | null];
      const match = /Pairing code: (\d{4}) (\d{4})/.exec(output);
      if (code !== 0 || !match) throw new Error(`"pair" failed with ${code}: ${output}`);
      return `${match[1]}${match[2]}`;
    },

    async setProviders(changes, endpoints = []) {
      const current = await ok<{ settings: { providers: ProviderInstance[] } }>(
        'GET',
        '/api/settings',
      );
      const kept = current.settings.providers
        .filter((instance) => !endpoints.some((endpoint) => endpoint.id === instance.id))
        .map((instance) => ({ ...instance, ...changes[instance.id as CliKind] }));
      await ok('PUT', '/api/settings', { providers: [...kept, ...endpoints] });
      await ok('POST', '/api/providers/refresh');
      await detected();
    },

    async setLimits(limits) {
      await ok('PUT', '/api/settings', { limits });
    },

    providers,
    detected,

    async putPreset(id, preset) {
      await ok('PUT', `/api/presets/${encodeURIComponent(id)}`, preset);
    },

    async ask(prompt, targets) {
      return (await ok<{ askId: string }>('POST', '/api/ask', { prompt, targets })).askId;
    },

    snapshot: (askId) => ok<AskSnapshot>('GET', `/api/ask/${encodeURIComponent(askId)}`),

    finished: (askId) =>
      until(
        `ask ${askId} to finish`,
        async () => {
          const snapshot = await ok<AskSnapshot>('GET', `/api/ask/${encodeURIComponent(askId)}`);
          return snapshot.status === 'done' ? snapshot : undefined;
        },
        30_000,
      ),

    mockInvocations: () => readMockLog(mockLog),
    liveMockPids: () => runningProcesses(recordedProcesses(mockLog)),
    logText: () => lines.join('\n'),
    stop: () => (stopped ??= stop()),
  };
}
