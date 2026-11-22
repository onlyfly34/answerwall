# Releasing

How a release is made, what the workflows in `.github/workflows` do, and
what to check after a tag. The decisions behind this are in
[DECISIONS.md](DECISIONS.md) §10.

## Workflows

| File            | Runs on                                       | Does                                                                                                                                                                                                        |
| --------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`        | push to `main`, pull requests, manual run     | typecheck, lint, unit tests, build and `pnpm smoke:mock` on Linux and Windows; the end-to-end tests on both; and the three reusable workflows below, without publishing                                     |
| `build.yml`     | called by `ci.yml` and `release.yml`          | builds the workspace, packages the server bundle and the browser extension, starts the packaged server archives with plain Node on Linux and Windows                                                        |
| `desktop.yml`   | called by `ci.yml` and `release.yml`; by hand | builds the NSIS installer on `windows-latest`, installs it for the current user, runs the desktop end-to-end tests against the installed app, uninstalls it; Linux: the same tests against the unpacked app |
| `docker.yml`    | called by `ci.yml` and `release.yml`          | builds the image on an amd64 and an arm64 runner and tests it (`docker/test/smoke.mjs`); with `push`, pushes both by digest to GHCR and tags the multi-architecture manifest                                |
| `release.yml`   | push of a tag `v*`, manual run                | checks the versions, runs `ci.yml` (without its artifact jobs), builds every asset and the image, and for a tag publishes the GitHub Release                                                                |
| `actions/setup` | used by the jobs above                        | pnpm from `packageManager`, Node from `.nvmrc`, `pnpm install --frozen-lockfile`                                                                                                                            |

No workflow uses a secret other than the token GitHub issues to each run, and
none starts a real AI command-line tool: the providers are the mocks in
`tools/mock-clis` and a stub endpoint on loopback. Every job has a read-only
token except, in `release.yml` for a tag, `publish` (`contents: write`) and
the two image publishing jobs of `docker.yml` (`packages: write`, inherited
from the `container` job that calls it). A build-only call of `docker.yml`
grants nothing beyond `contents: read`.

Actions are pinned to a commit, with the version in a comment. Dependabot
(`.github/dependabot.yml`) proposes updates of the actions and of the image's
base images (`apps/server/Dockerfile`) weekly. It does not touch npm
packages; those are pinned and checked by hand.

The end-to-end tests run on Linux and on Windows, and both runs are binding.
In CI the responsiveness test allows a main-thread task of one second
(`E2E_MAX_LONG_TASK_MS` in `ci.yml`) instead of the 500 ms of a developer
machine, because the hosted runners share four cores among four workers.

## Versions

The root `package.json` holds the version; every package of the workspace
carries the same one. `node scripts/check-versions.mjs` fails when they
differ and runs as part of `pnpm lint`. To change it everywhere:

```
node scripts/check-versions.mjs --set 0.1.0-rc.1
```

A release tag is `v` followed by exactly that version: `v0.1.0-rc.1` needs
`0.1.0-rc.1` in the packages, `v0.1.0` needs `0.1.0`. The first job of the
release workflow (`plan`) checks this before anything is built and fails with
the list of files that differ. The server reports its version in
`GET /api/meta`, the installer and `latest.yml` carry it, and the image is
labelled with it, so a pre-release and the final release must not share one.

A tag must be `v<major>.<minor>.<patch>`, optionally followed by a hyphen and
a pre-release identifier. A tag with a hyphen is published as a GitHub
pre-release: it does not become the latest release, its image gets only the
full version tag (never `<major>.<minor>` or `latest`), and the installed
desktop app does not offer it as an update.

Which floating tags a release moves depends on the tags that exist
(`.github/scripts/release-plan.mjs`, tested in
`tools/mock-clis/src/release-workflow.test.ts`): `latest`, and GitHub's
"Latest" mark, only when no higher release exists; `<major>.<minor>` only
when no higher patch of that line exists. Tagging `v0.1.1` after `v0.2.0`
therefore sets `0.1.1` and `0.1` and leaves `latest` on `0.2.0`, so
`docker compose pull` never goes back to an older image.

## What a tag produces

For version `X` (for example `0.1.0` or `0.1.0-rc.1`), the GitHub Release
holds exactly these assets:

| Asset                                                 | From                                             |
| ----------------------------------------------------- | ------------------------------------------------ |
| `answerwall-server-X.tar.gz`                          | `build.yml` (server bundle)                      |
| `answerwall-server-X.zip`                             | `build.yml` (the same bundle)                    |
| `answerwall-extension-X.zip`                          | `build.yml` (browser extension, loaded unpacked) |
| `answerwall-desktop-X-windows-x64-setup.exe`          | `desktop.yml` (NSIS installer, x64, unsigned)    |
| `answerwall-desktop-X-windows-x64-setup.exe.blockmap` | `desktop.yml` (for differential updates)         |
| `latest.yml`                                          | `desktop.yml` (what the installed app reads)     |
| `SHA256SUMS`                                          | `release.yml` (`assets` job, over all the above) |

and GHCR holds the image `ghcr.io/onlyfly34/answerwall` for `linux/amd64`
and `linux/arm64` under the tags `X`, `<major>.<minor>` and `latest` (a
pre-release: only `X`; a release of an older line: without `latest`, see
above). The release notes start with the image reference and
its digest, followed by GitHub's generated notes.

## Structure of the release workflow

```
plan ──┬─► verify (ci.yml, no artifact jobs) ─────────────┐
       ├─► build (build.yml) ─────────┐                   │
       ├─► windows-installer ─────────┴─► assets ─┬───────┤
       │   (desktop.yml)                          │       │
       └──────────────────────────────────────────┴─► container ─► publish
                                                      (docker.yml)
```

- `plan` checks out the repository and runs
  `.github/scripts/release-plan.mjs`: publish or build only, the version,
  pre-release or not, the image tags, "Latest" or not. Only the push of a
  tag publishes; a manual run is build only whichever ref it was started
  on, a tag included. For a release it then asks GitHub whether the tag
  already has a published release and fails if so, before any job builds or
  pushes anything, and runs `scripts/check-versions.mjs --expect`. A manual
  run only checks that the packages agree.
- `verify` is `ci.yml` with `skip-artifacts`: the bundle, desktop and image
  jobs are left out because the jobs below build and test them themselves.
- `build` is `build.yml`; its artifact `release-server-bundle` holds the two
  server archives and the extension's zip, and it fails when
  `apps/server/package.json` or `apps/extension/package.json` is not the
  tagged version.
- `windows-installer` is `desktop.yml` with
  `artifact-name: release-windows-installer`: the installer is built,
  installed and tested on `windows-latest` before it is uploaded, and the
  build refuses another version than the tag.
- `assets` downloads every artifact whose name starts with `release-`,
  checks that exactly one bundle pair, extension zip, installer, blockmap and
  `latest.yml` are there, writes `SHA256SUMS` and uploads the result as the artifact
  `assets`.
- `container` is `docker.yml`. It waits for `verify` and `assets`, so an
  image is never pushed for a release whose tests or assets failed. For a tag
  it builds and tests each architecture, pushes by digest (artifacts named
  `digest-<arch>`, which deliberately do not start with `release-`), creates
  the manifest with the tags `plan` chose and checks that both platforms are
  in it. For a manual run it builds and tests only.
- `publish` runs for tags only, after all of the above. It creates the
  release as a draft with generated notes, uploads every asset, compares the
  uploaded names with the built ones, and only then publishes, stating
  whether the release is "Latest". If a run fails half-way, the draft stays
  invisible to visitors; running the jobs again replaces the draft (the tag
  stays), so its notes name the image digest of the run that publishes it.
  A release that is already published is never modified, and its image is
  never rebuilt: `plan` refuses the tag, also when the workflow is run again
  or the tag is pushed again. Fix the problem and tag a new version.

To add a build job: depend on `plan`, upload the files to release as an
artifact named `release-<something>`, and list the job in `needs` of
`assets` (and add its file pattern to the check there). File names must be
unique across all jobs, because the artifacts are merged into one directory.

## Cutting v0.2.0-rc.1, then v0.2.0

`v0.1.0-rc.1` was the first tag; it was released without the browser
extension, so it has six assets. The next tag is `v0.2.0-rc.1`, whose
version is already on `main`.

Once, if it has not been done yet:

- **Private vulnerability reporting.** `docs/security.md` sends reports to
  **Security > Report a vulnerability**; that button exists only when
  private vulnerability reporting is enabled in the repository settings
  (Settings > Code security). It is off at the time of writing.

### 1. The release candidate

1. On an up-to-date `main` with a green CI run:

   ```
   node scripts/check-versions.mjs --set 0.2.0-rc.1
   pnpm install --frozen-lockfile && pnpm lint
   git commit -s -am "chore(release): 0.2.0-rc.1"
   git push origin main
   ```

2. Wait until CI on that commit is green (every job, including
   `Desktop / Windows installer` and both `Container / Build` legs).
3. Optional dry run: Actions > Release > Run workflow on `main`. It builds and
   tests everything and pushes nothing; the artifact `assets` holds exactly
   the files the tag will release. (A manual run pushes nothing on any ref,
   also on an existing tag.)
4. Tag that commit and push the tag:

   ```
   git tag -a v0.2.0-rc.1 -m "v0.2.0-rc.1"
   git push origin v0.2.0-rc.1
   ```

5. After the Release workflow is green, check:
   - The release `v0.2.0-rc.1` is published, marked **Pre-release**, not
     **Latest**, and lists the seven assets of the table above with `0.2.0-rc.1`
     in their names.
   - `sha256sum --check SHA256SUMS` passes for the downloaded assets.
   - `latest.yml` names `answerwall-desktop-0.2.0-rc.1-windows-x64-setup.exe`
     with `version: 0.2.0-rc.1`.
   - GHCR: the package `answerwall` is public. **The first push created it
     private:** if it still is, in the package settings (Profile > Packages >
     answerwall > Package settings) change its visibility to public once, and
     check that it is linked to this repository. Then, without logging in:
     `docker buildx imagetools inspect ghcr.io/onlyfly34/answerwall:0.2.0-rc.1`
     lists `linux/amd64` and `linux/arm64`, and the tags `0.2` and `latest`
     do not exist yet (no final release has been made).
   - `docker run --rm ghcr.io/onlyfly34/answerwall:0.2.0-rc.1 --version`
     prints `0.2.0-rc.1`.
   - The server bundle: extract `answerwall-server-0.2.0-rc.1.tar.gz`,
     `npm ci --omit=dev`, `node dist/main.js --version`.
   - On a real Windows PC, walk through
     [verify-on-windows.md](verify-on-windows.md) with this installer. Part I
     (updates) cannot be tested with a pre-release; it waits for v0.2.0.
   - The extension zip: on a real Chrome or Edge, walk through
     [verify-web-cells.md](verify-web-cells.md) with it.

### 2. The release

1. Fix whatever the candidate showed (another `-rc.N` if the fix is large).
   Then:

   ```
   node scripts/check-versions.mjs --set 0.2.0
   pnpm install --frozen-lockfile && pnpm lint
   git commit -s -am "chore(release): 0.2.0"
   git push origin main
   ```

2. Wait for a green CI run on that commit, then:

   ```
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

3. After the Release workflow is green, check:
   - The release `v0.2.0` is published, is **Latest**, not a pre-release, and
     lists the seven assets with `0.2.0` in their names.
   - `docker buildx imagetools inspect ghcr.io/onlyfly34/answerwall:latest`
     shows the same digest as `:0.2.0` and `:0.2` (the digest is also in the
     release notes), for both platforms.
   - `cd docker && docker compose pull && docker compose up -d` on a fresh
     machine pulls the image without logging in, and `docker compose logs`
     shows the pairing code.
   - On Windows, an installed `0.2.0-rc.1` (or `0.1.0-rc.1`) offers `0.2.0`
     through **File > Check for Updates…** (part I of the checklist).

The draft-then-publish order and the GHCR push are only exercised by a real
tag. If something fails on the candidate, delete the release and the tag
(`gh release delete v0.2.0-rc.1 --cleanup-tag`) and the image version in the
package settings before tagging again; a published final release is never
rewritten.

## The server bundle

`answerwall-server-<version>.tar.gz` and `.zip` hold the same directory:

```
package.json, package-lock.json   production dependencies manifest
dist/                             the compiled server
packages/core/                    the compiled core library
packages/web/                     the built web UI
LICENSE, README.md
```

It contains no `node_modules` and nothing platform-specific. To run it:

```
npm ci --omit=dev
node dist/main.js
```

`.github/scripts/package-server.mjs` builds it from a built workspace. The
lockfile in the bundle is generated with npm and then checked against
`pnpm-lock.yaml`: every package must have the version installed in the
workspace and the integrity pnpm recorded, and none may have an install
script. Packaging fails otherwise, so the bundle ships what the tests ran
against. The archives are reproducible for a given commit (sorted entries,
fixed owner, modes and times).

To package locally on Linux (needs GNU tar, zip and npm):

```
pnpm install --frozen-lockfile
pnpm build
node .github/scripts/package-server.mjs --out /tmp/bundle
```

`.github/scripts/verify-bundle.mjs <directory>` starts an extracted and
installed bundle on a free loopback port with an empty `PATH`, requests
`/api/meta` and `/`, and stops it. The `start` jobs of `build.yml` do this
with the `.tar.gz` on Linux and the `.zip` on Windows.

## The browser extension

`answerwall-extension-<version>.zip` holds one directory of the same name:
the release build of `apps/extension` (`manifest.json`, `wall.html` with
the web UI in `assets/`, `content.js`, `worker.js`, the icon and the
licence). It is not in any store: a user unpacks it and loads the directory
with **Load unpacked** on the extensions page of Chrome or Edge
([providers.md](providers.md#web-cells)). Its ID is the same on every
machine, because the manifest carries a public key
(`apps/extension/manifest.mjs`).

`.github/scripts/package-extension.mjs` packages it from a built workspace
and refuses to do so when the manifest is not for the workspace version, the
permission list is not exactly `declarativeNetRequestWithHostAccess` and
`storage` with `https` host permissions, or anything of the test build (the
stand-in site of the automated tests) is in it. The archive is reproducible
for a given commit. To package locally on Linux (needs zip and unzip):

```
pnpm install --frozen-lockfile
pnpm build
node .github/scripts/package-extension.mjs --out /tmp/bundle
```

CI loads the extension unpacked in Chromium (the `extension` project of the
end-to-end tests, as its test build); the zip itself is not loaded by any
job. After a release, [verify-web-cells.md](verify-web-cells.md) is the hand
check, including the rules for the real sites, which no job can test.

`SHA256SUMS` lists every asset of the release. To check a download:

```
sha256sum --check --ignore-missing SHA256SUMS
```

## The Windows installer

`desktop.yml` builds it with electron-builder (`apps/desktop/scripts/package.mjs`):
NSIS, x64, not code-signed, installing for the current user by default. The
artifact holds exactly the installer, its `.blockmap` and `latest.yml`.
`latest.yml` is always that name, also for a pre-release version
(`detectUpdateChannel` is off); the installed app reads it from the newest
release that is not a pre-release. How the app and its updater work:
[desktop.md](desktop.md).

## The container image

`apps/server/Dockerfile` is built from the repository root. Its build stage
runs pnpm and the same packaging script as the server bundle, so the image
holds the same lockfile-checked tree; only the server and the packages it
depends on are built (the desktop app's sources are not in the build
context). `docker.yml` builds each architecture on a runner of that
architecture (`ubuntu-latest`, `ubuntu-24.04-arm`), without emulation, and
runs `docker/test/smoke.mjs --no-build` against the result before anything is
pushed. With `push` it then pushes the tested build by digest and joins the
two digests with `docker buildx imagetools create`, with OCI annotations on
the index. Locally:

```
pnpm smoke:docker           # builds, then tests
pnpm smoke:docker --all     # also the reverse-proxy and own-certificate setups
```

How to run the image: [deploy-docker.md](deploy-docker.md).

## Proven only on GitHub

What the local runs on Linux cannot show:

- the Windows legs of `check`, `e2e`, `start` and `desktop.yml`, and the
  amd64 leg of `docker.yml` (CI shows these on every push);
- the pnpm, Playwright and image build caches being saved and restored;
- for a tag only: `plan` against a real tag, the GHCR login, push by digest
  and manifest, and `publish` (draft, upload, publish) against the real
  Releases API. Use the release candidate for that first try.
