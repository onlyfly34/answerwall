#!/usr/bin/env node
// End-to-end smoke test of the compiled server against the mock CLIs.
//
// Starts `apps/server/dist/main.js` on an ephemeral loopback port with a
// temporary data directory and a PATH that holds only the mock CLIs and
// Node, plus a local OpenAI-compatible stub endpoint. Nothing inside the
// server is faked and nothing leaves the machine. Exits non-zero on the
// first failed check.
//
// Run `pnpm build` first (`pnpm smoke:mock` does both).

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_MAIN = path.join(ROOT, 'apps', 'server', 'dist', 'main.js');
const PROTOCOL = path.join(ROOT, 'packages', 'core', 'dist', 'protocol', 'index.js');
const WEB_INDEX = path.join(ROOT, 'packages', 'web', 'dist', 'index.html');
const MOCK_BIN = path.join(ROOT, 'tools', 'mock-clis', 'bin');
const MOCK_KINDS = ['claude', 'codex', 'agy', 'grok'];

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";
const STUB_KEY = 'stub-key-0123456789abcdef';
const STUB_MODEL = 'stub-model';
const PROMPT = 'Smoke test zebracorn: what is two plus two?';

// ---------------------------------------------------------------- helpers

let step = 0;
function log(message) {
  process.stdout.write(`[smoke] ${message}\n`);
}
function check(condition, message, detail) {
  step += 1;
  if (!condition) {
    const extra = detail === undefined ? '' : `\n  ${JSON.stringify(detail, null, 2)}`;
    throw new Error(`check ${step} failed: ${message}${extra}`);
  }
  log(`ok ${step} - ${message}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, condition, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  try {
    const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return status.slice(status.lastIndexOf(')') + 2, status.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/** A GET with headers that fetch() does not let a caller set, such as Host. */
function rawStatus(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Every process id the mock CLIs recorded: their own and their children's. */
function mockPids(logFile) {
  const pids = new Set();
  let text;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return pids;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line);
    if (entry.pid) pids.add(entry.pid);
    if (entry.grandchildPid) pids.add(entry.grandchildPid);
  }
  return pids;
}

// ---------------------------------------------------- OpenAI-compatible stub

/** Answers `/v1/models` and streamed `/v1/chat/completions`, slowly, behind a bearer key. */
async function startStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const authorized = req.headers.authorization === `Bearer ${STUB_KEY}`;
      requests.push({ method: req.method, url: req.url, authorized });
      if (!authorized) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: STUB_MODEL, object: 'model' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const request = JSON.parse(body);
        const prompt = request.messages?.at(-1)?.content ?? '';
        const words = ['Stub', ' answer', ' for', ` ${prompt.length}`, ' characters.'];
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        let index = 0;
        const timer = setInterval(() => {
          if (index === 0)
            chunk({ choices: [{ index: 0, delta: { reasoning_content: 'Count.' } }] });
          if (index < words.length) {
            chunk({ choices: [{ index: 0, delta: { content: words[index] } }] });
            index += 1;
            return;
          }
          clearInterval(timer);
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          chunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 5 } });
          res.end('data: [DONE]\n\n');
        }, 60);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    expectedText: `Stub answer for ${PROMPT.length} characters.`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------- server

/** Starts the compiled server and waits for its "is listening" log line. */
async function startServer({ dataDir, env }) {
  const child = spawn(
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
  const entries = [];
  const stderr = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        entries.push(JSON.parse(line));
      } catch {
        entries.push({ msg: line, level: 'raw' });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => stderr.push(text));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  const listening = await Promise.race([
    until('the server to listen', () => entries.find((e) => /is listening/.test(e.msg ?? ''))),
    exited.then((code) => {
      throw new Error(`server exited with ${code} before listening: ${stderr.join('')}`);
    }),
  ]);
  const port = Number(new URL(listening.url).port);
  return {
    child,
    entries,
    stderr,
    exited,
    port,
    base: `http://127.0.0.1:${port}`,
    /**
     * Graceful stop: SIGTERM, or the IPC message that stands in for it (the
     * only way on Windows).
     */
    stopping: false,
    stop(how = process.platform === 'win32' ? 'ipc' : 'signal') {
      // A second request would cut the server's shutdown short.
      if (this.stopping) return;
      this.stopping = true;
      if (how === 'ipc') child.send('shutdown');
      else child.kill('SIGTERM');
    },
  };
}

// ---------------------------------------------------------------- client

function createClient(base) {
  let cookie;
  const origin = base;
  async function request(method, pathname, body, options = {}) {
    const headers = { accept: 'application/json', ...options.headers };
    if (cookie && options.auth !== false) headers.cookie = cookie;
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      if (headers.origin === undefined) headers.origin = origin;
    }
    const response = await fetch(new URL(pathname, base), {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie && options.keepCookie !== false) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let json;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, json, text, setCookie };
  }
  return {
    request,
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b, o),
    put: (p, b, o) => request('PUT', p, b, o),
    del: (p, o) => request('DELETE', p, {}, o),
    get cookie() {
      return cookie;
    },
  };
}

/**
 * Reads an SSE stream. `onEvent` returns true to stop reading (the
 * connection is then closed by the client). Resolves with the events, the
 * response headers and whether the server closed the stream.
 */
async function readStream(base, pathname, cookie, onEvent = () => false) {
  const controller = new AbortController();
  const response = await fetch(new URL(pathname, base), {
    headers: { cookie, accept: 'text/event-stream', 'accept-encoding': 'gzip, br' },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    throw new Error(`stream ${pathname} answered ${response.status}: ${await response.text()}`);
  }
  const events = [];
  const ids = [];
  const decoder = new TextDecoder();
  let buffer = '';
  let closedByServer = true;
  try {
    outer: for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id;
        let type;
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id') id = value;
          else if (field === 'event') type = value;
          else if (field === 'data') data.push(value);
        }
        if (data.length === 0) continue;
        const event = JSON.parse(data.join('\n'));
        if (type !== undefined && type !== event.type) {
          throw new Error(`SSE event name ${type} does not match payload type ${event.type}`);
        }
        ids.push(id);
        events.push(event);
        if (onEvent(event, events)) {
          closedByServer = false;
          controller.abort();
          break outer;
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    closedByServer = false;
  }
  return { events, ids, headers: response.headers, closedByServer };
}

// ---------------------------------------------------------------- the run

async function main() {
  for (const file of [SERVER_MAIN, PROTOCOL, WEB_INDEX]) {
    if (!existsSync(file))
      throw new Error(`${path.relative(ROOT, file)} is missing: run pnpm build`);
  }
  const protocol = await import(pathToFileURL(PROTOCOL).href);
  const { API_PATHS, applyStreamEvent, isTerminalStreamEvent } = protocol;

  const temp = await mkdtemp(path.join(os.tmpdir(), 'answerwall-smoke-'));
  const dataDir = path.join(temp, 'data');
  const home = path.join(temp, 'home');
  const nodeDir = path.join(temp, 'node-bin');
  const mockLog = path.join(temp, 'mock-invocations.jsonl');
  await mkdir(dataDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(nodeDir, { recursive: true });

  // PATH holds the mock CLIs and Node, nothing else: the directory Node is
  // installed in may also hold real CLIs, which must never be started here.
  let nodePathEntry = nodeDir;
  if (process.platform === 'win32') {
    nodePathEntry = path.dirname(process.execPath);
    for (const kind of MOCK_KINDS) {
      if (existsSync(path.join(nodePathEntry, `${kind}.cmd`))) {
        throw new Error(
          `a real ${kind} sits next to node.exe; run the smoke test with another Node`,
        );
      }
    }
  } else {
    await symlink(process.execPath, path.join(nodeDir, 'node'));
    for (const kind of MOCK_KINDS) {
      const launcher = path.join(MOCK_BIN, kind);
      if (((await stat(launcher)).mode & 0o111) === 0) await chmod(launcher, 0o755);
    }
  }

  const inherited = Object.fromEntries(
    ['SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'ComSpec', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].flatMap(
      (name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]),
    ),
  );
  const env = {
    ...inherited,
    PATH: [MOCK_BIN, nodePathEntry].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    MOCK_CLI_LOG: mockLog,
    MOCK_CLI_DELAY_MS: '60',
  };

  const stub = await startStub();
  let server;
  let cleaning;
  // Idempotent: a signal handler and the `finally` below can both call it.
  const cleanup = () => (cleaning ??= cleanUp());
  const cleanUp = async () => {
    if (server && server.child.exitCode === null && server.child.signalCode === null) {
      // After a failed check the server may still have children: let it end
      // them itself, and only then force it.
      server.stop();
      const code = await Promise.race([server.exited, sleep(15_000).then(() => 'timeout')]);
      if (code === 'timeout') {
        server.child.kill('SIGKILL');
        await server.exited;
      }
    }
    // Whatever survived anyway (a forced stop leaves children behind) is ended here.
    for (const pid of mockPids(mockLog)) {
      if (!isAlive(pid)) continue;
      log(`ending leftover CLI process ${pid}`);
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(pid)]);
        else process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone in the meantime.
        }
      }
    }
    await stub.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  // Interrupted (Ctrl-C, a CI timeout, `kill`): stop the server and every CLI
  // it started, remove the temporary directory, then exit. If this process is
  // killed outright, the server sees its IPC channel close and shuts down.
  for (const signal of process.platform === 'win32'
    ? ['SIGINT', 'SIGBREAK', 'SIGHUP']
    : ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (cleaning) return;
      log(`${signal} received: cleaning up`);
      void cleanup().finally(() => process.exit(128 + (os.constants.signals[signal] ?? 1)));
    });
  }

  try {
    server = await startServer({ dataDir, env });
    log(`server listening on ${server.base}`);
    const api = createClient(server.base);

    // -------------------------------------------------------- meta, auth
    const meta = await api.get(API_PATHS.meta);
    check(
      meta.status === 200 && meta.json.authRequired === true,
      'meta is public and says auth is required',
      meta.json,
    );
    check(
      meta.json.version ===
        JSON.parse(readFileSync(path.join(ROOT, 'apps/server/package.json'), 'utf8')).version,
      'meta reports the server version',
    );

    const unauthenticated = await api.get(API_PATHS.providers);
    check(
      unauthenticated.status === 401 && unauthenticated.json?.error?.code === 'unauthorized',
      'API refuses a request without credentials',
    );

    const bootstrap = await until('the first-device pairing code in the log', () =>
      server.entries.find((e) => /one-time code: \d{4} \d{4}/.test(e.msg ?? '')),
    );
    const firstCode = /(\d{4}) (\d{4})/.exec(bootstrap.msg).slice(1).join('');
    check(
      !server.entries.some((e) => e !== bootstrap && JSON.stringify(e).includes(firstCode)),
      'the pairing code appears only in the bootstrap line of the log',
    );

    const wrong = await api.post(API_PATHS.authPair, {
      code: firstCode === '00000000' ? '11111111' : '00000000',
      deviceName: 'smoke',
    });
    check(wrong.status === 401, 'a wrong pairing code is refused');

    const paired = await api.post(API_PATHS.authPair, {
      code: firstCode,
      deviceName: 'smoke phone',
    });
    check(
      paired.status === 200 && paired.json.device?.name === 'smoke phone',
      'pairing with the logged code creates a device',
      paired.json,
    );
    check(
      /HttpOnly/i.test(paired.setCookie) &&
        /SameSite=Strict/i.test(paired.setCookie) &&
        !/Secure/i.test(paired.setCookie),
      'session cookie is HttpOnly, SameSite=Strict, not Secure over plain HTTP',
      paired.setCookie,
    );
    const reused = await createClient(server.base).post(API_PATHS.authPair, {
      code: firstCode,
      deviceName: 'again',
    });
    check(reused.status === 401, 'a pairing code works only once');

    const crossSite = await api.post(
      API_PATHS.authPairingCodes,
      {},
      { headers: { origin: 'https://evil.example' } },
    );
    check(
      crossSite.status === 403,
      'a non-GET request from a foreign Origin is refused even with a valid cookie',
    );
    const badHost = await rawStatus(server.port, API_PATHS.meta, { host: 'evil.example' });
    check(badHost === 403, `a request with a foreign Host is refused (${badHost})`);

    // A second device through the API, a third through `answerwall pair`.
    const minted = await api.post(API_PATHS.authPairingCodes, {});
    check(
      minted.status === 200 && /^\d{8}$/.test(minted.json.code),
      'a signed-in device mints a pairing code',
    );
    const tablet = createClient(server.base);
    const tabletPair = await tablet.post(API_PATHS.authPair, {
      code: minted.json.code,
      deviceName: 'smoke tablet',
    });
    check(tabletPair.status === 200, 'a second device pairs with the minted code');

    const pairCli = spawn(process.execPath, [SERVER_MAIN, 'pair', '--data-dir', dataDir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pairOut = '';
    pairCli.stdout.setEncoding('utf8').on('data', (t) => (pairOut += t));
    const [pairExit] = await once(pairCli, 'exit');
    const cliCode = /Pairing code: (\d{4}) (\d{4})/.exec(pairOut);
    check(
      pairExit === 0 && cliCode !== null,
      '`answerwall pair` prints a code while the server runs',
    );
    const laptop = createClient(server.base);
    check(
      (
        await laptop.post(API_PATHS.authPair, {
          code: cliCode[1] + cliCode[2],
          deviceName: 'smoke laptop',
        })
      ).status === 200,
      'a third device pairs with the code from `answerwall pair`',
    );

    const devices = await api.get(API_PATHS.authDevices);
    check(
      devices.status === 200 &&
        devices.json.devices.length === 3 &&
        devices.json.devices.filter((d) => d.current).length === 1,
      'three devices are listed, one marked current',
      devices.json,
    );
    const laptopId = devices.json.devices.find((d) => d.name === 'smoke laptop').id;
    check((await api.del(API_PATHS.authDevice(laptopId))).status < 300, 'a device is revoked');
    check(
      (await laptop.get(API_PATHS.providers)).status === 401,
      'the revoked device is signed out',
    );
    check(
      (await tablet.post(API_PATHS.authLogout, {})).status < 300 &&
        (await tablet.get(API_PATHS.providers)).status === 401,
      'logout ends the session',
    );

    // ---------------------------------------------------------- providers
    const settingsBefore = await api.get(API_PATHS.settings);
    check(settingsBefore.status === 200, 'settings are readable');
    const cli = (kind, patch) => {
      const current = settingsBefore.json.settings.providers.find((p) => p.id === kind);
      return { ...current, ...patch };
    };
    const providersPatch = [
      cli('claude', { enabled: true, concurrency: 2 }),
      cli('codex', { enabled: true, concurrency: 1 }),
      cli('grok', { enabled: true, concurrency: 1 }),
      cli('agy', { enabled: true, concurrency: 1, riskAcknowledged: true }),
      {
        id: 'stub',
        kind: 'openai-compat',
        label: 'Local stub',
        enabled: true,
        concurrency: 1,
        models: [STUB_MODEL],
        defaultModel: STUB_MODEL,
        baseUrl: stub.url,
        apiKey: STUB_KEY,
      },
    ];
    const saved = await api.put(API_PATHS.settings, {
      providers: providersPatch,
      limits: { slotTimeoutMs: 60_000 },
    });
    check(saved.status === 200, 'providers and limits are saved', saved.json);
    check(!saved.text.includes(STUB_KEY), 'the settings response never contains the API key');
    const stubInstance = saved.json.settings.providers.find((p) => p.id === 'stub');
    check(
      stubInstance?.hasApiKey === true && !('apiKey' in stubInstance),
      'the endpoint reports hasApiKey only',
      stubInstance,
    );

    const refreshed = await api.post(API_PATHS.providersRefresh, {});
    check(refreshed.status === 200, 'provider refresh runs', refreshed.json);
    const providers = await until('provider detection', async () => {
      const response = await api.get(API_PATHS.providers);
      const list = response.json.providers;
      return list.every((p) => !p.instance.enabled || p.detection !== null) ? list : undefined;
    });
    for (const kind of MOCK_KINDS) {
      const status = providers.find((p) => p.instance.id === kind);
      check(
        status.detection?.installed === true,
        `${kind} is detected as installed (the mock)`,
        status.detection,
      );
    }
    const stubStatus = providers.find((p) => p.instance.id === 'stub');
    check(
      stubStatus.models.some((m) => m.id === STUB_MODEL),
      'the endpoint lists its models',
      stubStatus,
    );
    check(
      !JSON.stringify(providers).includes(STUB_KEY),
      'the providers response never contains the API key',
    );

    // ---------------------------------------------------------------- ask
    const targets = [
      { slotId: 'c1', providerId: 'claude', model: 'mock-hang' },
      { slotId: 'c2', providerId: 'claude', model: 'mock-slow' },
      { slotId: 'c3', providerId: 'claude', model: 'mock-reasoning' },
      { slotId: 'c4', providerId: 'claude', model: 'mock-block' },
      { slotId: 'x1', providerId: 'codex', model: 'mock-slow' },
      { slotId: 'x2', providerId: 'codex', model: 'mock-incremental' },
      { slotId: 'x3', providerId: 'codex', model: 'mock-quota' },
      { slotId: 'g1', providerId: 'grok', model: 'mock-slow' },
      { slotId: 'g2', providerId: 'grok', model: 'mock-echo' },
      { slotId: 'a1', providerId: 'agy', model: 'mock-slow' },
      { slotId: 'a2', providerId: 'agy', model: 'mock-slow' },
      { slotId: 'o1', providerId: 'stub' },
      { slotId: 'o2', providerId: 'stub', model: STUB_MODEL },
      { slotId: 'o3', providerId: 'stub', model: STUB_MODEL },
    ];
    const concurrency = { claude: 2, codex: 1, grok: 1, agy: 1, stub: 1 };
    const submitted = await api.post(API_PATHS.ask, { prompt: PROMPT, targets });
    check(
      submitted.status === 200 && typeof submitted.json.askId === 'string',
      `an ask with ${targets.length} slots is accepted`,
      submitted.json,
    );
    const askId = submitted.json.askId;

    // Cancel a slot while it is still queued (agy runs one at a time).
    const cancelQueued = await api.post(API_PATHS.askCancel(askId), { slotId: 'a2' });
    check(
      cancelQueued.status === 200 && isDeepStrictEqual(cancelQueued.json.cancelled, ['a2']),
      'a queued slot is cancelled',
      cancelQueued.json,
    );

    const base = await api.get(API_PATHS.askSnapshot(askId));
    check(
      base.status === 200 && base.json.slots.length === targets.length,
      'the snapshot lists every slot in request order',
    );
    check(
      isDeepStrictEqual(
        base.json.slots.map((s) => s.slotId),
        targets.map((t) => t.slotId),
      ),
      'snapshot slots keep the request order',
    );
    check(
      base.json.slots.find((s) => s.slotId === 'o1').model === STUB_MODEL,
      'a target without a model gets the default model',
    );

    // First connection: read part of the stream, then drop it.
    const first = await readStream(
      server.base,
      API_PATHS.askStream(askId),
      api.cookie,
      (event, all) =>
        all.filter((e) => e.type === 'delta').length >= 6 &&
        all.some((e) => e.type === 'start' && e.slotId === 'c1'),
    );
    check(
      !first.closedByServer && first.events.length > 0,
      `first connection read ${first.events.length} events and disconnected mid-stream`,
    );
    check(
      first.headers.get('content-type')?.startsWith('text/event-stream'),
      'stream content type is text/event-stream',
    );
    check(
      first.headers.get('cache-control') === 'no-store',
      'stream sends Cache-Control: no-store',
    );
    check(first.headers.get('x-accel-buffering') === 'no', 'stream sends X-Accel-Buffering: no');
    check(
      first.headers.get('content-encoding') === null,
      'stream is not compressed even when the client accepts gzip',
    );
    check(
      first.events[0].seq === 1 && first.events.every((e, i) => e.seq === i + 1),
      'a stream from the start replays every seq from 1, in order',
    );
    check(
      first.ids.every((id, i) => Number(id) === first.events[i].seq),
      'every SSE message carries id: <seq>',
    );

    // Disconnecting cancelled nothing. Cancel the hanging slot while it runs.
    const cancelRunning = await api.post(API_PATHS.askCancel(askId), { slotId: 'c1' });
    check(
      cancelRunning.status === 200 && isDeepStrictEqual(cancelRunning.json.cancelled, ['c1']),
      'a running slot is cancelled',
      cancelRunning.json,
    );

    const lastSeq = first.events.at(-1).seq;
    const second = await readStream(server.base, API_PATHS.askStream(askId, lastSeq), api.cookie);
    check(second.closedByServer, 'the resumed stream is closed by the server');
    check(
      second.events[0]?.seq === lastSeq + 1 && second.events[0].type !== 'snapshot',
      `resuming with ?after=${lastSeq} continues at seq ${lastSeq + 1}`,
      second.events[0],
    );
    check(
      second.events.every((e, i) => e.seq === lastSeq + 1 + i),
      'the resumed stream has no gap and no duplicate',
    );
    const last = second.events.at(-1);
    check(last.type === 'ask_done' && isTerminalStreamEvent(last), 'the stream ends with ask_done');
    check(second.events.filter((e) => e.type === 'ask_done').length === 1, 'exactly one ask_done');

    const all = [...first.events, ...second.events];
    let folded = base.json;
    for (const event of all) if (event.seq > folded.seq) folded = applyStreamEvent(folded, event);
    const final = await api.get(API_PATHS.askSnapshot(askId));
    check(final.json.status === 'done', 'the ask is done');
    check(
      isDeepStrictEqual(folded, final.json),
      'folding the streamed events gives exactly the server snapshot',
    );

    // One terminal event per slot.
    const terminalTypes = new Set(['done', 'error', 'cancelled', 'timeout']);
    for (const target of targets) {
      const ends = all.filter((e) => e.slotId === target.slotId && terminalTypes.has(e.type));
      check(
        ends.length === 1,
        `slot ${target.slotId} has exactly one terminal event (${ends[0]?.type})`,
      );
    }

    // Concurrency limits were respected and forced queueing.
    const running = {};
    const peak = {};
    const providerOf = Object.fromEntries(targets.map((t) => [t.slotId, t.providerId]));
    for (const event of all) {
      const provider = providerOf[event.slotId];
      if (event.type === 'start') {
        running[provider] = (running[provider] ?? 0) + 1;
        peak[provider] = Math.max(peak[provider] ?? 0, running[provider]);
      } else if (
        terminalTypes.has(event.type) &&
        all.some((e) => e.type === 'start' && e.slotId === event.slotId)
      ) {
        running[provider] -= 1;
      }
    }
    check(
      Object.entries(concurrency).every(([p, limit]) => (peak[p] ?? 0) === limit),
      'each provider ran exactly up to its concurrency limit, never above',
      peak,
    );

    const slot = (id) => final.json.slots.find((s) => s.slotId === id);
    for (const id of ['c2', 'c3', 'c4', 'x1', 'x2', 'g1', 'g2', 'a1', 'o1', 'o2', 'o3']) {
      check(
        slot(id).status === 'done' && slot(id).text.length > 0,
        `slot ${id} finished with an answer`,
        slot(id),
      );
    }
    check(
      slot('c1').status === 'cancelled' && slot('a2').status === 'cancelled',
      'cancelled slots stay cancelled',
    );
    check(
      !all.some((e) => e.type === 'start' && e.slotId === 'a2'),
      'the slot cancelled while queued never started',
    );
    check(
      slot('x3').status === 'error' && slot('x3').error.code === 'quota',
      'a provider failure is a typed slot error',
      slot('x3'),
    );
    check(slot('c3').reasoning.length > 0, 'reasoning is streamed separately from the answer');
    check(
      slot('x1').streaming === 'block' && slot('c2').streaming === 'token',
      'codex is reported as block streaming, claude as token streaming',
    );
    check(
      slot('g2').text.includes(PROMPT),
      'the prompt reached grok intact through its prompt file',
    );
    for (const id of ['o1', 'o2', 'o3']) {
      check(
        slot(id).text === stub.expectedText && slot(id).reasoning === 'Count.',
        `endpoint slot ${id} has the stub's answer and reasoning`,
      );
    }
    check(
      slot('o1').usage?.inputTokens === 9 && slot('o1').usage?.outputTokens === 5,
      'endpoint usage is reported',
      slot('o1').usage,
    );
    check(
      stub.requests.length > 0 && stub.requests.every((r) => r.authorized),
      'every request to the endpoint carried the configured key',
    );

    const invocations = readFileSync(mockLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const runs = invocations.filter((i) => i.prompt !== undefined && i.prompt !== null);
    check(
      runs.length > 0 && runs.every((i) => !i.argv.some((arg) => arg.includes('zebracorn'))),
      'the prompt never appears in any argv',
    );
    check(
      runs.every(
        (i) =>
          !i.envNames.includes('OPENAI_API_KEY') &&
          !i.envNames.some((n) => n.startsWith('CLAUDE_CODE_')),
      ),
      'children start without billing or nested-session variables',
    );
    const workDirs = await readdir(path.join(dataDir, 'work')).catch(() => []);
    check(workDirs.length === 0, 'every per-slot work dir was removed', workDirs);

    // A done ask: a resume at its end gets one done snapshot.
    const replay = await readStream(server.base, API_PATHS.askStream(askId, last.seq), api.cookie);
    check(
      replay.events.length === 1 &&
        replay.events[0].type === 'snapshot' &&
        replay.events[0].snapshot.status === 'done',
      'resuming a finished ask at its end gives a single done snapshot',
    );
    const full = await readStream(server.base, API_PATHS.askStream(askId), api.cookie);
    check(
      full.events.length === all.length && full.events.at(-1).type === 'ask_done',
      'a finished ask in memory replays its whole log',
    );

    // ------------------------------------------------- history, presets, settings
    const history = await api.get(`${API_PATHS.history}?q=zebracorn`);
    check(
      history.status === 200 &&
        history.json.items.length === 1 &&
        history.json.items[0].askId === askId,
      'history search finds the ask',
      history.json,
    );
    check(!history.text.includes(stub.expectedText), 'history list rows carry no answer bodies');
    const answerSearch = await api.get(
      `${API_PATHS.history}?q=${encodeURIComponent('Stub answer')}`,
    );
    check(answerSearch.json.items.length === 1, 'history search also matches answer text');
    const entry = await api.get(API_PATHS.historyEntry(askId));
    check(
      entry.status === 200 && isDeepStrictEqual(entry.json, final.json),
      'the history entry equals the final snapshot',
    );

    const presetId = 'smoke-preset';
    const presetBody = {
      name: 'Smoke preset',
      slots: targets.slice(1, 4),
      layout: { mode: 'fixed', minCellWidth: 300, columns: 2 },
    };
    const presetPut = await api.put(API_PATHS.preset(presetId), presetBody);
    check(presetPut.status === 200, 'a preset is saved', presetPut.json);
    const presets = await api.get(API_PATHS.presets);
    const stored = presets.json.presets.find((p) => p.id === presetId);
    check(
      stored?.name === 'Smoke preset' &&
        isDeepStrictEqual(stored.slots, presetBody.slots) &&
        isDeepStrictEqual(stored.layout, presetBody.layout),
      'the preset round-trips with its layout',
      stored,
    );
    check(
      (await api.put(API_PATHS.preset(presetId), { ...presetBody, name: 'Renamed' })).json?.name ===
        'Renamed',
      'a preset is renamed',
    );
    check((await api.del(API_PATHS.preset(presetId))).status < 300, 'a preset is deleted');
    check(
      !(await api.get(API_PATHS.presets)).json.presets.some((p) => p.id === presetId),
      'the deleted preset is gone',
    );

    const language = await api.put(API_PATHS.settings, { language: 'zh-TW' });
    check(
      language.json.settings.language === 'zh-TW' &&
        (await api.get(API_PATHS.settings)).json.settings.language === 'zh-TW',
      'a settings change round-trips',
    );
    const kept = (await api.get(API_PATHS.settings)).json.settings.providers.find(
      (p) => p.id === 'stub',
    );
    check(kept.hasApiKey === true, 'a later settings update keeps the stored key');

    const secretsFile = path.join(dataDir, 'secrets.json');
    check(readFileSync(secretsFile, 'utf8').includes(STUB_KEY), 'the key is in the secrets file');
    if (process.platform !== 'win32') {
      check(
        ((await stat(secretsFile)).mode & 0o077) === 0,
        'the secrets file is private to its owner',
      );
    }
    for (const name of await readdir(dataDir)) {
      if (!/\.(db|sqlite)(-wal|-shm)?$/.test(name)) continue;
      const bytes = await readFile(path.join(dataDir, name));
      check(
        !bytes.includes(Buffer.from(STUB_KEY)),
        `the database file ${name} holds no plaintext key`,
      );
    }

    // ------------------------------------------------------------- web UI
    const shell = await fetch(new URL('/', server.base));
    const html = await shell.text();
    check(shell.status === 200 && /<html/i.test(html), 'the built UI is served at /');
    check(
      shell.headers.get('content-security-policy') === EXPECTED_CSP,
      'the CSP is exactly the one in DECISIONS §7',
      shell.headers.get('content-security-policy'),
    );
    check(
      /no-cache/.test(shell.headers.get('cache-control') ?? ''),
      'the app shell is revalidated (no-cache)',
      shell.headers.get('cache-control'),
    );
    check(shell.headers.get('x-content-type-options') === 'nosniff', 'nosniff is set');
    const asset = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    check(asset !== undefined, 'the shell references a hashed script');
    const assetResponse = await fetch(new URL(asset, server.base));
    check(
      assetResponse.status === 200 &&
        /immutable/.test(assetResponse.headers.get('cache-control') ?? ''),
      'hashed assets are cached as immutable',
    );
    const sw = await fetch(new URL('/sw.js', server.base));
    check(
      sw.status === 200 && /no-cache/.test(sw.headers.get('cache-control') ?? ''),
      'the service worker is revalidated',
    );
    const deepLink = await fetch(new URL('/settings', server.base));
    check(
      deepLink.status === 200 && (await deepLink.text()) === html,
      'client routes fall back to the shell',
    );
    const missingApi = await api.get('/api/does-not-exist');
    check(
      missingApi.status === 404 && missingApi.json?.error?.code !== undefined,
      'unknown API paths get a JSON 404, never the shell',
    );
    for (const response of [shell, assetResponse, sw, deepLink]) {
      const cors = [...response.headers.keys()].filter((name) =>
        name.startsWith('access-control-'),
      );
      check(cors.length === 0, `no Access-Control-* header on ${new URL(response.url).pathname}`);
    }

    // ------------------------------------------- shutdown with running children
    const linesBefore = readFileSync(mockLog, 'utf8').trim().split('\n').length;
    const live = await api.post(API_PATHS.ask, {
      prompt: 'Shutdown test',
      targets: [
        { slotId: 't1', providerId: 'claude', model: 'mock-tree' },
        { slotId: 't2', providerId: 'grok', model: 'mock-hang' },
        { slotId: 't3', providerId: 'codex', model: 'mock-hang' },
        { slotId: 't4', providerId: 'claude', model: 'mock-hang' },
      ],
    });
    check(live.status === 200, 'a second ask starts');
    const liveId = live.json.askId;
    await until('every shutdown-test child to start', () => {
      const lines = readFileSync(mockLog, 'utf8')
        .trim()
        .split('\n')
        .slice(linesBefore)
        .map((line) => JSON.parse(line));
      const started = lines.filter((l) => l.scenario === 'tree' || l.scenario === 'hang');
      return started.length >= 4 && lines.some((l) => l.grandchildPid !== undefined);
    });
    await sleep(200);

    server.stop();
    const exitCode = await Promise.race([server.exited, sleep(20_000).then(() => 'timeout')]);
    check(exitCode === 0, `the server shuts down cleanly (exit ${exitCode})`);
    check(
      server.entries.some((e) => e.msg === 'stopped'),
      'the server logged that it stopped',
    );

    const pids = mockPids(mockLog);
    await sleep(300);
    const survivors = [...pids].filter(isAlive);
    check(
      pids.size > 0 && survivors.length === 0,
      `none of the ${pids.size} CLI processes or their children outlived the server`,
      survivors,
    );
    const logText = server.entries.map((e) => JSON.stringify(e)).join('\n');
    check(
      !logText.includes(STUB_KEY) &&
        !logText.includes('zebracorn') &&
        !logText.includes(api.cookie.split('=')[1]),
      'the log holds no key, prompt or session token',
    );

    // --------------------------------------------------------- restart
    server = await startServer({ dataDir, env });
    const again = createClient(server.base);
    const restartCookie = api.cookie;
    const afterRestart = await again.get(API_PATHS.historyEntry(liveId), {
      headers: { cookie: restartCookie },
    });
    check(afterRestart.status === 200, 'the device stays signed in across a restart');
    check(
      afterRestart.json.status === 'done' &&
        afterRestart.json.slots.every(
          (s) =>
            s.status === 'error' &&
            s.error.code === 'unknown' &&
            s.error.message === 'server restarted',
        ),
      'slots interrupted by the shutdown are marked "server restarted"',
      afterRestart.json.slots,
    );
    const stored1 = await again.get(API_PATHS.askSnapshot(askId), {
      headers: { cookie: restartCookie },
    });
    check(
      isDeepStrictEqual(stored1.json, final.json),
      'the first ask is served unchanged from storage after the restart',
    );
    const storedStream = await readStream(server.base, API_PATHS.askStream(askId), restartCookie);
    check(
      storedStream.events.length === 1 &&
        storedStream.events[0].type === 'snapshot' &&
        storedStream.events[0].snapshot.status === 'done',
      'a stored ask streams as a single done snapshot',
    );
    check(
      server.entries.every((e) => !/one-time code/.test(e.msg ?? '')),
      'no bootstrap code is printed once a device exists',
    );
    const deleted = await again.del(API_PATHS.historyEntry(askId), {
      headers: { cookie: restartCookie },
    });
    check(
      deleted.status < 300 &&
        (await again.get(API_PATHS.historyEntry(askId), { headers: { cookie: restartCookie } }))
          .status === 404,
      'a history entry is deleted',
    );
    check(
      (await again.get(API_PATHS.askSnapshot(askId), { headers: { cookie: restartCookie } }))
        .status === 404,
      'a deleted ask is no longer served by the ask routes',
    );

    server.stop('ipc');
    check(
      (await server.exited) === 0,
      'the restarted server shuts down cleanly on the IPC shutdown message',
    );
    log(`all ${step} checks passed`);
  } catch (error) {
    if (server) {
      process.stderr.write(
        `[smoke] last server log lines:\n${server.entries
          .slice(-15)
          .map((e) => JSON.stringify(e))
          .join('\n')}\n${server.stderr.join('')}\n`,
      );
    }
    throw error;
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`[smoke] FAILED: ${error.stack ?? error}\n`);
    process.exit(1);
  },
);
