// Collects the licence texts of every package whose code ends up in the app:
// the packages esbuild bundled (from its metafile) and the production
// dependency tree of the web UI. Fails when a package has no licence file, so
// that nothing ships without its notice.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The package directory an input file belongs to, or `undefined` for workspace sources. */
function packageDirOf(file) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = file.lastIndexOf(marker);
  if (at === -1) return undefined;
  const [first, second] = file.slice(at + marker.length).split(path.sep);
  const name = first.startsWith('@') ? path.join(first, second) : first;
  return path.join(file.slice(0, at + marker.length), name);
}

/** The production dependencies of the package in `dir`, followed through the workspace's links. */
function dependencyTree(dir, seen = new Map()) {
  const real = realpathSync(dir);
  if (seen.has(real)) return seen;
  const manifest = readJson(path.join(real, 'package.json'));
  seen.set(real, manifest);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    // pnpm puts a package's dependencies next to it or in its own node_modules.
    const candidates = [
      path.join(real, 'node_modules', name),
      path.join(real, '..', name),
      path.join(real, '..', '..', name),
    ];
    const found = candidates.find((candidate) => existsSync(path.join(candidate, 'package.json')));
    if (!found) throw new Error(`Cannot find ${name}, a dependency of ${manifest.name}`);
    dependencyTree(found, seen);
  }
  return seen;
}

/**
 * Packages that publish no licence file, with the licence their manifest
 * declares. Checked by hand; a package missing here stops the build.
 */
const WITHOUT_TEXT = {
  'lazy-val': 'MIT',
};

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

function licenceTexts(dir) {
  return readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8').trim());
}

/** Writes the notices file and returns the number of third-party packages in it. */
export function writeLicences({ repository, bundledInputs, dependencyRoots, out }) {
  const packages = new Map();
  for (const input of bundledInputs) {
    const dir = packageDirOf(input);
    if (dir && existsSync(path.join(dir, 'package.json'))) packages.set(realpathSync(dir), null);
  }
  for (const root of dependencyRoots) {
    for (const dir of dependencyTree(root).keys()) packages.set(dir, null);
  }

  const sections = [];
  const missing = [];
  for (const dir of packages.keys()) {
    const manifest = readJson(path.join(dir, 'package.json'));
    // The workspace's own packages are covered by the project's licence above.
    if (manifest.private === true) continue;
    const texts = licenceTexts(dir);
    if (texts.length === 0) {
      const declared = WITHOUT_TEXT[manifest.name];
      if (declared === undefined || declared !== manifest.license) {
        missing.push(`${manifest.name}@${manifest.version}`);
        continue;
      }
      const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
      const home = manifest.homepage ?? manifest.repository?.url ?? manifest.repository;
      texts.push(
        [
          `Released under the ${declared} licence; the package ships no licence text.`,
          ...(author ? [`Author: ${author}`] : []),
          ...(typeof home === 'string' ? [`Source: ${home}`] : []),
        ].join('\n'),
      );
    }
    sections.push({
      title: `${manifest.name} ${manifest.version} (${manifest.license ?? 'see below'})`,
      text: texts.join('\n\n'),
    });
  }
  if (missing.length > 0) {
    throw new Error(`No licence file found for: ${missing.join(', ')}`);
  }
  sections.sort((a, b) => a.title.localeCompare(b.title, 'en'));

  const rule = '='.repeat(78);
  const own = readFileSync(path.join(repository, 'LICENSE'), 'utf8').trim();
  const document = [
    'This application',
    rule,
    own,
    '',
    'Electron and Chromium',
    rule,
    'The application runs on Electron, which includes Chromium and Node.js. Their',
    'licences are the files LICENSE.electron.txt and LICENSES.chromium.html in the',
    "application's installation directory.",
    '',
    ...sections.flatMap((section) => [section.title, rule, section.text, '']),
  ].join('\n');

  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, document);
  return sections.length;
}
