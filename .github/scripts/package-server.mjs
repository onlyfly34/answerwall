#!/usr/bin/env node
// Packages the platform-neutral server bundle from an already built workspace.
//
//   node .github/scripts/package-server.mjs --out <dir> [--expect-version <x.y.z>]
//
// The bundle is one directory, shipped as a .tar.gz and a .zip:
//
//   package.json, package-lock.json   the production dependencies manifest
//   dist/                             the compiled server (apps/server)
//   packages/core/                    the compiled core library
//   packages/web/                     the built web UI
//   LICENSE, README.md
//
// It holds no node_modules. After extraction, `npm ci --omit=dev` installs
// the third-party packages and links the two bundled ones, and
// `node dist/main.js` starts the server.
//
// The lockfile is generated here with npm and then checked against
// pnpm-lock.yaml: every package must have the version that is installed in
// this workspace and the integrity that pnpm recorded, so the bundle ships
// exactly what the tests ran against.
//
// Needs GNU tar, zip and npm, and network access to the npm registry: it is
// meant for Linux. Run `pnpm install --frozen-lockfile` and `pnpm build` first.

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
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..', '..');
const REGISTRY = 'https://registry.npmjs.org/';

function fail(message) {
  console.error(`package-server: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) fail(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// ------------------------------------------------------------------ inputs

const { values: options } = parseArgs({
  options: { out: { type: 'string' }, 'expect-version': { type: 'string' } },
});
if (options.out === undefined) fail('--out <dir> is required');
const outDir = resolve(options.out);

const rootManifest = readJson(join(ROOT, 'package.json'));
const serverManifest = readJson(join(ROOT, 'apps/server/package.json'));
const coreManifest = readJson(join(ROOT, 'packages/core/package.json'));
const webManifest = readJson(join(ROOT, 'packages/web/package.json'));

const version = serverManifest.version;
const expected = options['expect-version'];
if (expected !== undefined && expected !== '' && expected !== version) {
  fail(`apps/server/package.json has version ${version}, expected ${expected}`);
}

for (const file of [
  'apps/server/dist/main.js',
  'packages/core/dist/index.js',
  'packages/web/dist/index.html',
]) {
  if (!existsSync(join(ROOT, file))) fail(`${file} is missing: run pnpm build`);
}

const [binName, binTarget] = Object.entries(serverManifest.bin)[0];
const bundleName = `${rootManifest.name}-server-${version}`;
const stage = join(outDir, bundleName);

// --------------------------------------- what the workspace has installed

/** The directory of `name` as Node would resolve it from `fromDir`, if installed. */
function findInstalled(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate =
      basename(dir) === 'node_modules' ? join(dir, name) : join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** Every third-party package the manifest at `startDir` needs in production: name → version. */
function productionClosure(startDir) {
  const closure = new Map();
  const seen = new Set();
  const visit = (dir, manifest, isStart) => {
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...(isStart ? [] : Object.keys(manifest.peerDependencies ?? {})),
    ]);
    for (const name of names) {
      const found = findInstalled(dir, name);
      if (found === undefined) {
        if (manifest.dependencies?.[name] !== undefined) {
          fail(`${name}, needed by ${manifest.name}, is not installed: run pnpm install`);
        }
        continue;
      }
      if (seen.has(found)) continue;
      seen.add(found);
      const child = readJson(join(found, 'package.json'));
      const known = closure.get(name);
      if (known !== undefined && known !== child.version) {
        fail(
          `${name} is installed as ${known} and as ${child.version}; ` +
            'the bundle needs one version of each production package',
        );
      }
      closure.set(name, child.version);
      visit(found, child, false);
    }
  };
  visit(startDir, readJson(join(startDir, 'package.json')), true);
  return closure;
}

const closure = productionClosure(join(ROOT, 'packages/core'));
const direct = coreManifest.dependencies ?? {};
for (const [name, range] of Object.entries(direct)) {
  if (closure.get(name) !== range) {
    fail(`packages/core pins ${name}@${range} but ${closure.get(name)} is installed`);
  }
}

// ------------------------------------------------------------------- stage

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'packages/core'), { recursive: true });
mkdirSync(join(stage, 'packages/web'), { recursive: true });

cpSync(join(ROOT, 'apps/server/dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(ROOT, 'packages/core/dist'), join(stage, 'packages/core/dist'), { recursive: true });
cpSync(join(ROOT, 'packages/web/dist'), join(stage, 'packages/web/dist'), { recursive: true });
cpSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'));

/** The export map without the condition that points at the TypeScript sources. */
function compiledExports(exportMap) {
  return Object.fromEntries(
    Object.entries(exportMap).map(([entry, target]) => [
      entry,
      typeof target === 'string'
        ? target
        : Object.fromEntries(Object.entries(target).filter(([, file]) => !file.includes('/src/'))),
    ]),
  );
}

writeJson(join(stage, 'packages/core/package.json'), {
  name: coreManifest.name,
  version,
  private: true,
  license: coreManifest.license,
  type: coreManifest.type,
  sideEffects: coreManifest.sideEffects,
  exports: compiledExports(coreManifest.exports),
  dependencies: direct,
});
writeJson(join(stage, 'packages/web/package.json'), {
  name: webManifest.name,
  version,
  private: true,
  license: webManifest.license,
  type: webManifest.type,
  exports: webManifest.exports,
});

// Transitive packages are pinned through `overrides`, so that npm resolves the
// versions pnpm installed instead of the newest ones the ranges allow.
const overrides = Object.fromEntries(
  [...closure].filter(([name]) => direct[name] === undefined).sort(([a], [b]) => (a < b ? -1 : 1)),
);
writeJson(join(stage, 'package.json'), {
  name: serverManifest.name,
  version,
  private: true,
  description: rootManifest.description,
  license: serverManifest.license,
  repository: rootManifest.repository,
  type: serverManifest.type,
  bin: { [binName]: binTarget },
  engines: rootManifest.engines,
  scripts: { start: `node ${binTarget.replace(/^\.\//, '')}` },
  dependencies: {
    [coreManifest.name]: 'file:./packages/core',
    [webManifest.name]: 'file:./packages/web',
  },
  overrides,
});

const entry = binTarget.replace(/^\.\//, '');
writeFileSync(
  join(stage, 'README.md'),
  `# ${bundleName}

The server, compiled, with the web UI. Nothing in it is specific to one
operating system; it needs Node ${rootManifest.engines.node}.

\`\`\`
npm ci --omit=dev
node ${entry} --help
node ${entry}
\`\`\`

\`npm ci\` installs the third-party packages listed in \`package-lock.json\`;
nothing is compiled. Every option is described in the server README of the
repository (${rootManifest.repository}).
`,
);

// ---------------------------------------------------------------- lockfile

run(
  'npm',
  [
    'install',
    '--package-lock-only',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `--registry=${REGISTRY}`,
  ],
  { cwd: stage, env: { ...process.env, npm_config_update_notifier: 'false' } },
);

// Package entries in pnpm-lock.yaml: `  name@1.2.3:` followed by the resolution line.
const pnpmIntegrity = new Map();
for (const match of readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8').matchAll(
  /^ {2}'?([^\s':]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm,
)) {
  pnpmIntegrity.set(match[1], match[2]);
}

const lock = readJson(join(stage, 'package-lock.json'));
const problems = [];
const locked = new Set();
for (const [path, node] of Object.entries(lock.packages)) {
  const marker = path.lastIndexOf('node_modules/');
  if (marker === -1 || node.link === true) continue;
  const name = path.slice(marker + 'node_modules/'.length);
  const id = `${name}@${node.version}`;
  locked.add(name);
  if (closure.get(name) !== node.version) {
    problems.push(`${id}: the workspace has ${closure.get(name) ?? 'no such package'} installed`);
  } else if (pnpmIntegrity.get(id) !== node.integrity) {
    problems.push(`${id}: integrity differs from pnpm-lock.yaml`);
  } else if (!String(node.resolved).startsWith(REGISTRY)) {
    problems.push(`${id}: resolved from ${node.resolved}`);
  }
  if (node.hasInstallScript === true) problems.push(`${id}: has an install script`);
}
for (const name of Object.keys(direct)) {
  if (!locked.has(name)) problems.push(`${name}: missing from the generated lockfile`);
}
if (problems.length > 0) {
  fail(`the generated package-lock.json does not match the workspace:\n  ${problems.join('\n  ')}`);
}

// ---------------------------------------------------------------- archives

// Fixed modes and times make the archives reproducible for a given commit.
function sourceDateEpoch() {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH);
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
  chmodSync(path, isDirectory || path === join(stage, entry) ? 0o755 : 0o644);
  utimesSync(path, epoch, epoch);
}
normalize(stage, true);

const tarGz = join(outDir, `${bundleName}.tar.gz`);
const zip = join(outDir, `${bundleName}.zip`);
rmSync(tarGz, { force: true });
rmSync(zip, { force: true });

const tar = spawnSync(
  'tar',
  [
    '--create',
    '--format=gnu',
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    `--mtime=@${epoch}`,
    '--directory',
    outDir,
    bundleName,
  ],
  { maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
);
if (tar.error || tar.status !== 0) {
  fail(`tar failed (GNU tar is required): ${tar.error?.message ?? tar.status}`);
}
writeFileSync(tarGz, gzipSync(tar.stdout, { level: 9 }));

// zip stores local times: UTC keeps them the same on every machine. Sorted
// names on stdin fix the entry order; -X leaves out owner and extra time fields.
function listFiles(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((child) =>
      child.isDirectory()
        ? listFiles(join(dir, child.name), `${prefix}/${child.name}`)
        : [`${prefix}/${child.name}`],
    );
}
run('zip', ['-X', '-9', '-q', zip, '-@'], {
  cwd: outDir,
  env: { ...process.env, TZ: 'UTC' },
  input: `${listFiles(stage, bundleName).join('\n')}\n`,
  stdio: ['pipe', 'inherit', 'inherit'],
});

// ------------------------------------------------------------------ report

for (const file of [tarGz, zip]) {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  console.log(`${digest}  ${basename(file)}`);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nbundle=${bundleName}\n`);
}
