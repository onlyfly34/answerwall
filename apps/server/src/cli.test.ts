import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Agent, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BRAND } from '@answerwall/core';
import {
  API_PATHS,
  DevicesResponseSchema,
  MetaSchema,
  SessionResponseSchema,
} from '@answerwall/core/protocol';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, helpText, parseCommandLine, run } from './cli.ts';
import type { RunningServer, Runtime, Signal } from './cli.ts';
import { ConfigError, OPTIONS, serverVersion } from './config.ts';

const TOKEN = 'automation-token-0123456789';

interface TestRuntime extends Runtime {
  out: string[];
  err: string[];
  handlers: Map<Signal, () => void>;
  signal(signal: Signal): void;
}

function createRuntime(options: Partial<Runtime> = {}): TestRuntime {
  const out: string[] = [];
  const err: string[] = [];
  const handlers = new Map<Signal, () => void>();
  return {
    out,
    err,
    handlers,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdoutIsTty: false,
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
    signal: (signal) => handlers.get(signal)?.(),
    ...options,
  };
}

let directory: string;
let dataDir: string;
let webRoot: string;
let env: NodeJS.ProcessEnv;
const running: RunningServer[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), `${BRAND.slug}-cli-`));
  dataDir = join(directory, 'data');
  webRoot = join(directory, 'web');
  // Startup detection must find no real CLI on the machine running the tests.
  const emptyBin = join(directory, 'bin');
  await mkdir(emptyBin);
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>shell</title>');
  env = {
    PATH: emptyBin,
    [`${BRAND.envPrefix}DATA_DIR`]: dataDir,
    [`${BRAND.envPrefix}WEB_ROOT`]: webRoot,
    [`${BRAND.envPrefix}PORT`]: '0',
  };
});

afterEach(async () => {
  for (const server of running.splice(0)) {
    server.stop();
    await server.exited;
  }
  await rm(directory, { recursive: true, force: true });
});

/** Runs `serve` and resolves once it listens. `exit` settles when the command returns. */
async function start(
  runtime: TestRuntime,
  extraEnv: NodeJS.ProcessEnv = {},
  argv: string[] = [],
): Promise<{ server: RunningServer; exit: Promise<number> }> {
  let exit!: Promise<number>;
  const server = await new Promise<RunningServer>((resolve, reject) => {
    exit = run(argv, { ...env, ...extraEnv }, runtime, resolve);
    void exit.then((code) => reject(new Error(`exited with ${code}: ${runtime.err.join(' | ')}`)));
  });
  running.push(server);
  return { server, exit };
}

const logEntries = (runtime: TestRuntime) =>
  runtime.out.map((line) => JSON.parse(line) as Record<string, unknown> & { msg: string });

const browserPost = (url: string, path: string, body: unknown, cookie?: string) =>
  fetch(new URL(path, url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: new URL(url).origin,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A request with full control over its headers (`fetch` does not let `Host` be set). */
function rawRequest(
  url: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    ca?: string;
    agent?: Agent;
  } = {},
): Promise<RawResponse> {
  const target = new URL(path, url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = send(
      target,
      {
        method: options.method ?? (payload === undefined ? 'GET' : 'POST'),
        headers: {
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        agent: options.agent ?? false,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

const sessionCookie = (response: RawResponse): string => response.headers['set-cookie']?.[0] ?? '';

const cookieOf = (response: Response): string =>
  (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

describe('parseCommandLine', () => {
  test('serve is the default command', () => {
    expect(parseCommandLine([])).toEqual({ name: 'serve', overrides: {} });
    expect(parseCommandLine(['serve'])).toEqual({ name: 'serve', overrides: {} });
    expect(parseCommandLine(['pair'])).toEqual({ name: 'pair', overrides: {} });
  });

  test('every flag maps to its option', () => {
    const argv = OPTIONS.flatMap((option) => {
      if (!('flag' in option)) return [];
      return option.kind === 'switch'
        ? [`--${option.flag}`]
        : [`--${option.flag}`, `v-${option.name}`];
    });

    const command = parseCommandLine(['serve', ...argv]);

    expect(command).toEqual({
      name: 'serve',
      overrides: Object.fromEntries(
        OPTIONS.filter((option) => 'flag' in option).map((option) => [
          option.name,
          option.kind === 'switch' ? '1' : `v-${option.name}`,
        ]),
      ),
    });
  });

  test('flags may come before the command and use the = form', () => {
    expect(parseCommandLine(['--port=8080', 'pair', '--data-dir', 'd'])).toEqual({
      name: 'pair',
      overrides: { PORT: '8080', DATA_DIR: 'd' },
    });
  });

  test.each([['--help'], ['-h'], ['help'], ['pair', '--help']])('%j asks for help', (...argv) => {
    expect(parseCommandLine(argv)).toEqual({ name: 'help' });
  });

  test.each([['--version'], ['-v']])('%j asks for the version', (...argv) => {
    expect(parseCommandLine(argv)).toEqual({ name: 'version' });
  });

  test.each([
    [['start'], /Unknown command: start/],
    [['serve', 'now'], /Unknown command: serve now/],
    [['--no-auth'], /--no-auth/],
    [['--token', 'abc'], /--token/],
    [['--port'], /--port/],
  ] as const)('%j is refused', (argv, message) => {
    expect(() => parseCommandLine(argv)).toThrow(ConfigError);
    expect(() => parseCommandLine(argv)).toThrow(message);
  });
});

describe('help and version', () => {
  test('help lists every option with its flag and variable', async () => {
    const runtime = createRuntime();
    expect(await run(['--help'], {}, runtime)).toBe(EXIT_OK);

    const text = runtime.out.join('\n');
    expect(text).toBe(helpText());
    for (const option of OPTIONS) {
      expect(text).toContain(`${BRAND.envPrefix}${option.name}`);
      if ('flag' in option) expect(text).toContain(`--${option.flag}`);
    }
    expect(text).toContain(`${BRAND.cliName} pair`);
    expect(text).not.toContain('--token');
  });

  test('version prints the version, whatever the environment holds', async () => {
    const runtime = createRuntime();
    expect(await run(['--version'], { [`${BRAND.envPrefix}BOGUS`]: '1' }, runtime)).toBe(EXIT_OK);
    expect(runtime.out).toEqual([serverVersion()]);
  });
});

describe('refusing to start', () => {
  test.each([
    [
      'an unknown variable',
      { [`${BRAND.envPrefix}NO_AUTH`]: '1' },
      [],
      /Unknown setting: ANSWERWALL_NO_AUTH/,
    ],
    [
      'an unusable static token',
      { [`${BRAND.envPrefix}TOKEN`]: 'short' },
      [],
      /ANSWERWALL_TOKEN must be/,
    ],
    ['an invalid flag value', {}, ['--tls', 'maybe'], /ANSWERWALL_TLS must be one of/],
    ['an unknown flag', {}, ['--open'], /--open/],
  ] as const)(
    '%s is a usage error on stderr, with nothing started',
    async (_label, extra, argv, message) => {
      const runtime = createRuntime();

      const code = await run([...argv], { ...env, ...extra }, runtime);

      expect(code).toBe(EXIT_USAGE);
      expect(runtime.err[0]).toMatch(message);
      expect(runtime.err[0]).toMatch(new RegExp(`^${BRAND.cliName}: `));
      expect(runtime.err[1]).toContain('--help');
      expect(runtime.out).toEqual([]);
      expect(runtime.handlers.size).toBe(0);
      expect(runtime.err.join('\n')).not.toMatch(/\n\s+at /);
    },
  );

  test('certificate files that do not exist stop the start with a message, not a stack', async () => {
    const runtime = createRuntime();

    const code = await run(
      [
        '--tls',
        'cert',
        '--tls-cert',
        join(directory, 'no.crt'),
        '--tls-key',
        join(directory, 'no.key'),
      ],
      env,
      runtime,
    );

    expect(code).toBe(EXIT_FAILURE);
    expect(runtime.err).toEqual([
      `${BRAND.cliName}: The TLS certificate cannot be loaded: a file cannot be read (ENOENT)`,
    ]);
    expect(runtime.handlers.size).toBe(0);
  });

  describe('when the port is taken', () => {
    let blocker: Server;
    beforeEach(async () => {
      blocker = createNetServer();
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    });
    afterEach(async () => {
      await new Promise((resolve) => blocker.close(resolve));
    });

    test('says so and exits, and the data directory is free again', async () => {
      const { port } = blocker.address() as AddressInfo;
      const runtime = createRuntime();

      const code = await run(['--port', String(port)], env, runtime);

      expect(code).toBe(EXIT_FAILURE);
      expect(runtime.err).toEqual([
        `${BRAND.cliName}: Port ${port} on 127.0.0.1 is already in use`,
      ]);
      // A second start on a free port works: nothing was left holding the database.
      const { server } = await start(createRuntime());
      expect(server.port).toBeGreaterThan(0);
    });
  });
});

describe('serve', () => {
  test('starts on an ephemeral loopback port and serves the API and the UI', async () => {
    const runtime = createRuntime();
    const { server } = await start(runtime);

    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    const meta = await fetch(new URL(API_PATHS.meta, server.url));
    expect(MetaSchema.parse(await meta.json())).toMatchObject({
      name: BRAND.name,
      version: serverVersion(),
      mode: 'server',
      tls: 'off',
      authRequired: true,
    });
    expect(meta.headers.get('Content-Security-Policy')).toContain("default-src 'self'");

    const page = await fetch(new URL('/settings', server.url));
    expect(await page.text()).toContain('<title>shell</title>');
    expect(page.headers.get('Cache-Control')).toBe('no-cache');
  });

  test('being on loopback does not bypass authentication', async () => {
    const { server } = await start(createRuntime());
    for (const path of [
      API_PATHS.settings,
      API_PATHS.providers,
      API_PATHS.history,
      API_PATHS.authDevices,
    ]) {
      expect((await fetch(new URL(path, server.url))).status).toBe(401);
    }
  });

  test('a request under a foreign host name is refused, as DNS rebinding would send it', async () => {
    const { server } = await start(createRuntime());

    const rebound = await rawRequest(server.url, API_PATHS.meta, {
      headers: { Host: `evil.example:${server.port}` },
    });
    expect(rebound.status).toBe(403);
    expect(JSON.parse(rebound.body)).toMatchObject({ error: { code: 'forbidden' } });

    const local = await rawRequest(server.url, API_PATHS.meta, {
      headers: { Host: `localhost:${server.port}` },
    });
    expect(local.status).toBe(200);
  });

  test('a cross-site write is refused before it reaches a route', async () => {
    const { server } = await start(createRuntime(), { [`${BRAND.envPrefix}TOKEN`]: TOKEN });
    const response = await rawRequest(server.url, API_PATHS.authSession, {
      headers: { Origin: 'https://evil.example' },
      body: { token: TOKEN },
    });
    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBe('');
  });

  test('the banner shows the URL and the log never shows the token', async () => {
    const runtime = createRuntime();
    const { server } = await start(runtime, { [`${BRAND.envPrefix}TOKEN`]: TOKEN });

    const signedIn = await fetch(new URL(API_PATHS.authDevices, server.url), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(signedIn.status).toBe(200);
    await fetch(new URL(API_PATHS.authDevices, server.url), {
      headers: { Authorization: 'Bearer wrong-token-0123456789' },
    });

    const entries = logEntries(runtime);
    expect(entries.find((entry) => entry.msg.endsWith('is listening'))).toMatchObject({
      level: 'info',
      msg: `${BRAND.name} ${serverVersion()} is listening`,
      url: `http://localhost:${server.port}`,
      tls: 'off',
    });
    expect(entries.some((entry) => entry.msg.includes(`${BRAND.envPrefix}TOKEN`))).toBe(true);
    const everything = runtime.out.join('\n') + runtime.err.join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('wrong-token');
  });

  test('insecure mode is warned about in the log', async () => {
    const runtime = createRuntime();
    await start(runtime, {}, ['--host', '0.0.0.0', '--allow-insecure']);

    const warnings = logEntries(runtime).filter((entry) => entry['level'] === 'warn');
    expect(warnings.map((entry) => entry.msg)).toContainEqual(
      expect.stringMatching(/^INSECURE MODE/),
    );
  });

  test('the log is text on a terminal and follows the format option', async () => {
    const terminal = createRuntime({ stdoutIsTty: true });
    await start(terminal);
    expect(
      terminal.out.some((line) => /^\S+ INFO {2}AnswerWall .* is listening url=http/.test(line)),
    ).toBe(true);

    const forced = createRuntime({ stdoutIsTty: true });
    await start(forced, {}, ['--log-format', 'json', '--data-dir', join(directory, 'other')]);
    expect(() => logEntries(forced)).not.toThrow();
  });

  describe('secure cookies', () => {
    const origin = 'https://wall.example.com';
    const proxied = (code: string, headers: Record<string, string>) => ({
      headers: { Host: 'wall.example.com', Origin: origin, ...headers },
      body: { code, deviceName: 'Browser' },
    });
    const freshCode = async (): Promise<string> => {
      const runtime = createRuntime();
      await run(['pair'], env, runtime);
      return (runtime.out[0] ?? '').replace('Pairing code: ', '');
    };

    test('behind a trusted proxy that reports https the cookie is Secure', async () => {
      const { server } = await start(createRuntime(), {}, [
        '--public-origins',
        origin,
        '--trusted-proxies',
        '127.0.0.1',
      ]);

      const response = await rawRequest(
        server.url,
        API_PATHS.authPair,
        proxied(await freshCode(), {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-For': '203.0.113.7',
        }),
      );

      expect(response.status).toBe(200);
      expect(sessionCookie(response)).toMatch(/; HttpOnly; Secure; SameSite=Strict$/);
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    });

    test('the same headers from a peer that is not a trusted proxy are ignored', async () => {
      const { server } = await start(createRuntime(), {}, ['--public-origins', origin]);

      const response = await rawRequest(
        server.url,
        API_PATHS.authPair,
        proxied(await freshCode(), {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-For': '203.0.113.7',
        }),
      );

      expect(response.status).toBe(200);
      expect(sessionCookie(response)).toContain('HttpOnly');
      expect(sessionCookie(response)).not.toContain('Secure');
      expect(response.headers['strict-transport-security']).toBeUndefined();
    });

    test('with generated certificates the server speaks HTTPS that validates against its CA', async () => {
      const runtime = createRuntime();
      const { server } = await start(runtime, {}, [
        '--tls',
        'auto',
        '--tls-hostnames',
        'nas.local',
      ]);
      expect(server.url).toBe(`https://127.0.0.1:${server.port}`);
      const ca = await readFile(join(dataDir, 'tls', 'ca.crt'), 'utf8');
      const local = `https://localhost:${server.port}`;

      const meta = await rawRequest(local, API_PATHS.meta, { ca });
      expect(JSON.parse(meta.body)).toMatchObject({ tls: 'auto' });
      // Without the CA the certificate is not trusted.
      await expect(rawRequest(local, API_PATHS.meta)).rejects.toThrow();

      const paired = await rawRequest(local, API_PATHS.authPair, {
        ca,
        headers: { Origin: local },
        body: { code: await freshCode(), deviceName: 'Browser' },
      });
      expect(paired.status).toBe(200);
      expect(sessionCookie(paired)).toMatch(/; HttpOnly; Secure; SameSite=Strict$/);
      // The private keys are in the secret store, not next to the certificates.
      expect(runtime.out.join('\n')).not.toContain('PRIVATE KEY');
    });
  });

  describe('first device', () => {
    const announcedCode = (runtime: TestRuntime): string =>
      /one-time code: (\d{4} \d{4})/.exec(runtime.out.join('\n'))?.[1] ?? '';

    test('the code printed at start pairs a browser, whose cookie then works', async () => {
      const runtime = createRuntime();
      const { server } = await start(runtime);
      const code = announcedCode(runtime);
      expect(code).toMatch(/^\d{4} \d{4}$/);

      const paired = await browserPost(server.url, API_PATHS.authPair, {
        code,
        deviceName: 'Laptop',
      });

      expect(paired.status).toBe(200);
      const setCookie = paired.headers.get('Set-Cookie') ?? '';
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).not.toContain('Secure');
      const { device } = SessionResponseSchema.parse(await paired.json());
      expect(device).toMatchObject({ name: 'Laptop', current: true });

      const devices = await fetch(new URL(API_PATHS.authDevices, server.url), {
        headers: { Cookie: cookieOf(paired) },
      });
      expect(DevicesResponseSchema.parse(await devices.json()).devices).toHaveLength(1);

      // Single use.
      const again = await browserPost(server.url, API_PATHS.authPair, {
        code,
        deviceName: 'Other',
      });
      expect(again.status).toBe(401);
      // The token is in the cookie only.
      expect(runtime.out.join('\n')).not.toContain(cookieOf(paired).split('=')[1]);
    });

    test('a restart with a paired device announces no code', async () => {
      const first = createRuntime();
      const { server, exit } = await start(first);
      await browserPost(server.url, API_PATHS.authPair, {
        code: announcedCode(first),
        deviceName: 'Laptop',
      });
      first.signal('SIGTERM');
      expect(await exit).toBe(EXIT_OK);

      const second = createRuntime();
      await start(second);
      expect(announcedCode(second)).toBe('');
    });
  });

  describe('shutdown', () => {
    test.each(['SIGINT', 'SIGTERM'] as const)(
      '%s stops the server and exits with 0',
      async (signal) => {
        const runtime = createRuntime();
        const { server, exit } = await start(runtime);
        expect([...runtime.handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);

        runtime.signal(signal);

        expect(await exit).toBe(EXIT_OK);
        expect(runtime.handlers.size).toBe(0);
        await expect(fetch(new URL(API_PATHS.meta, server.url))).rejects.toThrow();
        const messages = logEntries(runtime).map((entry) => entry.msg);
        expect(messages.slice(-2)).toEqual(['shutting down', 'stopped']);
        expect(logEntries(runtime).at(-2)).toMatchObject({ signal });
      },
    );

    test('a connection that is kept open does not hold the shutdown up', async () => {
      const runtime = createRuntime();
      const { server, exit } = await start(runtime);
      const agent = new Agent({ keepAlive: true });
      try {
        expect((await rawRequest(server.url, API_PATHS.meta, { agent })).status).toBe(200);

        runtime.signal('SIGINT');

        expect(await exit).toBe(EXIT_OK);
      } finally {
        agent.destroy();
      }
    });

    test('a second signal ends the wait at once', async () => {
      const runtime = createRuntime();
      const { exit } = await start(runtime);

      runtime.signal('SIGINT');
      runtime.signal('SIGINT');

      expect(await exit).toBe(EXIT_FAILURE);
      expect(logEntries(runtime).map((entry) => entry.msg)).toContainEqual(
        expect.stringContaining('second signal'),
      );
      // Let the shutdown that is under way finish before the directory is removed.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  });
});

describe('pair', () => {
  const printedCode = (runtime: TestRuntime): string =>
    /^Pairing code: (\d{4} \d{4})$/.exec(runtime.out[0] ?? '')?.[1] ?? '';

  test('prints a code that the running server accepts', async () => {
    const serverRuntime = createRuntime();
    const { server } = await start(serverRuntime);

    const pairRuntime = createRuntime();
    expect(await run(['pair'], env, pairRuntime)).toBe(EXIT_OK);

    const code = printedCode(pairRuntime);
    expect(code).not.toBe('');
    expect(pairRuntime.out[1]).toMatch(/^Valid for 5 minutes and for one device\./);
    expect(pairRuntime.err).toEqual([]);

    const paired = await browserPost(server.url, API_PATHS.authPair, { code, deviceName: 'Phone' });
    expect(paired.status).toBe(200);
    // The server never saw the code before the browser sent it, and does not log it.
    expect(serverRuntime.out.join('\n')).not.toContain(code);
    expect(serverRuntime.out.join('\n')).not.toContain(code.replace(' ', ''));
  });

  test('each call prints a different code and all of them stay usable', async () => {
    const { server } = await start(createRuntime());
    const first = createRuntime();
    const second = createRuntime();
    await run(['pair'], env, first);
    await run(['pair'], env, second);

    expect(printedCode(first)).not.toBe(printedCode(second));
    for (const [index, runtime] of [first, second].entries()) {
      const response = await browserPost(server.url, API_PATHS.authPair, {
        code: printedCode(runtime),
        deviceName: `Device ${index}`,
      });
      expect(response.status).toBe(200);
    }
  });

  test('uses the data directory given on the command line', async () => {
    const elsewhere = join(directory, 'elsewhere');
    const { server } = await start(createRuntime(), {}, ['--data-dir', elsewhere]);

    const wrongDir = createRuntime();
    await run(['pair'], env, wrongDir);
    const rightDir = createRuntime();
    await run(['pair', '--data-dir', elsewhere], env, rightDir);

    const post = (runtime: TestRuntime) =>
      browserPost(server.url, API_PATHS.authPair, {
        code: printedCode(runtime),
        deviceName: 'Phone',
      });
    expect((await post(wrongDir)).status).toBe(401);
    expect((await post(rightDir)).status).toBe(200);
  });

  test('a configuration error is reported like for serve', async () => {
    const runtime = createRuntime();
    const code = await run(['pair'], { ...env, [`${BRAND.envPrefix}PORT`]: 'x' }, runtime);
    expect(code).toBe(EXIT_USAGE);
    expect(runtime.out).toEqual([]);
  });
});
