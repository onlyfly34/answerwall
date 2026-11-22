// Fails when a forbidden package appears in any workspace manifest or in the lockfile.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORBIDDEN_PACKAGE_REGEX } from './forbidden-packages.mjs';

const root = join(import.meta.dirname, '..');
const forbidden = new RegExp(FORBIDDEN_PACKAGE_REGEX);
const problems = [];

const manifests = ['package.json', 'e2e/package.json'];
for (const group of ['packages', 'apps', 'tools']) {
  for (const name of readdirSync(join(root, group))) {
    manifests.push(`${group}/${name}/package.json`);
  }
}

for (const file of manifests.filter((candidate) => existsSync(join(root, candidate)))) {
  const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (forbidden.test(name)) problems.push(`${file}: ${field} lists ${name}`);
    }
  }
}

// Package entries in the lockfile look like `  '@scope/name@1.2.3':` or `  name@1.2.3:`.
const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
for (const match of lockfile.matchAll(/^ {2}'?((?:@[^/@'\s]+\/)?[^/@'\s]+)@/gm)) {
  if (forbidden.test(match[1])) problems.push(`pnpm-lock.yaml: resolves ${match[1]}`);
}

if (problems.length > 0) {
  console.error('Forbidden dependencies (see scripts/forbidden-packages.mjs):');
  for (const problem of new Set(problems)) console.error(`  ${problem}`);
  process.exit(1);
}
