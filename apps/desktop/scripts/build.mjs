// Builds everything the app runs from into dist/: the bundled main process,
// core host, reaper and preloads, the connection page, a copy of the built
// web UI, the icon and the licences of the bundled packages.
//
// Every script is one self-contained file. Nothing in dist/ needs
// node_modules, so the packaged app carries none: no symlinks of the
// workspace to follow and no native module to rebuild.
//
// Run with `--conditions=answerwall-source` (the package scripts do), so that
// workspace packages resolve to their TypeScript sources.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { writeLicences } from './licences.mjs';

const root = path.join(import.meta.dirname, '..');
const repository = path.join(root, '..', '..');
const dist = path.join(root, 'dist');
const webDist = path.join(repository, 'packages', 'web', 'dist');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const own = readJson(path.join(root, 'package.json'));
const server = readJson(path.join(repository, 'apps', 'server', 'package.json'));

// The web UI carries the server's version and refuses to run against another one.
if (own.version !== server.version) {
  console.error(
    `apps/desktop is version ${own.version} but apps/server is ${server.version}: set both to the same version.`,
  );
  process.exit(1);
}
if (!existsSync(path.join(webDist, 'index.html'))) {
  console.error('packages/web/dist is missing: run `pnpm --filter @answerwall/web build` first.');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const node = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // The Node.js inside the pinned Electron.
  target: 'node24',
  conditions: ['answerwall-source'],
  external: ['electron'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
};

const results = await Promise.all([
  build({
    ...node,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(dist, 'main.cjs'),
  }),
  build({
    ...node,
    entryPoints: [path.join(root, 'src/core-host/index.ts')],
    outfile: path.join(dist, 'core-host.cjs'),
  }),
  build({
    ...node,
    entryPoints: [path.join(root, 'src/core-host/reaper.ts')],
    outfile: path.join(dist, 'reaper.cjs'),
  }),
  build({
    ...node,
    entryPoints: [path.join(root, 'src/preload/local.ts')],
    outfile: path.join(dist, 'preload-local.cjs'),
  }),
  build({
    ...node,
    entryPoints: [path.join(root, 'src/preload/connection.ts')],
    outfile: path.join(dist, 'preload-connection.cjs'),
  }),
  build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    conditions: ['answerwall-source'],
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
    entryPoints: [path.join(root, 'src/connection/connection.ts')],
    outfile: path.join(dist, 'connection', 'connection.js'),
  }),
]);

for (const file of ['index.html', 'connection.css']) {
  cpSync(path.join(root, 'src', 'connection', file), path.join(dist, 'connection', file));
}
// Without the source maps: nothing in the installed app reads them.
cpSync(webDist, path.join(dist, 'web'), {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
});
cpSync(path.join(root, 'build', 'icon.png'), path.join(dist, 'icon.png'));

const bundled = results.flatMap((result) => Object.keys(result.metafile.inputs));
const count = writeLicences({
  repository,
  bundledInputs: bundled.map((input) => path.resolve(root, input)),
  // The web UI is built by Vite; what it bundles is its production dependency tree.
  dependencyRoots: [path.join(repository, 'packages', 'web')],
  out: path.join(dist, 'licenses', 'THIRD-PARTY-LICENSES.txt'),
});

console.log(`Built dist/ for version ${own.version} (licences of ${count} packages).`);
