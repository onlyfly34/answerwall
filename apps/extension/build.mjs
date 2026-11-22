#!/usr/bin/env node
// Builds the browser extension into a directory that Chrome or Edge loads
// unpacked:
//
//   manifest.json   written from manifest.mjs
//   wall.html       the wall page: the web UI of packages/web, built from source
//   content.js      the content script (one classic script, no imports)
//   worker.js       the service worker
//   icon-192.png, LICENSE
//
//   node build.mjs                      -> dist/
//   node build.mjs --out <dir>
//   node build.mjs --out <dir> --test   the test build, with the stand-in site
//
// The test build is for the automated tests only: it also frames
// http://vendor.localhost, and may reach a server on 127.0.0.1 without the
// permission prompt. A release build must not contain any of that; the check
// at the end fails the build if it does.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build, defaultClientConditions } from 'vite';
import solid from 'vite-plugin-solid';
import { buildManifest } from './manifest.mjs';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '..', '..');
const TEST_SITE = 'standin';
/** What only the test build may contain. */
const TEST_ONLY = ['vendor.localhost', 'testSiteOrigin'];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The site rules, by file name without extension. */
export function readRules() {
  const dir = join(HERE, 'rules');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => [name.slice(0, -'.json'.length), readJson(join(dir, name))]),
  );
}

/** The version every package of the workspace carries (scripts/check-versions.mjs). */
export function workspaceVersion() {
  const version = readJson(join(ROOT, 'package.json')).version;
  const own = readJson(join(HERE, 'package.json')).version;
  if (own !== version) {
    throw new Error(`apps/extension has version ${own}, the workspace ${version}`);
  }
  return version;
}

function filesIn(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesIn(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/**
 * @param {{ outDir?: string, test?: boolean, logLevel?: 'info' | 'warn' | 'silent' }} [options]
 * @returns {Promise<{ outDir: string, version: string, files: string[] }>}
 */
export async function buildExtension(options = {}) {
  const outDir = resolve(options.outDir ?? join(HERE, 'dist'));
  const test = options.test === true;
  const logLevel = options.logLevel ?? 'warn';
  const version = workspaceVersion();
  const rules = readRules();
  const { BRAND } = await import(new URL('../../packages/core/src/brand.ts', import.meta.url).href);

  const shared = {
    configFile: false,
    logLevel,
    root: HERE,
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __TEST_SITE__: JSON.stringify(test),
    },
    // Workspace packages are built from their TypeScript sources.
    resolve: { conditions: ['answerwall-source', ...defaultClientConditions] },
  };
  /** One classic script without imports: what a content script and a worker are loaded as. */
  const script = (entry, fileName) =>
    build({
      ...shared,
      publicDir: false,
      build: {
        outDir,
        emptyOutDir: false,
        target: 'es2023',
        lib: {
          entry: join(HERE, entry),
          formats: ['iife'],
          name: 'answerwall',
          fileName: () => fileName,
        },
      },
    });

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await build({
    ...shared,
    base: './',
    publicDir: false,
    plugins: [
      solid(),
      {
        name: 'brand-html',
        transformIndexHtml: (html) => html.replaceAll('%BRAND_NAME%', BRAND.name),
      },
    ],
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2023',
      rollupOptions: { input: join(HERE, 'wall.html') },
    },
  });
  await script('src/content/main.ts', 'content.js');
  await script('src/worker/main.ts', 'worker.js');

  const hosts = Object.entries(rules)
    .filter(([name]) => name !== TEST_SITE)
    .map(([, rule]) => rule.host);
  const manifest = buildManifest({
    name: BRAND.name,
    version,
    hosts,
    ...(test ? { test: { host: rules[TEST_SITE].host, serverPattern: 'http://127.0.0.1/*' } } : {}),
  });
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(ROOT, 'packages/web/public/icon-192.png'), join(outDir, 'icon-192.png'));
  cpSync(join(ROOT, 'LICENSE'), join(outDir, 'LICENSE'));

  const files = filesIn(outDir).sort();
  for (const required of ['manifest.json', 'wall.html', 'content.js', 'worker.js']) {
    if (!files.includes(required)) throw new Error(`The build has no ${required}`);
  }
  if (!test) {
    for (const file of files.filter((name) => /\.(js|json|html|css)$/.test(name))) {
      const text = readFileSync(join(outDir, file), 'utf8');
      const found = TEST_ONLY.find((marker) => text.includes(marker));
      if (found)
        throw new Error(`${file} contains "${found}", which belongs to the test build only`);
    }
  }
  return { outDir, version, files };
}

// Run as a script, not imported. Windows may spell the drive letter either way.
const invoked = resolve(process.argv[1] ?? '');
const self = fileURLToPath(import.meta.url);
if (invoked === self || invoked.toLowerCase() === self.toLowerCase()) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, test: { type: 'boolean', default: false } },
  });
  const result = await buildExtension({
    ...(values.out === undefined ? {} : { outDir: values.out }),
    test: values.test,
  });
  console.log(
    `Built the extension ${result.version}${values.test ? ' (test build)' : ''}: ${result.files.length} files in ${result.outDir}`,
  );
}
