#!/usr/bin/env node
// Starts an extracted server bundle with plain Node and checks that it serves.
//
//   node .github/scripts/verify-bundle.mjs <bundle directory>
//
// The bundle's production dependencies must be installed already
// (`npm ci --omit=dev` in that directory). The server listens on an ephemeral
// loopback port with a temporary data directory and an empty PATH, so it can
// find no command-line tool to detect or run. Works on Linux and Windows.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;

const bundleDir = resolve(process.argv[2] ?? '');
if (process.argv[2] === undefined) {
  console.error('usage: verify-bundle.mjs <bundle directory>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'));
const entry = join(bundleDir, Object.values(manifest.bin)[0]);

const temp = mkdtempSync(join(tmpdir(), 'bundle-check-'));
const emptyBin = join(temp, 'bin');
const home = join(temp, 'home');
mkdirSync(emptyBin);
mkdirSync(home);

// The caller's environment minus the search path (whatever its spelling on
// Windows), the home directory and anything the server reads as configuration.
const envPrefix = `${Object.keys(manifest.bin)[0].toUpperCase()}_`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name.toUpperCase() !== 'PATH' && !name.toUpperCase().startsWith(envPrefix),
  ),
);
Object.assign(env, { PATH: emptyBin, HOME: home, USERPROFILE: home });

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

const child = spawn(
  process.execPath,
  [
    entry,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--data-dir',
    join(temp, 'data'),
    '--tls',
    'off',
    '--log-format',
    'json',
  ],
  { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
);
const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
let output = '';
let errors = '';
child.stdout.setEncoding('utf8').on('data', (text) => (output += text));
child.stderr.setEncoding('utf8').on('data', (text) => (errors += text));

const timeout = (ms, what) =>
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref();
  });

/** Resolves with the URL from the "is listening" log line. */
async function listening() {
  for (;;) {
    for (const line of output.split('\n')) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (/is listening/.test(record.msg ?? '') && typeof record.url === 'string') {
        return record.url;
      }
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

let failed = false;
try {
  const url = await Promise.race([
    listening(),
    exited.then(({ code }) => {
      throw new Error(`the server exited with ${code} before listening`);
    }),
    timeout(START_TIMEOUT_MS, 'the server to listen'),
  ]);
  const base = `http://127.0.0.1:${new URL(url).port}`;
  check(true, `the bundle starts with plain node (${process.version})`);

  const meta = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(10_000) });
  check(meta.status === 200, 'GET /api/meta answers 200');
  const body = await meta.json();
  check(
    body.version === manifest.version,
    `/api/meta reports version ${manifest.version} (got ${body.version})`,
  );

  const page = await fetch(`${base}/`, { signal: AbortSignal.timeout(10_000) });
  const html = await page.text();
  check(page.status === 200 && /<!doctype html>/i.test(html), 'GET / serves the bundled web UI');
} catch (error) {
  failed = true;
  console.error(`not ok - ${error.message}`);
  console.error(`--- server stdout\n${output}--- server stderr\n${errors}`);
}

// Windows cannot deliver SIGTERM; the server accepts an IPC message instead.
if (child.exitCode === null && child.signalCode === null) {
  if (process.platform === 'win32' && child.connected) child.send('shutdown');
  else child.kill('SIGTERM');
}
try {
  const { code } = await Promise.race([exited, timeout(STOP_TIMEOUT_MS, 'the server to stop')]);
  if (!failed) check(code === 0, `the server stops cleanly (exit code ${code})`);
} catch (error) {
  failed = true;
  console.error(`not ok - ${error.message}`);
  child.kill('SIGKILL');
  await exited;
}

rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failed ? 1 : 0);
