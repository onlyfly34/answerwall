// Packages dist/ with electron-builder. Run `build` first.
//
//   node --conditions=answerwall-source scripts/package.mjs [--dir] [--expect-version <v>]
//
// Default: the Windows installer (NSIS, x64) with its update metadata, in
// release/. `--dir` only assembles the unpacked application for the platform
// this runs on (release/<platform>-unpacked), which is what the end-to-end
// tests start on Linux. Nothing is ever published from here.
//
// The configuration lives in this file rather than in package.json so that
// every name in it comes from the brand module.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { APP } from '../src/shared/app-info.ts';

const root = path.join(import.meta.dirname, '..');
const repository = path.join(root, '..', '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const manifest = readJson(path.join(root, 'package.json'));
const electron = readJson(path.join(root, 'node_modules', 'electron', 'package.json'));

const args = process.argv.slice(2);
const dirOnly = args.includes('--dir');
const expected = args.includes('--expect-version')
  ? args[args.indexOf('--expect-version') + 1]
  : '';
if (expected && expected !== manifest.version) {
  console.error(`apps/desktop is version ${manifest.version}, expected ${expected}.`);
  process.exit(1);
}
if (!existsSync(path.join(root, 'dist', 'main.cjs'))) {
  console.error('dist/ is missing: run `pnpm --filter @answerwall/desktop build` first.');
  process.exit(1);
}

/** The file names the release workflow publishes; `latest.yml` names the installer. */
const installerName = `${APP.slug}-desktop-\${version}-windows-x64-setup.\${ext}`;

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: APP.id,
  productName: APP.name,
  copyright: `Copyright (c) ${manifest.author}`,
  // The version this workspace pins and the tests ran with; never a newer one.
  electronVersion: electron.version,
  directories: { output: 'release', buildResources: 'build' },

  // dist/ is self-contained (see scripts/build.mjs): no node_modules is packed.
  files: ['dist/**/*', 'package.json'],
  asar: true,
  // Read by other processes or programs, which need real files: the web UI
  // (served by the core host), the reaper (started with plain Node semantics)
  // and the licences (opened in the system's text viewer).
  asarUnpack: ['dist/web/**', 'dist/reaper.cjs', 'dist/licenses/**'],
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  // The manifest in the package needs no scripts and no dependency lists.
  removePackageScripts: true,
  removePackageKeywords: true,

  electronFuses: {
    // On: the reaper runs this executable as plain Node (ELECTRON_RUN_AS_NODE).
    runAsNode: true,
    // On: the end-to-end tests drive the packaged app through the inspector.
    enableNodeCliInspectArguments: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableCookieEncryption: true,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
    grantFileProtocolExtraPrivileges: false,
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    // The build is not code-signed, so an update cannot be checked against a
    // publisher. Stated explicitly: the updater relies on the SHA-512 in
    // latest.yml, fetched over HTTPS from the same GitHub release.
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    artifactName: installerName,
    // An installer with pages: it shows the licence and where it installs.
    oneClick: false,
    // For the current user by default, without administrator rights; the
    // installer offers "for all users" as the other choice.
    perMachine: false,
    selectPerMachineByDefault: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: false,
    license: path.join(repository, 'LICENSE'),
    installerLanguages: ['en_US', 'zh_TW'],
    shortcutName: APP.name,
    uninstallDisplayName: APP.name,
    // Uninstalling keeps history and settings; removing them is the user's decision.
    deleteAppDataOnUninstall: false,
  },
  linux: { target: [{ target: 'dir' }], icon: 'build/icon.png', executableName: APP.slug },

  // Always `latest.yml`, also for a pre-release version: the app follows no other channel.
  detectUpdateChannel: false,
  // Only for the update metadata (latest.yml, app-update.yml): the one place
  // the installed app looks for updates. Uploading is the release workflow's job.
  publish: [
    {
      provider: 'github',
      owner: APP.repository.owner,
      repo: APP.repository.name,
      releaseType: 'release',
    },
  ],
};

const targets = dirOnly
  ? Platform.current().createTarget('dir')
  : Platform.WINDOWS.createTarget('nsis', Arch.x64);

const written = await build({ targets, config, projectDir: root, publish: 'never' });
for (const file of written) console.log(path.relative(root, file));
