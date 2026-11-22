# Releasing

How a release is made, what the workflows in `.github/workflows` do, and how
the build jobs planned for P2 fit in. The decisions behind this are in
[DECISIONS.md](DECISIONS.md) §10.

## Workflows

| File            | Runs on                                                | Does                                                                                                                |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`        | push to `main`, pull requests, manual run, the release | typecheck, lint, unit tests, build and `pnpm smoke:mock` on Linux and Windows; the end-to-end tests; the bundle     |
| `build.yml`     | called by `ci.yml` and `release.yml`                   | builds the workspace, packages the server bundle, starts the packaged archives with plain Node on Linux and Windows |
| `release.yml`   | push of a tag `v*`, manual run                         | runs `ci.yml` and `build.yml`, collects the assets and, for a tag, publishes the GitHub Release                     |
| `actions/setup` | used by the jobs above                                 | pnpm from `packageManager`, Node from `.nvmrc`, `pnpm install --frozen-lockfile`                                    |

No workflow uses a secret other than the token GitHub issues to each run, and
none starts a real AI command-line tool: the providers are the mocks in
`tools/mock-clis` and a stub endpoint on loopback. Every job has a read-only
token except `publish`, which may write releases.

Actions are pinned to a commit, with the version in a comment. Dependabot
(`.github/dependabot.yml`) proposes updates weekly. It does not touch npm
packages; those are pinned and checked by hand.

The end-to-end tests run on Linux and on Windows, and both runs are binding.
In CI the responsiveness test allows a main-thread task of one second
(`E2E_MAX_LONG_TASK_MS` in `ci.yml`) instead of the 500 ms of a developer
machine, because the hosted runners share four cores among four workers.

## Making a release

1. Set the same new version in `apps/server/package.json`,
   `packages/core/package.json` and `packages/web/package.json`. The server
   reports the version of `apps/server/package.json` in `GET /api/meta`, and
   the release fails when it differs from the tag.
2. Merge that to `main` and wait for CI.
3. Optionally run the Release workflow by hand on `main` ("Run workflow").
   Nothing is published; the artifact `assets` of the run holds exactly the
   files a tag would release.
4. Tag the commit and push the tag:

   ```
   git tag v0.1.0
   git push origin v0.1.0
   ```

A tag must be `v<major>.<minor>.<patch>`, optionally followed by a hyphen and
a pre-release identifier. A tag with a hyphen (`v0.1.0-rc.1`) is published as
a pre-release and does not become the latest release.

The `publish` job then creates the release as a draft with generated notes,
uploads every asset, compares the uploaded names with the built ones, and
only then publishes. If a run fails half-way, the draft stays invisible to
visitors; running the failed jobs again reuses it and replaces its assets. A
release that is already published is never modified: fix the problem and tag
a new version.

## The server bundle

`<name>-server-<version>.tar.gz` and `.zip` hold the same directory:

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

`SHA256SUMS` lists every asset of the release. To check a download:

```
sha256sum --check --ignore-missing SHA256SUMS
```

## Structure of the release workflow

```
plan ────► build ──► (further build jobs) ──► assets ──► publish
verify ──────────────────────────────────────────────────┘
```

- `plan` reads the tag: version, pre-release or not, publish or build only.
- `verify` is the whole of `ci.yml`.
- `build` is `build.yml`. Its artifact `release-server-bundle` holds the two
  archives; its outputs are `version`, `bundle` (the base name of the
  archives) and `artifact-name`.
- `assets` downloads every artifact whose name starts with `release-`, writes
  `SHA256SUMS` over all files, and uploads the result as the artifact
  `assets`.
- `publish` runs for tags only and needs `verify` and `assets`.

The contract for a build job is therefore small: depend on `build`, upload the
files to release as an artifact named `release-<something>`, and be listed in
`needs` of `assets`. File names must be unique across all jobs, because the
artifacts are merged into one directory. Nothing else changes: checksums,
draft, upload and publishing already cover whatever the artifacts contain.

### Windows installer (P2)

A job `windows-installer` on `windows-latest`, `needs: [plan, build]`:

1. Check out and use `./.github/actions/setup`.
2. Build the workspace, then run electron-builder for NSIS x64 (unsigned).
   The Electron application embeds the same compiled core and web UI, so it
   can also start from the artifact `release-server-bundle` instead of
   building again.
3. Upload the installer, its `.blockmap` and `latest.yml` as the artifact
   `release-windows-installer`.

Add `windows-installer` to `needs` of `assets`. The update metadata is then
published together with the installer, which is what the in-app update check
reads.

### Container image (P2 build, P3 publishing)

Images are built on native runners and merged by digest, without emulation:

1. A job `container` with a matrix of `ubuntu-24.04` (amd64) and
   `ubuntu-24.04-arm` (arm64), `needs: [plan, build]`. Each downloads
   `release-server-bundle`, builds the image from the extracted bundle (the
   Dockerfile runs `npm ci --omit=dev` inside the image, so no dependency is
   copied from the runner), starts the image and requests `/api/meta`, then
   pushes by digest and uploads the digest as an artifact named
   `digest-<arch>`. The name deliberately does not start with `release-`.
2. A job `container-manifest`, `needs: [container]`, creates the multi-arch
   manifest from the digests with `docker buildx imagetools create`.

These jobs need `packages: write` and run only when `plan` says to publish.
Make `publish` depend on `container-manifest` so that a release is not
published when its image failed. The package of a first push is private: its
visibility has to be changed to public once, by hand, in the package
settings.

## Proven only on GitHub

The workflows are linted and the packaging and start check were run locally
on Linux. What only a run on GitHub shows:

- the Windows legs of `check`, `e2e` and `start`;
- the pnpm and Playwright caches being saved and restored;
- `publish`: draft, upload and publish against the real Releases API. Use a
  pre-release tag such as `v0.0.1-rc.1` for the first try and delete that
  release and tag afterwards.
