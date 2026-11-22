// Every package of the workspace carries the version of the root package.json,
// the one place a release changes it (docs/RELEASING.md). Run by `pnpm lint`.
//
//   node scripts/check-versions.mjs                     the packages agree
//   node scripts/check-versions.mjs --expect 1.2.3      ... and have this version
//   node scripts/check-versions.mjs --set 1.2.3         write it into every package.json
//
// The release workflow runs it with --expect before it builds anything, so a
// tag that does not match the packages fails at once and says which file is off.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const root = join(import.meta.dirname, '..');
const { values: options } = parseArgs({
  options: { expect: { type: 'string' }, set: { type: 'string' } },
});

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const manifests = ['package.json', 'e2e/package.json'];
for (const group of ['apps', 'packages', 'tools']) {
  for (const name of readdirSync(join(root, group)).sort()) {
    manifests.push(`${group}/${name}/package.json`);
  }
}
const files = manifests.filter((file) => existsSync(join(root, file)));

if (options.set !== undefined) {
  if (!SEMVER.test(options.set)) {
    console.error(
      `check-versions: "${options.set}" is not <major>.<minor>.<patch>[-<pre-release>].`,
    );
    process.exit(2);
  }
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const updated = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${options.set}"`);
    if (updated === text && !text.includes(`"version": "${options.set}"`)) {
      console.error(`check-versions: ${file} has no "version" field.`);
      process.exit(1);
    }
    writeFileSync(join(root, file), updated);
  }
  console.log(`Set version ${options.set} in ${files.length} package.json files.`);
}

const versions = files.map((file) => ({
  file,
  version: JSON.parse(readFileSync(join(root, file), 'utf8')).version,
}));
const expected = options.expect ?? versions[0].version;
const wrong = versions.filter(({ version }) => version !== expected);

if (wrong.length > 0) {
  const source = options.expect === undefined ? 'the root package.json' : 'the release tag';
  console.error(`Package versions do not match ${source} (${expected}):`);
  for (const { file, version } of wrong) console.error(`  ${file}: ${version ?? '(none)'}`);
  console.error(`Fix with: node scripts/check-versions.mjs --set ${expected}`);
  process.exit(1);
}
console.log(`All ${versions.length} packages have version ${expected}.`);
