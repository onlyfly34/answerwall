// Inspects a packaged application and fails when it is not what it should be:
//
//   node scripts/verify-package.mjs [<unpacked application directory>]
//
// Without an argument it takes the one *-unpacked directory in release/.
// It checks that the archive holds the bundled scripts and nothing else of
// substance (no node_modules, no native module anywhere), that the files
// other processes read are real files next to it, that the update
// configuration names this repository and no publisher to verify, and that
// the executable's fuses are the shipped ones (so it fails for a copy that
// scripts/enable-inspector.mjs prepared for the tests).
//
// No dependencies: the archive's index and the fuses are read directly.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { hasFuses, readFuses } from './fuses.mjs';

const root = path.join(import.meta.dirname, '..');
const release = path.join(root, 'release');

function findUnpacked() {
  const candidates = existsSync(release)
    ? readdirSync(release).filter((name) => name.endsWith('-unpacked'))
    : [];
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one *-unpacked directory in release/, found ${candidates.length}; name it as an argument.`,
    );
  }
  return path.join(release, candidates[0]);
}

const appDir = path.resolve(process.argv[2] ?? findUnpacked());
const resources = path.join(appDir, 'resources');
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

/** The archive's index and a reader for its files. The format: two pickles, then the contents. */
function openAsar(file) {
  const buffer = readFileSync(file);
  const headerSize = buffer.readUInt32LE(4);
  const length = buffer.readUInt32LE(12);
  const index = JSON.parse(buffer.toString('utf8', 16, 16 + length));
  const base = 8 + headerSize;
  const entries = new Map();
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.files) walk(entry, full);
      else entries.set(full, entry);
    }
  };
  walk(index, '');
  return {
    entries,
    read(name) {
      const entry = entries.get(name);
      if (!entry || entry.unpacked) throw new Error(`${name} is not in the archive`);
      const start = base + Number(entry.offset);
      return buffer.subarray(start, start + entry.size);
    },
  };
}

function listFiles(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(path.join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

// The fuses as scripts/package.mjs sets them. What is shipped must not accept
// --inspect or NODE_OPTIONS; runAsNode stays on for the reaper.
const SHIPPED_FUSES = {
  runAsNode: 'on',
  enableNodeCliInspectArguments: 'off',
  enableNodeOptionsEnvironmentVariable: 'off',
  enableCookieEncryption: 'on',
  onlyLoadAppFromAsar: 'on',
  enableEmbeddedAsarIntegrityValidation: 'on',
  grantFileProtocolExtraPrivileges: 'off',
};
if (existsSync(appDir)) {
  // The executable is named after the product; it is the one file here with fuses.
  const executables = readdirSync(appDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[^.]+(\.exe)?$/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => hasFuses(readFileSync(path.join(appDir, name))));
  check(
    executables.length === 1,
    `expected one executable with fuses, found ${executables.length}: ${executables.join(', ')}`,
  );
  if (executables.length === 1) {
    const fuses = readFuses(readFileSync(path.join(appDir, executables[0])));
    for (const [name, expected] of Object.entries(SHIPPED_FUSES)) {
      check(fuses[name] === expected, `the fuse ${name} is ${fuses[name]}, not ${expected}`);
    }
    console.log(`Executable: ${executables[0]} (fuses as shipped: inspector off)`);
  }
}

const asarFile = path.join(resources, 'app.asar');
check(existsSync(asarFile), 'resources/app.asar is missing');
if (problems.length === 0) {
  const asar = openAsar(asarFile);
  const packed = [...asar.entries.keys()];
  const unpackedDir = path.join(resources, 'app.asar.unpacked');
  const unpacked = existsSync(unpackedDir) ? listFiles(unpackedDir) : [];
  const everything = [...listFiles(resources), ...packed];

  for (const needed of [
    'package.json',
    'dist/main.cjs',
    'dist/core-host.cjs',
    'dist/preload-local.cjs',
    'dist/preload-connection.cjs',
    'dist/icon.png',
  ]) {
    check(
      asar.entries.has(needed) && !asar.entries.get(needed).unpacked,
      `${needed} is not packed`,
    );
  }
  for (const needed of [
    'dist/reaper.cjs',
    'dist/connection/index.html',
    'dist/connection/connection.js',
    'dist/connection/connection.css',
    'dist/web/index.html',
    'dist/web/sw.js',
    'dist/licenses/THIRD-PARTY-LICENSES.txt',
  ]) {
    check(unpacked.includes(needed), `${needed} is not a real file beside the archive`);
  }

  // The scripts are bundles: nothing is resolved from node_modules at run time.
  const modules = everything.filter((name) => name.split('/').includes('node_modules'));
  check(modules.length === 0, `node_modules in the package: ${modules.slice(0, 5).join(', ')}`);
  // No native Node module, in the archive or beside it (docs/DECISIONS.md §4).
  const native = everything.filter((name) => /\.node$/i.test(name));
  check(native.length === 0, `native modules in the package: ${native.join(', ')}`);
  const stray = packed.filter((name) => name !== 'package.json' && !name.startsWith('dist/'));
  check(stray.length === 0, `unexpected files in the archive: ${stray.slice(0, 5).join(', ')}`);
  const sources = everything.filter((name) => /\.(ts|tsx|map)$/.test(name));
  check(
    sources.length === 0,
    `sources or source maps in the package: ${sources.slice(0, 5).join(', ')}`,
  );

  if (asar.entries.has('package.json')) {
    const manifest = JSON.parse(asar.read('package.json').toString('utf8'));
    const own = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    check(
      manifest.version === own.version,
      `packed version ${manifest.version} is not ${own.version}`,
    );
    check(manifest.main === 'dist/main.cjs', `packed main is ${manifest.main}`);
    check(
      Object.keys(manifest.dependencies ?? {}).length === 0,
      'the packed manifest lists run-time dependencies',
    );
  }

  const updateConfig = path.join(resources, 'app-update.yml');
  check(existsSync(updateConfig), 'resources/app-update.yml is missing');
  if (existsSync(updateConfig)) {
    const text = readFileSync(updateConfig, 'utf8');
    const repository = /github\.com\/([^/]+)\/([^/\s"']+)/.exec(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    check(/^provider: github$/m.test(text), 'the update provider is not GitHub');
    check(
      new RegExp(`^owner: ${repository?.[1]}$`, 'm').test(text) &&
        new RegExp(`^repo: ${repository?.[2]}$`, 'm').test(text),
      'the update configuration does not name this repository',
    );
    // Unsigned build: a publisher name here would make every update fail its check.
    check(!/publisherName/.test(text), 'the update configuration names a publisher');
  }

  const size = (files, dir) =>
    files.reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);
  console.log(`Application directory: ${appDir}`);
  console.log(
    `  archive: ${packed.length} files, ${(statSync(asarFile).size / 1e6).toFixed(1)} MB`,
  );
  console.log(
    `  beside the archive: ${unpacked.length} files, ${(size(unpacked, unpackedDir) / 1e6).toFixed(1)} MB`,
  );
}

// The installer and its update metadata, when they were built.
if (existsSync(release)) {
  for (const name of readdirSync(release).filter((entry) => /\.(exe|blockmap|yml)$/.test(entry))) {
    if (name.startsWith('builder-')) continue;
    console.log(`  ${name}: ${(statSync(path.join(release, name)).size / 1e6).toFixed(1)} MB`);
  }
  const latest = path.join(release, 'latest.yml');
  const installers = readdirSync(release).filter((entry) => entry.endsWith('.exe'));
  if (installers.length > 0) {
    check(existsSync(latest), 'latest.yml was not generated');
    check(installers.length === 1, `expected one installer, found ${installers.join(', ')}`);
    if (existsSync(latest)) {
      const text = readFileSync(latest, 'utf8');
      check(text.includes(installers[0]), 'latest.yml does not name the installer');
      check(/sha512: \S{80,}/.test(text), 'latest.yml carries no SHA-512');
    }
    check(
      existsSync(path.join(release, `${installers[0]}.blockmap`)),
      'the installer has no blockmap',
    );
  }
}

if (problems.length > 0) {
  console.error('The package is not as it should be:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('The package is as it should be.');
