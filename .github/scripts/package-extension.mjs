#!/usr/bin/env node
// Packages the browser extension from an already built workspace.
//
//   node .github/scripts/package-extension.mjs --out <dir> [--expect-version <x.y.z>]
//
// The result is <slug>-extension-<version>.zip with one directory of the same
// name inside: what a user unpacks and loads with "Load unpacked" in Chrome
// or Edge. It is the release build of apps/extension (`pnpm build`), checked
// here once more: the version, the exact permission list, and that nothing of
// the test build is in it.
//
// Needs zip and unzip: it is meant for Linux. Run `pnpm install
// --frozen-lockfile` and `pnpm build` first.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BUILD = join(ROOT, 'apps/extension/dist');

function fail(message) {
  console.error(`package-extension: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const { values: options } = parseArgs({
  options: { out: { type: 'string' }, 'expect-version': { type: 'string' } },
});
if (options.out === undefined) fail('--out <dir> is required');
const outDir = resolve(options.out);

const { BRAND } = await import(new URL('../../packages/core/src/brand.ts', import.meta.url).href);
const version = readJson(join(ROOT, 'apps/extension/package.json')).version;
const expected = options['expect-version'];
if (expected !== undefined && expected !== '' && expected !== version) {
  fail(`apps/extension has version ${version}, expected ${expected}`);
}
if (!existsSync(join(BUILD, 'manifest.json'))) {
  fail('apps/extension/dist is missing: run `pnpm build` first');
}

// ------------------------------------------------------------------ checks

const manifest = readJson(join(BUILD, 'manifest.json'));
if (manifest.version_name !== version) {
  fail(`the built manifest is for ${manifest.version_name}, not ${version}: run \`pnpm build\``);
}
const PERMISSIONS = ['declarativeNetRequestWithHostAccess', 'storage'];
if (JSON.stringify(manifest.permissions) !== JSON.stringify(PERMISSIONS)) {
  fail(`unexpected permissions: ${JSON.stringify(manifest.permissions)}`);
}
for (const pattern of manifest.host_permissions) {
  if (!/^https:\/\/[a-z0-9.-]+\/\*$/.test(pattern) || pattern.includes('localhost')) {
    fail(`unexpected host permission: ${pattern}`);
  }
}

function listFiles(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((child) =>
      child.isDirectory()
        ? listFiles(join(dir, child.name), `${prefix}/${child.name}`)
        : [`${prefix}/${child.name}`],
    );
}

// The stand-in site and the storage keys of the test build never ship.
for (const file of listFiles(BUILD, '.')) {
  if (!/\.(js|json|html|css)$/.test(file)) continue;
  const text = readFileSync(join(BUILD, file), 'utf8');
  for (const marker of ['vendor.localhost', 'testSiteOrigin', '127.0.0.1/*']) {
    if (text.includes(marker)) fail(`${file} contains "${marker}": this is a test build`);
  }
}

// ------------------------------------------------------------------ archive

const name = `${BRAND.slug}-extension-${version}`;
const stage = join(outDir, name);
const zip = join(outDir, `${name}.zip`);
mkdirSync(outDir, { recursive: true });
rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
cpSync(BUILD, stage, { recursive: true });

// The same bytes for the same commit: fixed modes and times, sorted entries.
function sourceDateEpoch() {
  const fromEnv = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const git = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' });
  const seconds = Number(git.stdout?.trim());
  return git.status === 0 && seconds > 0 ? seconds : Math.floor(Date.now() / 1000);
}
const epoch = sourceDateEpoch();
function normalize(path, isDirectory) {
  if (isDirectory) {
    for (const child of readdirSync(path, { withFileTypes: true })) {
      normalize(join(path, child.name), child.isDirectory());
    }
  }
  chmodSync(path, isDirectory ? 0o755 : 0o644);
  utimesSync(path, epoch, epoch);
}
normalize(stage, true);

const entries = listFiles(stage, name);
run('zip', ['-X', '-9', '-q', zip, '-@'], {
  cwd: outDir,
  env: { ...process.env, TZ: 'UTC' },
  input: `${entries.join('\n')}\n`,
  stdio: ['pipe', 'inherit', 'inherit'],
});
rmSync(stage, { recursive: true, force: true });

// What a user gets after unpacking: the manifest at the top of the one directory.
const listed = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
if (listed.error || listed.status !== 0) fail('cannot list the archive (unzip is required)');
const inside = listed.stdout.split('\n').filter((line) => line !== '');
for (const required of ['manifest.json', 'wall.html', 'content.js', 'worker.js', 'LICENSE']) {
  if (!inside.includes(`${name}/${required}`)) fail(`the archive has no ${name}/${required}`);
}

// ------------------------------------------------------------------ report

const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
console.log(`${digest}  ${basename(zip)}`);
console.log(`${inside.length} files; extension ID ${manifestId()}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `extension=${basename(zip)}\n`);
}

/** The ID Chromium derives from the manifest's key: the first 128 bits of its SHA-256, in a-p. */
function manifestId() {
  const der = Buffer.from(manifest.key, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return Array.from(hex, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}
