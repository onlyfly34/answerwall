# Desktop app (developer notes)

How `apps/desktop` is built, run, packaged and tested, how its processes fit
together, and what its security model rests on. The decisions it implements
are in [DECISIONS.md](DECISIONS.md) §3, §7 and §10. Instructions for users
are not in this file.

## Run, test, package

```
pnpm install
pnpm build                                   # core, web UI, server, then the app's bundles
pnpm --filter @answerwall/desktop start      # builds dist/ again and starts Electron
pnpm vitest run --project desktop            # unit tests
pnpm --filter @answerwall/desktop e2e        # end-to-end tests against dist/
```

The `electron` package downloads its binary the first time it is used, not
at install time, so `pnpm install` stays quick for everyone who does not
touch the app.

On Linux, where the app is developed but not shipped, the Chromium sandbox
often cannot start (containers, and distributions that deny unprivileged
user namespaces). Start it with `electron . --no-sandbox` there. The
end-to-end tests do so on Linux and also use Chromium's headless display
(`--ozone-platform=headless`), so they need neither a display nor xvfb. On
Windows the tests start the app exactly as shipped.

A build that is not installed keeps its data in `AnswerWall-dev` next to
where the installed app keeps `AnswerWall` (`%APPDATA%` on Windows), unless
`--user-data-dir=<dir>` is given. The user data directory holds:

| Path           | Content                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| `desktop.json` | The shell's own settings: local or remote, the remote address, the local port.       |
| `data/`        | The local server's data directory (database, work directories), as in server mode.   |
| `secrets.json` | The secret store: key names and values encrypted by the operating system.            |
| `logs/`        | `desktop.log` (the shell's entries and the local server's log) and the previous one. |
| the rest       | Chromium's profile: the cookies and storage of the partitions below, caches.         |

Packaging:

```
pnpm --filter @answerwall/desktop package          # release/: installer, blockmap, latest.yml
pnpm --filter @answerwall/desktop package --dir    # release/<platform>-unpacked only
pnpm --filter @answerwall/desktop verify-package   # inspect what was packed
E2E_APP_EXECUTABLE=<path> pnpm --filter @answerwall/desktop e2e   # test a packaged app
```

The installer can only be built on Windows; `--dir` works anywhere and is
what the Linux job of the workflow tests. `apps/desktop/package.json` must
carry the same version as `apps/server/package.json` (the build refuses
otherwise): the web UI is built with the server's version and treats a
server of another version as stale.

`pnpm --filter @answerwall/desktop icons` regenerates `build/icon.ico` and
`build/icon.png` from `packages/web/public/icon.svg`. The output is committed.

## What is in the package

`scripts/build.mjs` writes everything the app runs from into `dist/`, each
script as one self-contained file made by esbuild from the TypeScript
sources of this package and of `@answerwall/core`:

| File                             | Runs in                        | Content                                           |
| -------------------------------- | ------------------------------ | ------------------------------------------------- |
| `main.cjs`                       | main process                   | the shell, with electron-updater bundled in       |
| `core-host.cjs`                  | utility process                | core's server and all of its dependencies         |
| `reaper.cjs`                     | plain Node (the app's own exe) | ends the CLI children when the core host dies     |
| `preload-local.cjs`              | local window, sandboxed        | the one-function bridge                           |
| `preload-connection.cjs`         | connection page, sandboxed     | the page's four calls                             |
| `connection/`                    | connection page                | HTML, CSS and one script                          |
| `web/`                           | served by the core host        | a copy of `packages/web/dist` without source maps |
| `licenses/THIRD-PARTY-LICENSES…` | opened from the Help menu      | licence texts of every bundled package            |

Because nothing in `dist/` resolves a module at run time, the package has no
`node_modules`: electron-builder never walks pnpm's symlinks, and there is
nothing to rebuild. Every dependency of the app is a `devDependency`.
`verify-package` fails when a `node_modules` directory, a native module
(`*.node`), a source file or a source map is found in the package.

electron-builder puts `dist/` into `app.asar`, except what another process
or program opens as a file: `web/` (read by the core host), `connection/`
(loaded as a `file:` URL, which cannot look into the archive while the fuse
`grantFileProtocolExtraPrivileges` is off), `reaper.cjs` (started with
`ELECTRON_RUN_AS_NODE`) and `licenses/`. These live in `app.asar.unpacked`.

The configuration is in `scripts/package.mjs`, not in `package.json`, so
that `productName`, `appId`, the artifact names and the update repository
all come from `packages/core/src/brand.ts`:

- NSIS, x64, with pages (`oneClick: false`): shows the licence; installs for
  the current user by default, without administrator rights, and offers "for
  all users" as the other choice. Languages: English and Traditional Chinese.
- Artifacts: `answerwall-desktop-<version>-windows-x64-setup.exe`, the same
  name with `.blockmap`, and `latest.yml`.
- Not code-signed.
- Fuses: `runAsNode` stays on (the reaper needs it), and so does
  `enableNodeCliInspectArguments` (the end-to-end tests drive the packaged
  app through the inspector). `NODE_OPTIONS` is ignored, the app loads only
  from `app.asar`, the archive's integrity is validated, cookies are
  encrypted with the system's key, and `file:` pages get no extra privileges.

## Processes

```
main process (Electron)
├─ utility process: core host ── CLI children (one per running cell)
│      └─ reaper (stdin pipe from the core host)
├─ renderer: local window        http://127.0.0.1:<port>   partition persist:local
├─ renderer: remote window       <server origin>           partition persist:remote
└─ renderer: connection page     file: (bundled)           partition connection (in memory)
```

Only one of the local and the remote window exists at a time; the
connection page can be open beside it.

**Main process** (`src/main`). `index.ts` wires everything; the rules it
applies are in small modules without Electron imports, which the unit tests
cover: `remote-url.ts` (which addresses are accepted), `navigation.ts`
(where a window may go), `auth-header.ts` (which requests get the token),
`login-terminal.ts` (which commands a terminal may run), `desktop-settings.ts`,
`secrets.ts`, `remote-probe.ts`, `core-process.ts`, `updater.ts`.

**Core host** (`src/core-host`). The utility process runs core's own
`createServer` with an `AppConfig` in mode `desktop`: bound to `127.0.0.1`,
TLS off, the launch token as `staticToken`. Nothing of core is copied or
re-implemented; `host.ts` only connects it to the utility process's message
port:

| Message (main → host) | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `start`               | The configuration, including the launch token and the port to try.   |
| `shutdown`            | Stop like the server's own `shutdown` message: graceful, 10 s limit. |
| `secret-result`       | The answer to a secret store request.                                |

| Message (host → main) | Meaning                                                   |
| --------------------- | --------------------------------------------------------- |
| `listening`           | The port the server bound.                                |
| `failed`              | The server could not start (`address_in_use` or `error`). |
| `secret`              | A `get`, `set` or `delete` of the secret store.           |

**The port.** The first start lets the system choose a port. The shell
remembers it and tries it again on later starts, so that the page keeps its
origin and with it what the browser stores per origin (the wall's
arrangement, the language, the service worker). When the port is taken,
the system chooses another.

**The secret store.** `safeStorage` exists only in the main process, so the
`SecretStore` injected into core (`ServerOverrides.secrets`) is a bridge:
each call is one `secret` message, answered by the main process, which keeps
the values encrypted with `safeStorage` (DPAPI on Windows) in
`secrets.json`. Without system encryption (a Linux session without a
keyring) nothing is stored: saving an API key fails with a message, and the
value is never written in plain text. Secret values are in no log and in no
error message.

**The reaper.** A utility process ends without running any code when the
main process is killed or crashes, so nothing in the core host could kill
its CLI children then. The core host therefore starts one helper, the app's
own executable in plain Node mode running `reaper.cjs`, with a pipe to its
stdin, and reports every child process tree to it (`watchChildProcessTrees`
in core). When the pipe closes, however the core host ended, the helper
kills the trees that were still registered (`SIGKILL` to the process group,
`taskkill /T /F` on Windows) and exits. On an orderly quit it finds nothing
left to do. The helper is started detached: on POSIX in a session of its
own, on Windows outside the job object in which Node keeps the children it
starts, which would otherwise end the helper together with the core host.
The core host also looks every two seconds whether the process that started
it still exists, and otherwise kills its children and exits: on Windows a
core host with running children was seen to stay behind when the main
process was killed, where it would keep the port and the data directory.
An end-to-end test kills the main process while three stubborn mock CLIs
run and expects every process to be gone, on Windows and on Linux.

**Shutdown.** Quit (menu, last window closed, `SIGINT`/`SIGTERM`/`SIGHUP`,
a system shutdown on Linux and macOS) stops the core host with `shutdown`
and waits for it; a host that does not finish in 12 s is killed, and the
reaper ends its children. When a Windows session ends (`session-end`), the
shell sends `shutdown` without waiting. An uncaught error in the main
process sends `shutdown`, shows an error box and exits. When the core host
exits unexpectedly, the shell offers to restart it. A second start of the
app focuses the running one (single-instance lock, per user data
directory).

## Security model

- **The launch token.** 256 random bits per start of the local server,
  generated in the main process. It reaches the core host in the `start`
  message over the utility process's message port, and nothing else: it is
  not in any environment (core also removes every `ANSWERWALL_*` variable
  from the CLI children's environment), not on a command line, not in a
  file and not in the log.
- **Header injection.** `session.webRequest.onBeforeSendHeaders` of the
  local window's session adds `Authorization: Bearer <token>` to requests
  whose origin is exactly `http://127.0.0.1:<port>`, replacing whatever the
  page set. The page's scripts never see the header. Requests of that
  session to any other origin are cancelled before they leave
  (`onBeforeRequest`), and the token is stripped from any request that
  would carry it elsewhere.
- **Windows.** Every window: `contextIsolation`, `sandbox`
  (`app.enableSandbox()` as well), no Node integration anywhere, no
  `<webview>`, no spell checker (it downloads dictionaries). Electron's
  `remote` module no longer exists. `will-navigate`, `will-frame-navigate`
  and `will-redirect` keep a window on its origin (the connection page: on
  its one file). `setWindowOpenHandler` always denies; an `http(s)` link to
  elsewhere goes to `shell.openExternal`, everything else is dropped.
- **Permissions.** Every permission request and check is denied except
  `clipboard-sanitized-write` for the window's own origin (the copy
  buttons). Device and screen capture requests are denied.
- **Preloads.** The local window's preload exposes one function,
  `openLoginTerminal(kind)`. The remote window has no preload. The
  connection page's preload exposes four calls. The main process checks for
  every call that it comes from the main frame of the right window at the
  right URL, and validates the arguments again.
- **The login terminal.** The page names a provider kind. The command comes
  from `LOGIN_COMMANDS` in core's protocol, the table the adapters also
  show; a command that is not plain lower-case words is refused. The
  terminal is an external window (Windows Terminal when its alias exists,
  else a console window of `cmd`), started with an argument array and the
  user's own environment. The app does not read its output and does not
  detect the login afterwards: the user presses Refresh.
- **Remote mode.** The window loads the server's own page in the partition
  `persist:remote`; pairing happens on that page, and the session cookie
  stays in that partition (encrypted on disk by Chromium). `https` to any
  host; `http` only when every address of the host is loopback or private
  (RFC 1918, link-local, `100.64.0.0/10`, `fc00::/7`, `fe80::/10`), shown
  with a warning on the connection page and in the window title. Before
  loading, the shell requests `GET /api/meta` through the same partition
  and refuses what is not a server of this product. **Certificate errors
  are never bypassed**: there is no `certificate-error` handler, no custom
  verification and no switch. A server with a private CA works once the CA
  certificate is installed in Windows; the connection page says so. A
  server that asks for a TLS client certificate is offered none
  (`client-certificate.ts`): Electron would otherwise send the first one in
  the user's store, which can name its owner.
- **The connection page.** One bundled file with a strict
  Content-Security-Policy, in an in-memory partition that cancels every
  network request.
- **No third-party requests.** The app talks to its local server, to the
  remote server the user entered, and, when enabled, to GitHub for the
  update check. Electron itself is given nothing to fetch.

## Updates

`electron-updater` with the GitHub provider, set in the packaged
`app-update.yml` and again in code to this repository. Releases marked as
pre-release are ignored. A check happens at start when "check for updates"
is on, and from File > Check for Updates. Nothing is automatic beyond the
check: one dialog asks before the download, another before the
installation, and the installer then runs visibly. `autoDownload` and
`autoInstallOnAppQuit` are off.

The setting lives in the local server's settings (the General section of
the settings page). The shell reads it at every start of the local server
and keeps a copy in `desktop.json` for remote mode, where no local server
runs; the connection page shows the same switch and writes it back to the
local server the next time one runs.

`ANSWERWALL_DESKTOP_UPDATES=off` in the environment disables the updater
whatever the setting says. Builds that are not an installed Windows build
have no updater.

**Unsigned builds.** electron-updater 6.8.11 verifies the Authenticode
signature of a downloaded installer only when `app-update.yml` names a
publisher (`NsisUpdater.verifySignature` returns early without one), and
electron-builder writes that name only for a signed build. This build sets
`win.verifyUpdateCodeSignature: false` explicitly, and `verify-package`
fails if a publisher name appears. What protects an update is therefore the
SHA-512 of the installer in `latest.yml`, fetched over HTTPS from the same
GitHub release: whoever can replace both files of a release can replace the
app. Windows shows its SmartScreen warning for the unsigned installer on
first download and again for an update's installer.

## Tests

Unit tests (`src/**/*.test.ts`, the `desktop` project of the root Vitest
configuration): URL validation, navigation confinement, the scope of the
header injection, the login command allowlist and the terminal command
lines, settings persistence, the secret store, the remote probe, the core
process handle, the core host against core's real server, the reaper
against real processes, the update flow, both message dictionaries.

End-to-end tests (`e2e/`, Playwright's Electron support, one app at a
time). They reuse the server suite's sandbox: the app's `PATH` holds the
mock CLIs and Node and nothing else, its home and profile directories are
temporary, and updates are switched off, so no real CLI can start and no
request leaves the machine. Every test fails when a process of the app, a
mock CLI or the reaper outlives it. Covered: first run and the remembered
choice; an ask streaming from the mock CLIs; the token on the wire but not
in the page, the log or a CLI's environment; the token's origin scope;
external links; permissions; the login terminal (a real console window on
Windows, the "no terminal" answer on Linux); the secret store on disk;
quit, last window closed and a killed main process leaving nothing behind;
the single instance; remote mode with pairing against a real server and
across a restart; an unreachable server; switching modes from the menu.

## Workflows

`.github/workflows/desktop.yml` is a reusable workflow. `ci.yml` calls it
on every push to `main` and every pull request, so a change to core or the
web UI also exercises the app; `release.yml` calls it for the installer. It
can also be run by hand.

- `windows` (windows-latest): builds the installer, inspects the package,
  installs it silently for the current user, runs the end-to-end tests
  against the installed executable, uninstalls it, and uploads the
  installer, its blockmap and `latest.yml` as one artifact.
- `linux` (ubuntu-latest): assembles the unpacked application, inspects it
  and runs the same tests against it.

Inputs when called: `artifact-name` (default `windows-installer`) and
`expected-version` (fails unless the app has this version). Outputs:
`version`, `installer`, `artifact-name`.

The release workflow's job `windows-installer` calls it with
`artifact-name: release-windows-installer`, so the three files become
release assets (docs/RELEASING.md). `latest.yml` is published under exactly
that name: it is what the installed app reads. Every package of the
workspace carries the same version (`node scripts/check-versions.mjs`, run
by `pnpm lint`).

## Not verified without a person at a Windows machine

- The first start after download: SmartScreen, and Smart App Control, which
  blocks unsigned installers outright where it is on.
- The real CLIs on Windows; the tests use the mocks only.
- The login terminal with Windows Terminal installed (the tests have no
  Windows Terminal alias and exercise the `cmd` path), and what each real
  CLI's login looks like in it.
- The whole update flow against a published release: check, download,
  installer, restart.
- The end of a Windows session (log-off, shutdown) while answers run.
- A server with a private CA installed in the Windows certificate store,
  and the wording of the certificate error without it.
- The installer's pages, the per-machine choice with elevation, high-DPI
  rendering of the icon, and the Traditional Chinese installer and menus.
