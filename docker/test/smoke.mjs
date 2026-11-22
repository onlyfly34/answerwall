#!/usr/bin/env node
// Smoke test of the Docker image and of the compose files in docker/.
//
//   node docker/test/smoke.mjs [options]
//
//   --image <ref>    Image to test (default <prefix>image:local).
//   --no-build       Use the image as it is instead of building it first.
//   --all            Also run the reverse-proxy and the own-certificate setups.
//   --proxy, --cert  Run one of those two in addition to the main run.
//   --prefix <name>  Prefix of every container, volume and network this test
//                    creates (default answerwall-smoke-).
//   --keep-image     Do not remove an image this test built.
//
// Linux only: it needs Docker with the compose plugin, bind-mounts the mock
// CLIs of this repository into the container and, for --proxy and --cert,
// calls openssl and pulls an nginx image. No real AI command-line tool is
// started and nothing but the image build reaches the network.
//
// The main run starts docker/compose.yaml as shipped (read-only root file
// system, no capabilities, built-in TLS) with the mock CLIs on PATH, pairs a
// device with the code from the log and one from `answerwall pair`, sends one
// ask across the five mocks, cancels and stops while mocks are running, and
// checks that nothing is left behind, that state survives a re-create, that
// the image holds no AI command-line tool and that nothing runs as root.

import { spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FORBIDDEN_PACKAGE_REGEX } from '../../scripts/forbidden-packages.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DOCKER_DIR = path.join(ROOT, 'docker');
const MOCK_CLIS = path.join(ROOT, 'tools', 'mock-clis');
const CLI_KINDS = ['claude', 'codex', 'grok', 'agy', 'opencode'];
const SERVICE = 'answerwall';
const CONTAINER_PORT = 7717;
const NGINX_IMAGE = 'nginx:1.30.7-alpine';
const PROXY_NAME = 'wall.example.test';
/** Private ranges tried in turn for the reverse-proxy network; the first free one is used. */
const SUBNET_CANDIDATES = ['10.213.77', '10.214.77', '172.30.77', '192.168.213'];
const PROMPT = 'Docker smoke test zebracorn: what is two plus two?';

const { values: options } = parseArgs({
  options: {
    image: { type: 'string' },
    'no-build': { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    proxy: { type: 'boolean', default: false },
    cert: { type: 'boolean', default: false },
    prefix: { type: 'string', default: 'answerwall-smoke-' },
    'keep-image': { type: 'boolean', default: false },
  },
});
const PREFIX = options.prefix;
const RUN_ID = randomBytes(3).toString('hex');
const IMAGE = options.image ?? `${PREFIX}image:local`;

// ---------------------------------------------------------------- helpers

let step = 0;
function log(message) {
  process.stdout.write(`[docker-smoke] ${message}\n`);
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

async function until(what, condition, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** Runs a command to its end. Throws on a non-zero exit unless `allowFailure`. */
function run(command, args, { allowFailure = false, env, input, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: env === undefined ? process.env : { ...process.env, ...env },
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
const docker = (args, runOptions) => run('docker', args, runOptions);

const cleanups = [];
let cleaning;
function cleanup() {
  cleaning ??= (async () => {
    for (const task of cleanups.reverse()) {
      try {
        await task();
      } catch (error) {
        log(`cleanup problem: ${error.message}`);
      }
    }
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    log(`${signal} received: cleaning up`);
    void cleanup().finally(() => process.exit(128 + (os.constants.signals[signal] ?? 1)));
  });
}

// ------------------------------------------------------------ HTTP client

/**
 * One request. `target` says where the server is and how it is addressed:
 * `{ tls, port, ca, name }`. `name` is the public host name when the socket
 * goes to loopback but the certificate and the Host header carry another name.
 */
function send(target, method, pathname, { headers = {}, body, onResponse } = {}) {
  const request = target.tls ? httpsRequest : httpRequest;
  const hostHeader = target.name === undefined ? undefined : target.name;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: target.port,
        method,
        path: pathname,
        headers: { ...(hostHeader === undefined ? {} : { host: hostHeader }), ...headers },
        ...(target.tls
          ? { ca: target.ca, servername: target.name ?? '', rejectUnauthorized: true }
          : {}),
        agent: false,
      },
      (res) => {
        if (onResponse) {
          resolve(onResponse(res, req));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text === '' ? undefined : JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
    req.end(body);
  });
}

/** The origin a browser would name for this target. */
function originOf(target) {
  const scheme = target.tls ? 'https' : 'http';
  return target.name === undefined
    ? `${scheme}://127.0.0.1:${target.port}`
    : `${scheme}://${target.name}`;
}

/** A browser-like client: keeps the session cookie, sends Origin and JSON on writes. */
function createClient(target) {
  let cookie;
  let lastSetCookie;
  async function call(method, pathname, body) {
    const headers = { accept: 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers.origin = originOf(target);
    }
    const response = await send(target, method, pathname, {
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const setCookie = response.headers['set-cookie']?.[0];
    if (setCookie) {
      lastSetCookie = setCookie;
      cookie = setCookie.split(';')[0];
    }
    return response;
  }
  return {
    get: (pathname) => call('GET', pathname),
    post: (pathname, body) => call('POST', pathname, body),
    put: (pathname, body) => call('PUT', pathname, body),
    get cookie() {
      return cookie;
    },
    get setCookie() {
      return lastSetCookie;
    },
    /** The same session against the same server at another port (after a restart). */
    moveTo(next) {
      target = next;
    },
  };
}

/** Reads an event stream to its end. Every event gets `at`, the time it arrived. */
function readStream(target, pathname, cookie) {
  return send(target, 'GET', pathname, {
    headers: { cookie, accept: 'text/event-stream' },
    onResponse: (res) =>
      new Promise((resolve, reject) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`stream ${pathname} answered ${res.statusCode}`));
          return;
        }
        const events = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).replace(/^ /, ''));
            if (data.length > 0) events.push({ ...JSON.parse(data.join('\n')), at: Date.now() });
          }
        });
        res.on('end', () => resolve({ events, headers: res.headers }));
        res.on('error', reject);
      }),
  });
}

// ---------------------------------------------------------------- compose

/**
 * One compose project built from the shipped files plus a generated override
 * that only adds what a test needs: the mock CLIs, an ephemeral host port and
 * "never pull, never build".
 */
function createProject(name, { files, env = {}, temp, extraService = '' }) {
  const project = `${PREFIX}${name}-${RUN_ID}`;
  const mockLog = path.join(temp, `${name}-mock-log`);
  mkdirSync(mockLog, { recursive: true });
  // The container's user is not the user running this test.
  chmodSync(mockLog, 0o777);
  const override = path.join(temp, `${name}.override.yaml`);
  writeFileSync(
    override,
    [
      'services:',
      `  ${SERVICE}:`,
      '    pull_policy: never',
      "    restart: 'no'",
      '    environment:',
      '      PATH: /opt/mock-clis/bin:/usr/local/bin:/usr/bin:/bin',
      '      MOCK_CLI_LOG: /mock-log/invocations.jsonl',
      "      MOCK_CLI_DELAY_MS: '120'",
      '    volumes:',
      `      - ${JSON.stringify(`${MOCK_CLIS}:/opt/mock-clis:ro`)}`,
      `      - ${JSON.stringify(`${mockLog}:/mock-log`)}`,
      extraService,
      '',
    ].join('\n'),
  );
  // An empty file: a developer's own docker/.env must not reach the test.
  const envFile = path.join(temp, `${name}.env`);
  writeFileSync(envFile, '');
  const base = [
    'compose',
    '--project-name',
    project,
    '--project-directory',
    DOCKER_DIR,
    '--env-file',
    envFile,
    ...files.flatMap((file) => ['--file', path.join(DOCKER_DIR, file)]),
    '--file',
    override,
  ];
  const composeEnv = { ANSWERWALL_IMAGE: IMAGE, PUBLISH_PORT: '0', ...env };
  const compose = (args, runOptions = {}) =>
    docker([...base, ...args], { ...runOptions, env: composeEnv });
  const api = {
    project,
    mockLog: path.join(mockLog, 'invocations.jsonl'),
    compose,
    up: () => compose(['up', '--detach', '--no-build', '--wait', '--wait-timeout', '90']),
    down: (volumes) =>
      compose(['down', '--remove-orphans', '--timeout', '25', ...(volumes ? ['--volumes'] : [])], {
        allowFailure: true,
      }),
    container: () => compose(['ps', '--all', '--quiet', SERVICE]).stdout.trim(),
    port() {
      const published = compose(['port', SERVICE, String(CONTAINER_PORT)]).stdout.trim();
      if (!published.startsWith('127.0.0.1:')) {
        throw new Error(`the port is published on ${published}, expected 127.0.0.1`);
      }
      return Number(published.slice(published.lastIndexOf(':') + 1));
    },
    exec: (args, runOptions) => compose(['exec', '--no-TTY', SERVICE, ...args], runOptions),
    logs: () => compose(['logs', '--no-color', '--no-log-prefix', SERVICE]).stdout,
    /** Command lines of the processes in the container, as the host sees them. */
    processes() {
      const top = docker(['top', api.container(), '-eo', 'pid,user:20,args']).stdout;
      return top
        .split('\n')
        .slice(1)
        .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
        .filter((match) => match !== null)
        .map(([, pid, user, args]) => ({ pid: Number(pid), user, args }));
    },
    mocksRunning: () => api.processes().filter((p) => /\/opt\/mock-clis\//.test(p.args)),
  };
  cleanups.push(() => api.down(true));
  return api;
}

/** The pairing code the server printed last. */
function loggedPairingCode(project) {
  const codes = [...project.logs().matchAll(/one-time code: (\d{4}) (\d{4})/g)];
  const last = codes.at(-1);
  return last === undefined ? undefined : last[1] + last[2];
}

async function pairFromLog(project, target, deviceName) {
  const code = await until('the pairing code in the log', () => loggedPairingCode(project));
  const client = createClient(target);
  const paired = await client.post('/api/auth/pair', { code, deviceName });
  check(
    paired.status === 200 && paired.json.device?.name === deviceName,
    `pairing with the code from "docker compose logs" creates the device "${deviceName}"`,
    paired.json,
  );
  return client;
}

async function enableMocks(client) {
  const before = await client.get('/api/settings');
  check(before.status === 200, 'settings are readable', before.json);
  const providers = CLI_KINDS.map((kind) => ({
    ...before.json.settings.providers.find((p) => p.id === kind),
    enabled: true,
    concurrency: 1,
    ...(kind === 'agy' ? { riskAcknowledged: true } : {}),
  }));
  const saved = await client.put('/api/settings', {
    providers,
    limits: { slotTimeoutMs: 60_000 },
  });
  check(saved.status === 200, 'the five CLI providers are enabled', saved.json);
  check((await client.post('/api/providers/refresh', {})).status === 200, 'provider refresh runs');
  return until('provider detection', async () => {
    const list = (await client.get('/api/providers')).json.providers;
    const cli = list.filter((p) => CLI_KINDS.includes(p.instance.id));
    return cli.every((p) => p.detecting !== true && p.detection !== null) ? cli : undefined;
  });
}

async function askAcrossMocks(client, target, models) {
  const targets = CLI_KINDS.map((kind) => ({
    slotId: kind,
    providerId: kind,
    // opencode names a model as provider/model.
    model: models[kind] ?? (kind === 'opencode' ? 'mock/mock-slow' : 'mock-slow'),
  }));
  const submitted = await client.post('/api/ask', { prompt: PROMPT, targets });
  check(
    submitted.status === 200 && typeof submitted.json.askId === 'string',
    'an ask with one slot per mock CLI is accepted',
    submitted.json,
  );
  const askId = submitted.json.askId;
  const stream = await readStream(target, `/api/ask/${askId}/stream`, client.cookie);
  return { askId, stream };
}

// ------------------------------------------------------------- the image

function buildImage() {
  const version = JSON.parse(
    readFileSync(path.join(ROOT, 'apps/server/package.json'), 'utf8'),
  ).version;
  const revision = run('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { allowFailure: true });
  log(`building ${IMAGE}`);
  docker(
    [
      'build',
      '--file',
      path.join(ROOT, 'apps/server/Dockerfile'),
      '--tag',
      IMAGE,
      '--build-arg',
      `VERSION=${version}`,
      '--build-arg',
      `REVISION=${revision.status === 0 ? revision.stdout.trim() : 'unknown'}`,
      '--build-arg',
      `CREATED=${new Date().toISOString()}`,
      ROOT,
    ],
    { inherit: true },
  );
  if (!options['keep-image']) {
    cleanups.push(() => docker(['image', 'rm', IMAGE], { allowFailure: true }));
  }
}

function checkImage() {
  const [image] = JSON.parse(docker(['image', 'inspect', IMAGE]).stdout);
  const config = image.Config;
  const repository = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).repository;
  const sourceUrl = `https://github.com/${repository.replace(/^github:/, '')}`;
  const megabytes = Math.round(image.Size / 1e6);
  log(
    `image ${IMAGE}: ${megabytes} MB as "docker image inspect" reports it (${image.Architecture})`,
  );

  const [uid, gid] = String(config.User).split(':').map(Number);
  check(
    Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0,
    `the image's user is a numeric non-root id (${config.User})`,
  );
  check(
    config.Labels?.['org.opencontainers.image.source'] === sourceUrl,
    `the image is labelled with its source repository (${sourceUrl})`,
    config.Labels,
  );
  check(
    ['title', 'description', 'licenses', 'version', 'revision', 'created'].every(
      (name) => (config.Labels?.[`org.opencontainers.image.${name}`] ?? '') !== '',
    ),
    'the other OCI labels are present',
    config.Labels,
  );
  check(
    Object.keys(config.Volumes ?? {})
      .sort()
      .join(' ') === '/data /home/answerwall',
    'the volumes are /data and the home directory',
    config.Volumes,
  );
  check(config.Entrypoint?.[0] === '/usr/bin/tini', 'tini is the first process', config.Entrypoint);
  check(
    config.Healthcheck?.Test?.join(' ') === 'CMD answerwall-healthcheck',
    'the image has a health check',
    config.Healthcheck,
  );
  const suspicious = config.Env.filter((entry) =>
    /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(entry.split('=')[0]),
  );
  check(suspicious.length === 0, 'the image sets no secret-like environment variable', suspicious);

  // Looks at the file system of the image itself: no network, no volumes of a project.
  // `asRoot` only to read directories the image's own user may not enter.
  const inside = (script, asRoot = false) =>
    docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      ...(asRoot ? ['--user', '0:0'] : ['--cap-drop', 'ALL']),
      '--entrypoint',
      '/bin/sh',
      IMAGE,
      '-c',
      script,
    ]).stdout;

  check(inside('id -u').trim() === String(uid), `a container runs as user id ${uid}, not root`);
  const names = [...CLI_KINDS, 'gemini', 'antigravity', 'openai', 'npm', 'npx', 'pnpm', 'corepack'];
  const onPath = inside(
    `for name in ${names.join(' ')}; do command -v "$name" || true; done`,
  ).trim();
  check(onPath === '', 'no AI command-line tool and no package manager is on PATH', onPath);
  const nameTests = [...CLI_KINDS, 'gemini', 'antigravity']
    .flatMap((name) => [`-name ${name}`, `-name '${name}-*'`, `-name '.${name}'`])
    .join(' -o ');
  const found = inside(
    `find / -xdev \\( -path /proc -o -path /sys -o -path /opt/mock-clis \\) -prune -o \\( ${nameTests} \\) -print`,
    true,
  ).trim();
  check(found === '', 'no file or directory of an AI command-line tool exists in the image', found);
  const home = inside('ls -A "$HOME"').trim().split('\n').sort();
  check(
    home.every((name) => ['.bash_logout', '.bashrc', '.profile'].includes(name)),
    'the home directory holds only the shell skeleton files: no tool, no login',
    home,
  );
  const packages = inside(
    'cd /opt/answerwall/node_modules && for d in * @*/*; do [ -d "$d" ] && echo "$d"; done',
  )
    .trim()
    .split('\n')
    .filter((name) => !name.startsWith('@') || name.includes('/'));
  const forbidden = new RegExp(FORBIDDEN_PACKAGE_REGEX);
  check(
    packages.length > 3 && packages.every((name) => !forbidden.test(name)),
    `none of the ${packages.length} installed packages is a vendor SDK`,
    packages,
  );
  check(
    inside('ls /opt/answerwall/dist/main.js /opt/answerwall/packages/web/dist/index.html').trim()
      .length > 0,
    'the compiled server and the built web UI are in the image',
  );
  return { uid };
}

// ------------------------------------------------------------- main run

async function mainRun(temp, { uid }) {
  log('--- main run: docker/compose.yaml as shipped, built-in TLS');
  const project = createProject('main', { files: ['compose.yaml'], temp });
  project.up();
  const id = project.container();
  const state = JSON.parse(docker(['inspect', id]).stdout)[0];
  check(state.State.Health?.Status === 'healthy', 'the container reports healthy');
  check(
    state.HostConfig.ReadonlyRootfs === true &&
      state.HostConfig.CapDrop?.includes('ALL') &&
      state.HostConfig.SecurityOpt?.includes('no-new-privileges:true'),
    'it runs with a read-only root file system, no capabilities and no-new-privileges',
  );
  const binds = state.Mounts.filter((mount) => mount.Type === 'bind').map((m) => m.Destination);
  check(
    binds.sort().join(' ') === '/mock-log /opt/mock-clis',
    'nothing of the host is mounted except what this test added',
    state.Mounts.map((mount) => `${mount.Type}:${mount.Destination}`),
  );
  check(
    project.processes().every((p) => p.user === String(uid) || p.user === 'answerwall') &&
      project.exec(['id', '-u']).stdout.trim() === String(uid),
    `every process in the container runs as user id ${uid}`,
    project.processes(),
  );

  // The public half of the private CA, so that the test verifies TLS like a
  // browser that has installed it.
  const ca = project.exec(['cat', '/data/tls/ca.crt']).stdout;
  check(new X509Certificate(ca).ca === true, 'the private CA certificate is in the data volume');
  let target = { tls: true, port: project.port(), ca };

  const meta = await send(target, 'GET', '/api/meta');
  const version = JSON.parse(
    readFileSync(path.join(ROOT, 'apps/server/package.json'), 'utf8'),
  ).version;
  check(
    meta.status === 200 &&
      meta.json.version === version &&
      meta.json.tls === 'auto' &&
      meta.json.authRequired === true,
    `GET /api/meta over verified TLS on the published loopback port answers (version ${version})`,
    meta.json,
  );
  const plain = await send({ tls: false, port: target.port }, 'GET', '/api/meta').catch(
    (error) => ({ refused: error.code ?? error.message }),
  );
  check(plain.status !== 200, 'the port does not answer plain HTTP', plain);
  check(
    (await send(target, 'GET', '/api/providers')).status === 401,
    'the API refuses a request without credentials',
  );
  const index = await send(target, 'GET', '/');
  check(
    index.status === 200 && /<html/i.test(index.text),
    'the web UI is served from the same origin',
  );

  // ------------------------------------------------------------ pairing
  const client = await pairFromLog(project, target, 'smoke first');
  check(
    /HttpOnly/i.test(client.setCookie) &&
      /SameSite=Strict/i.test(client.setCookie) &&
      /Secure/i.test(client.setCookie),
    'the session cookie is HttpOnly, SameSite=Strict and Secure',
    client.setCookie,
  );
  const printed = project.exec(['answerwall', 'pair']).stdout;
  const cliCode = /Pairing code: (\d{4}) (\d{4})/.exec(printed);
  check(cliCode !== null, '"docker compose exec answerwall answerwall pair" prints a code');
  const second = createClient(target);
  check(
    (await second.post('/api/auth/pair', { code: cliCode[1] + cliCode[2], deviceName: 'second' }))
      .status === 200,
    'a second device pairs with that code',
  );

  // ---------------------------------------------------------- providers
  const detected = await enableMocks(client);
  for (const status of detected) {
    check(
      status.detection?.installed === true,
      `${status.instance.id} is detected as installed (the mock on PATH)`,
      status.detection,
    );
  }

  // ---------------------------------------------------------------- ask
  const { askId, stream } = await askAcrossMocks(client, target, {
    claude: 'mock-slow',
    codex: 'mock-block',
    grok: 'mock-echo',
    agy: 'mock-slow',
  });
  check(
    stream.events.at(-1)?.type === 'ask_done',
    `the stream ends with ask_done after ${stream.events.length} events`,
  );
  const snapshot = (await client.get(`/api/ask/${askId}`)).json;
  for (const slot of snapshot.slots) {
    check(
      slot.status === 'done' && slot.text.length > 0,
      `${slot.slotId} answered through the hardened container`,
      slot,
    );
  }
  check(
    snapshot.slots.find((slot) => slot.slotId === 'grok').text.includes('zebracorn'),
    'the prompt reached a CLI through a prompt file in the work directory',
  );
  const invocations = readFileSync(project.mockLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  const runs = invocations.filter((entry) => entry.cwd.startsWith('/data/work/'));
  check(runs.length >= CLI_KINDS.length, 'every CLI ran in a work directory under /data/work');
  check(
    invocations.every((entry) => entry.envNames.every((name) => !name.startsWith('ANSWERWALL_'))),
    "no CLI saw any of the server's own ANSWERWALL_ variables",
  );
  check(project.mocksRunning().length === 0, 'no CLI process is left after the ask');
  check(
    project.exec(['sh', '-c', 'ls -A /data/work']).stdout.trim() === '',
    'the work directories are removed',
  );

  // ------------------------------------------------------ cancel and stop
  const hanging = {
    prompt: PROMPT,
    targets: [
      { slotId: 'h1', providerId: 'claude', model: 'mock-hang' },
      { slotId: 'h2', providerId: 'codex', model: 'mock-tree' },
      { slotId: 'h3', providerId: 'grok', model: 'mock-stubborn-tree' },
    ],
  };
  const first = (await client.post('/api/ask', hanging)).json.askId;
  await until('three hanging mocks', () => project.mocksRunning().length >= 3);
  check(true, `${project.mocksRunning().length} mock processes are running, some ignore SIGTERM`);
  check((await client.post(`/api/ask/${first}/cancel`, {})).status === 200, 'the ask is cancelled');
  await until(
    'the cancelled CLIs to be gone',
    () => project.mocksRunning().length === 0,
    20_000,
  ).catch(() => undefined);
  check(
    project.mocksRunning().length === 0,
    'cancelling leaves no CLI process in the running container, not even one that ignores SIGTERM',
    project.mocksRunning(),
  );

  const interrupted = (await client.post('/api/ask', hanging)).json.askId;
  await until('three hanging mocks', () => project.mocksRunning().length >= 3);
  const stopStarted = Date.now();
  project.compose(['stop', SERVICE]);
  const stopMs = Date.now() - stopStarted;
  const stopped = JSON.parse(docker(['inspect', id]).stdout)[0].State;
  check(
    stopped.ExitCode === 0 && stopped.OOMKilled === false,
    `"docker compose stop" during a running ask ends the container with exit code 0 (${stopMs} ms)`,
    stopped,
  );
  check(stopMs < 15_000, 'the stop did not run into the grace period');
  check(/ stopped\b/.test(project.logs()), 'the server logged a completed shutdown');
  const strays = run('pgrep', ['-af', '^(/usr/local/bin/)?node .*/opt/mock-clis/'], {
    allowFailure: true,
  }).stdout.trim();
  check(strays === '', 'no mock CLI process is left on the Docker host', strays);

  // ------------------------------------------------- restart and re-create
  // The container is stopped; `start` brings the same one back.
  project.compose(['start', SERVICE]);
  await until('the restarted container to be healthy', () => {
    const health = JSON.parse(docker(['inspect', id]).stdout)[0].State.Health?.Status;
    return health === 'healthy';
  });
  target = { ...target, port: project.port() };
  client.moveTo(target);
  check(
    (await client.get('/api/providers')).status === 200,
    'the paired device is still signed in after a restart',
  );
  const after = (await client.get(`/api/history/${interrupted}`)).json;
  check(
    after.slots.length === 3 &&
      after.slots.every((slot) => !['running', 'queued'].includes(slot.status)),
    'the interrupted ask is recorded as ended',
    after.slots?.map((slot) => `${slot.slotId}:${slot.status}`),
  );
  check(
    project.exec(['sh', '-c', 'ls -A /data/work']).stdout.trim() === '',
    'no work directory survived the stop',
  );

  project.exec(['sh', '-c', 'echo kept > "$HOME/.smoke-marker"']);
  project.down(false);
  project.up();
  target = { ...target, port: project.port() };
  client.moveTo(target);
  check(project.container() !== id, 'the container was re-created');
  check(
    (await client.get('/api/providers')).status === 200,
    'the device, the CA and the settings survive a re-create (the data volume)',
  );
  check(
    project.exec(['sh', '-c', 'cat "$HOME/.smoke-marker"']).stdout.trim() === 'kept',
    'the home directory survives a re-create (the CLI home volume)',
  );
  check(
    project
      .exec(['sh', '-c', 'touch /opt/answerwall/x 2>&1; touch /usr/local/bin/x 2>&1; true'])
      .stdout.split('\n')
      .filter((line) => /Read-only file system/.test(line)).length === 2,
    'the application files cannot be changed from inside the container',
  );

  // The CLI install helper must do nothing unless asked and confirmed.
  const list = project.exec(['answerwall-install-cli', '--list']).stdout;
  check(
    CLI_KINDS.every((kind) => list.includes(`Tool:      ${kind} `)) && /https:\/\//.test(list),
    'the install helper lists every tool with its command, source and terms',
  );
  const unconfirmed = project.exec(['answerwall-install-cli', 'claude'], { allowFailure: true });
  check(
    unconfirmed.status !== 0 && /no terminal to ask on/.test(unconfirmed.stderr),
    'the install helper installs nothing without a confirmation',
    unconfirmed,
  );
  const unknown = project.exec(['answerwall-install-cli', 'gemini', '--yes'], {
    allowFailure: true,
  });
  check(unknown.status === 2, 'the install helper refuses a tool it does not know');

  project.down(true);
  const left = docker(['ps', '--all', '--quiet', '--filter', `name=${project.project}`]).stdout;
  const volumes = docker(['volume', 'ls', '--quiet', '--filter', `name=${project.project}`]).stdout;
  check(
    left.trim() === '' && volumes.trim() === '',
    'compose down --volumes leaves no container and no volume',
  );
}

// ------------------------------------------------- own certificate, proxy

function selfSigned(dir, name) {
  mkdirSync(dir, { recursive: true });
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '2',
    '-subj',
    `/CN=${name}`,
    '-addext',
    `subjectAltName=DNS:${name}`,
    '-keyout',
    path.join(dir, 'privkey.pem.new'),
    '-out',
    path.join(dir, 'fullchain.pem.new'),
  ]);
  // Readable by the container's user, and replaced the way a renewal does it.
  for (const file of ['privkey.pem', 'fullchain.pem']) {
    chmodSync(path.join(dir, `${file}.new`), 0o644);
    run('mv', ['-f', path.join(dir, `${file}.new`), path.join(dir, file)]);
  }
  return readFileSync(path.join(dir, 'fullchain.pem'), 'utf8');
}

async function certRun(temp) {
  log('--- own certificate: compose.yaml + compose.cert.yaml');
  const certDir = path.join(temp, 'certs');
  mkdirSync(certDir);
  chmodSync(certDir, 0o755);
  const firstCertificate = selfSigned(certDir, PROXY_NAME);
  const project = createProject('cert', {
    files: ['compose.yaml', 'compose.cert.yaml'],
    env: { TLS_CERT_DIR: certDir, ANSWERWALL_PUBLIC_ORIGINS: `https://${PROXY_NAME}` },
    temp,
  });
  project.up();
  const target = { tls: true, port: project.port(), ca: firstCertificate, name: PROXY_NAME };
  const meta = await send(target, 'GET', '/api/meta');
  check(
    meta.status === 200 && meta.json.tls === 'cert',
    'the server answers with the mounted certificate, verified for its public name',
    meta.json,
  );
  const client = await pairFromLog(project, target, 'smoke cert');
  check(/Secure/i.test(client.setCookie), 'the session cookie is Secure');

  const renewed = selfSigned(certDir, PROXY_NAME);
  const reloaded = await until(
    'the renewed certificate to be served',
    () =>
      send({ ...target, ca: renewed }, 'GET', '/api/meta').then(
        (response) => response.status === 200,
        () => false,
      ),
    30_000,
  ).catch(() => false);
  check(reloaded, 'a renewed certificate in the mounted directory is picked up without a restart');
  project.down(true);
}

async function proxyRun(temp) {
  log('--- reverse proxy: compose.yaml + compose.proxy.yaml, nginx with docker/nginx.conf.example');
  const certDir = path.join(temp, 'proxy-certs');
  const certificate = selfSigned(certDir, PROXY_NAME);
  chmodSync(certDir, 0o755);

  // The shipped example with the three site-specific lines replaced.
  const example = readFileSync(path.join(DOCKER_DIR, 'nginx.conf.example'), 'utf8');
  const config = example
    .replaceAll('wall.example.com; # replace', `${PROXY_NAME};`)
    .replace(/ssl_certificate .*# replace/, 'ssl_certificate /certs/fullchain.pem;')
    .replace(/ssl_certificate_key .*# replace/, 'ssl_certificate_key /certs/privkey.pem;')
    .replace(/proxy_pass .*# replace/, `proxy_pass http://${SERVICE}:${CONTAINER_PORT};`);
  check(
    !config.includes('# replace') && config.includes('proxy_buffering off;'),
    'the nginx example was adapted by replacing only its marked lines',
  );
  const configFile = path.join(temp, 'nginx.conf');
  writeFileSync(configFile, config);

  let project;
  let subnet;
  for (const candidate of SUBNET_CANDIDATES) {
    const proxyAddress = `${candidate}.10`;
    project = createProject(`proxy${SUBNET_CANDIDATES.indexOf(candidate)}`, {
      files: ['compose.yaml', 'compose.proxy.yaml'],
      env: {
        ANSWERWALL_PUBLIC_ORIGINS: `https://${PROXY_NAME}`,
        PROXY_SUBNET: `${candidate}.0/24`,
        // The gateway (a proxy on the Docker host) and the nginx container.
        ANSWERWALL_TRUSTED_PROXIES: `${candidate}.1,${proxyAddress}`,
      },
      temp,
      extraService: [
        '  proxy:',
        `    image: ${NGINX_IMAGE}`,
        "    restart: 'no'",
        '    depends_on:',
        `      - ${SERVICE}`,
        '    ports:',
        "      - '127.0.0.1:0:443'",
        '    volumes:',
        `      - ${JSON.stringify(`${configFile}:/etc/nginx/conf.d/default.conf:ro`)}`,
        `      - ${JSON.stringify(`${certDir}:/certs:ro`)}`,
        '    networks:',
        '      default:',
        `        ipv4_address: ${proxyAddress}`,
      ].join('\n'),
    });
    const started = project.compose(
      ['up', '--detach', '--no-build', '--wait', '--wait-timeout', '90'],
      { allowFailure: true },
    );
    if (started.status === 0) {
      subnet = candidate;
      break;
    }
    if (!/overlap|already in use|pool/i.test(started.stderr)) {
      throw new Error(`the reverse-proxy project did not start:\n${started.stderr}`);
    }
    log(`subnet ${candidate}.0/24 is taken on this host, trying the next one`);
    project.down(true);
  }
  if (subnet === undefined) throw new Error('no free subnet for the reverse-proxy network');

  const published = project.compose(['port', 'proxy', '443']).stdout.trim();
  const viaProxy = {
    tls: true,
    port: Number(published.slice(published.lastIndexOf(':') + 1)),
    ca: certificate,
    name: PROXY_NAME,
  };
  const meta = await send(viaProxy, 'GET', '/api/meta');
  check(
    meta.status === 200 && meta.json.tls === 'off',
    'GET /api/meta through nginx answers; the server itself runs without TLS',
    meta.json,
  );

  // Straight to the published plain-HTTP port, as a proxy on the Docker host would.
  const direct = { tls: false, port: project.port(), name: PROXY_NAME };
  const fromHost = await send(direct, 'GET', '/api/meta');
  check(
    fromHost.status === 200,
    'a connection from the Docker host arrives from the network gateway, which is trusted',
    fromHost.json,
  );
  // A container on the same network that is not listed as a proxy.
  const stranger = docker([
    'run',
    '--rm',
    '--network',
    `${project.project}_default`,
    '--entrypoint',
    'curl',
    IMAGE,
    '--silent',
    '--max-time',
    '10',
    `http://${SERVICE}:${CONTAINER_PORT}/api/meta`,
  ]).stdout;
  check(
    /Plain HTTP is accepted only from this machine or a trusted proxy/.test(stranger),
    'a peer that is not a trusted proxy is refused',
    stranger,
  );

  const client = await pairFromLog(project, viaProxy, 'smoke proxy');
  check(
    /Secure/i.test(client.setCookie),
    'X-Forwarded-Proto from the trusted proxy makes the session cookie Secure',
    client.setCookie,
  );
  await enableMocks(client);
  const { stream } = await askAcrossMocks(client, viaProxy, {});
  check(stream.events.at(-1)?.type === 'ask_done', 'an ask streams to its end through nginx');
  const deltas = stream.events.filter((event) => event.type === 'delta');
  const spread = deltas.at(-1).at - deltas[0].at;
  check(
    deltas.length >= 4 && spread >= 300,
    `nginx passed the event stream on as it was produced (${deltas.length} deltas over ${spread} ms)`,
  );
  check(
    stream.headers['content-type']?.startsWith('text/event-stream') &&
      stream.headers['content-encoding'] === undefined,
    'the stream arrives uncompressed as text/event-stream',
    stream.headers,
  );
  project.down(true);
}

// ------------------------------------------------------------------- run

async function main() {
  if (process.platform !== 'linux') throw new Error('this test runs on Linux only');
  docker(['compose', 'version']);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'answerwall-docker-smoke-'));
  cleanups.push(() => rmSync(temp, { recursive: true, force: true }));
  // The container's user must be able to walk into the mounted directories.
  chmodSync(temp, 0o755);

  if (!options['no-build']) buildImage();
  const image = checkImage();
  await mainRun(temp, image);
  if (options.all || options.cert) await certRun(temp);
  if (options.all || options.proxy) await proxyRun(temp);
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  process.stderr.write(`[docker-smoke] FAILED: ${error.stack ?? error}\n`);
} finally {
  await cleanup();
}
const leftovers = docker(['ps', '--all', '--format', '{{.Names}}', '--filter', `name=${PREFIX}`], {
  allowFailure: true,
})
  .stdout.split('\n')
  .filter((name) => name.includes(RUN_ID));
if (leftovers.length > 0) {
  failed = true;
  process.stderr.write(`[docker-smoke] containers left behind: ${leftovers.join(', ')}\n`);
}
if (!failed) log(`all ${step} checks passed`);
process.exit(failed ? 1 : 0);
