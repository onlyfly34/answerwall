# Architecture

The module map of the repository: who owns which files, which interface each
piece implements and consumes, and how a request flows through them. The
product and security decisions themselves are in [DECISIONS.md](DECISIONS.md)
and are not repeated here.

## Packages

| Package           | Role                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | Server library. Entry points: `.` (server), `./protocol` (browser-safe wire protocol), `./testing` (in-memory fakes), `./brand`. |
| `packages/web`    | SolidJS UI. Imports only `@answerwall/core/protocol` from core.                                                                  |
| `apps/server`     | Process entry: environment → `AppConfig` → `createServer`; the `pair` command calls `createPairingCode`.                         |
| `tools/mock-clis` | Fake CLIs for tests; put `tools/mock-clis/bin` and a directory holding only `node` on the `env.PATH` given to `createServer`.    |
| `e2e`             | Placeholder for the Playwright suite; see its README.                                                                            |

Workspace packages resolve to each other's TypeScript sources through the
`answerwall-source` export condition (set in `tsconfig.base.json`, the Vite
and Vitest configs, and the server's `dev` script), so typecheck, tests and
dev need no build. Only the compiled server (`apps/server/dist`) resolves
`packages/core/dist`.

Server-side code runs directly on Node's type stripping, which sets two rules
for `packages/core` and `apps/server`: relative imports carry the `.ts`
extension, and only erasable TypeScript syntax is allowed (no enums, no
parameter properties). `tsc` enforces both.

## Shared files

These define the boundaries between units. No unit owns them; change them in
a commit of their own, after agreeing with the units on both sides.

| Path                                               | Content                                                                                                                                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/brand.ts`                       | Product name and derived identifiers.                                                                                                                                                                           |
| `packages/core/src/protocol/**`                    | zod schemas and types for every request, response and stream event; limits; `applyStreamEvent`, the single definition of how events fold into a snapshot.                                                       |
| `packages/core/src/contracts/**`                   | Server-side interfaces, `AppConfig`, `AppError`.                                                                                                                                                                |
| `packages/core/src/app.ts`                         | `createApp(deps)`: middleware order and route mounting.                                                                                                                                                         |
| `packages/core/src/server.ts`                      | `createServer(config)`: builds every unit, listen and shutdown. `createPairingCode(config)`: mints a pairing code from a second process.                                                                        |
| `packages/core/src/system.ts`, `index.ts`          | System clock, ids, randomness; public exports.                                                                                                                                                                  |
| `packages/core/src/routes/shared.ts`               | Body and query validation helpers.                                                                                                                                                                              |
| `packages/core/src/testing/**`                     | Fakes of every contract and `createTestApp`.                                                                                                                                                                    |
| `packages/web/src/contracts/**`                    | The services the wall consumes (`services.ts`), their fakes (`testing.ts`), the merged message dictionary and its translator, the client-side paths (`routes.ts`), the design tokens (`theme.css`, `theme.ts`). |
| Root configuration, `scripts/**`, `pnpm-lock.yaml` | Tooling. Dependencies are pre-declared so the lockfile rarely changes; a unit that ends up not importing one of its pre-declared dependencies removes it.                                                       |

## Units

Each unit implements the factory functions in its directory; the signatures
are fixed. Every unit is built, and `createServer` wires the real ones.

| Unit      | Owns                                                                                                                                                             | Implements                                                                                                                                                                                                                                                                                                | Consumes                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| runner    | `packages/core/src/runner/**`, `routes/ask.ts`                                                                                                                   | `AskManager` (`createAskManager`)                                                                                                                                                                                                                                                                         | `Storage.turns`, `SettingsService`, `ProviderRegistry`, `Clock`, `IdGenerator`, `Logger`                                     |
| storage   | `packages/core/src/storage/**`, `settings/**`, `routes/history.ts`, `routes/presets.ts`, `routes/settings.ts`                                                    | `Storage` (`createSqliteStorage`), `SecretStore` (`createFileSecretStore`), `SettingsService` (`createSettingsService`)                                                                                                                                                                                   | `Logger`                                                                                                                     |
| security  | `packages/core/src/auth/**`, `tls/**`, `http/**`, `logging/**`, `routes/auth.ts`, `routes/meta.ts`, `apps/server/**`                                             | `AuthService` (`createAuthService`), `requireAuth`, `TlsProvider` (`createTlsProvider`), `HttpLayer` (`createHttpLayer`), `Logger` (`createLogger`), `loadConfig`                                                                                                                                         | `Storage.devices`, `Storage.pairingCodes`, `SecretStore`, `SettingsService` (limits), `Clock`, `IdGenerator`, `RandomSource` |
| providers | `packages/core/src/providers/**`, `routes/providers.ts`, `tools/mock-clis/**`                                                                                    | `ProviderRegistry` (`createProviderRegistry`), one `ProviderAdapter` per kind                                                                                                                                                                                                                             | `SettingsService`, `SecretStore`, `Clock`, `Logger`                                                                          |
| web-infra | `packages/web` except `src/wall/**` and `src/contracts/**`: build setup, `src/main.tsx`, `src/app/**`, `src/infra/**`, `src/pages/**`, `src/pwa/**`, `public/**` | `AppServices` and everything in it (`ApiClient`, `AskStreamStore`, `SettingsStore`, `ProvidersStore`, `Notifier`, and `I18n` through the shared `createI18n`); the shell that provides `ServicesContext` and mounts the wall's pages. `ShellContext`, `Shell` and `DevicesStore` are internal to the unit | `@answerwall/core/protocol`; `WallPage`, `HistoryPage`                                                                       |
| web-wall  | `packages/web/src/wall/**`                                                                                                                                       | `WallPage`, `HistoryPage` exported from `wall/index.tsx`; its strings in `wall/messages/`                                                                                                                                                                                                                 | `useServices()` from `src/contracts/services.ts`; `@answerwall/core/protocol`                                                |

Rules that keep the units independent (enforced by ESLint):

- A core unit imports other units only through `contracts/`; never
  `../storage/…` from `runner/`, and so on.
- `protocol/**` imports nothing but zod, `../brand.ts` and its own files.
- `packages/web/src/wall/**` does not import `app/`, `infra/` or `pages/`.
- Vendor SDK packages and native modules are forbidden everywhere
  (`scripts/forbidden-packages.mjs`, also checked against the lockfile).

Run one unit's tests alone, from the repository root:

```
pnpm vitest run --project core packages/core/src/runner packages/core/src/routes/ask
pnpm vitest run --project core packages/core/src/storage packages/core/src/settings
pnpm vitest run --project core packages/core/src/providers
pnpm vitest run --project server
pnpm vitest run --project web packages/web/src/wall
```

Every unit tests against `@answerwall/core/testing` rather than another
unit's implementation: `createFakeStorage`, `createFakeSecretStore`,
`createFakeSettingsService`, `FakeProviderAdapter` (scripted events and
delays, honours abort), `createFakeProviderRegistry`, `createFakeAskManager`,
`createFakeAuthService`, `FakeClock`, `createSequentialIds`,
`createCountingRandom`, `createMemoryLogger`. To test a route against the
real unit, override just that dependency:
`createTestApp({ asks: createAskManager({ clock, … }) }, clock)`.
`TestApp.request` behaves like a non-browser client: bearer token, and a JSON
body on every method but GET.

The wall tests against `createFakeServices()` from
`packages/web/src/contracts/testing.ts`: signal-backed stores with data, the
real translator, an ask stream the test drives with `apply(event)`, and
recorders for API calls, settings updates, toasts and reported errors.

Shared test files (`app.test.ts`, `server.test.ts`, the protocol tests) pin
contracts only. A unit's own tests live in its directory.

`pnpm smoke:mock` (`scripts/smoke-mock.mjs`) builds everything and drives
the compiled server over real sockets: no fake inside the server, the mock
CLIs on `PATH` and a local OpenAI-compatible stub. It is the one check that
composes every unit as shipped.

## Request pipeline

`createApp` applies the pieces of `HttpLayer` in this order; each rejects by
throwing an `AppError`.

1. `requestLog`
2. `securityHeaders` — first, so that rejections by the guards carry them
3. `clientInfo` — resolves the socket peer, the client address and whether
   the request is secure; every later step relies on it
4. `peerGuard`
5. `hostGuard`
6. For `/api/*` only: `originGuard`, `authRateLimit`, `bodyLimit`, then
   `requireAuth`. The routes exempt from authentication are listed in one
   place, `PUBLIC_API_ROUTES` in `app.ts`; a new route is protected unless it
   is added there.

   `originGuard` runs before authentication, so it decides on headers alone:
   a present `Origin` must be allowed; a missing one passes only with an
   `Authorization` header and no session cookie. `authRateLimit` counts the
   requests on which `requireAuth` or an auth route set `authFailure` (a
   credential was presented and rejected), not every 401.

   `bodyLimit` judges a declared `Content-Length` by its value; a chunked
   body, or a request without one, is read through a byte counter and handed
   to the route through hono's body cache. `requireAuth` wraps the
   `text/event-stream` body of a device's request and ends it when that
   device is revoked or logs out (the auth unit announces removals through a
   side channel of its own); the route sees a lost client and the ask keeps
   running.

7. The route modules, then a JSON 404 for any other `/api/*` path
8. `staticUi` — the built UI with an `index.html` fallback

`onError` turns an `AppError` into `{ error: { code, message } }` with the
status from `HTTP_STATUS`; any other error becomes a generic 500.

## One ask, end to end

1. `POST /api/ask` — `routes/ask.ts` validates the body with
   `AskRequestSchema` (hard maxima only) and calls `AskManager.submit`.
2. The runner checks the configured limits and that every target's provider
   exists and is enabled, resolves each target's model
   (`target.model ?? instance.defaultModel`), builds `initialAskSnapshot`
   with the resolved models, persists it with `Storage.turns.create`, and
   returns `{ askId }`. Every slot starts `queued`.
3. Per provider instance a semaphore of `instance.concurrency` admits slots.
   For an admitted slot the runner creates a work dir, calls
   `ProviderRegistry.adapter(kind).run(instance, { prompt, model, effort,
timeoutMs, signal, workDir })` and translates each `ProviderEvent` into a
   `StreamEvent` with the next `seq`. The `start` event's `streaming` is the
   adapter's value, else the instance's cached detection, else `unknown`. It
   appends the event to the ask's log, folds it into the in-memory snapshot
   with `applyStreamEvent`, and hands it to subscribers.
4. Cancel, timeout and shutdown abort the slot's `signal`. The adapter stops
   the provider; the runner, which knows the reason, emits `cancelled`,
   `timeout` or `error`. Output beyond the per-slot limit is dropped after one
   `notice` with code `output_truncated`.
5. `GET /api/ask/:askId/stream` — the route calls `AskManager.subscribe` with
   the resume point (`Last-Event-ID`, else `?after=`) and writes each event
   as one SSE message, with a ping comment every 15 s. A closed connection
   aborts the subscription only. Every stream ends with a terminal event
   (`isTerminalStreamEvent`): `ask_done`, or, for an ask that is already done
   with nothing left to replay, a single `snapshot` whose status is `done`.
   A client that sees a stream end without one resumes from its last `seq`.
6. The runner writes dirty slots to `Storage.turns.save` periodically and
   when the ask completes, emits `ask_done`, then prunes history to the
   configured bounds.
7. `GET /api/ask/:askId` and `GET /api/history/:askId` return the same
   `AskSnapshot` shape, from memory or from storage. Deleting a history entry
   also calls `AskManager.forget`, so the ask routes stop serving it.
8. In the browser the stream store applies the same `applyStreamEvent` to a
   Solid store; cells re-render Markdown from the accumulated text.

## Lifecycle

`createServer(config)` creates the data directory and builds the units in
dependency order: storage, secrets, settings (`load`), providers, runner
(`start`, which fails slots interrupted by a previous process), auth, TLS,
HTTP layer, app. `listen()` binds the socket (HTTPS when `TlsProvider` has
material), then runs `AuthService.bootstrap` and a first provider detection
in the background. `shutdown()` stops accepting connections, shuts the runner
down (which kills every child and flushes), stops provider detection, closes
remaining connections, then TLS and storage.

`apps/server` connects this to the process (`process-runtime.ts`): signals,
the IPC `shutdown` message and an IPC disconnect start the shutdown; output
streams that fail are dropped instead of ending the process; and every exit
that does not complete a shutdown, including `process.on('exit')`, calls
`killChildProcessTrees()` from core, which kills every CLI tree whose slot
has not finished.

`createPairingCode(config)` is the second way into the data directory: it
opens the database, creates a pairing code through the auth service and
closes again, while a server may be running on the same directory. This is
why pairing codes are read from storage on every attempt and never cached.

Secrets can also come from the environment: the variable
`secretEnvName(key)` (prefix `SECRET_ENV_PREFIX`) overrides the stored value
of `key`, read-only. Configuration parsing skips variables with that prefix.

## Conventions

- **Errors.** Throw `AppError(code, message)` for anything the client should
  see; the message is user-facing and carries no paths, tokens or account
  identifiers. Provider failures are not exceptions: adapters yield an `error`
  event with a `ProviderErrorCode`. New codes are added to the protocol first.
- **Validation.** Routes validate with the protocol schemas through
  `readJson` and `parse`, and annotate what they return with
  `satisfies <ResponseType>`. Schemas hold the hard maxima; configurable
  limits are enforced by the unit that owns the resource.
- **Logging.** Use the injected `Logger`, never `console`. Log identifiers
  and counts, never prompts, answers, tokens, cookies, keys or header values.
- **Time and randomness.** Server code takes `Clock`, `IdGenerator` and
  `RandomSource` from its dependencies and does not call `Date.now`,
  `setTimeout` or `randomBytes` directly, so tests can drive it with `FakeClock`.
  All timestamps are epoch milliseconds.
- **Configuration.** Only `apps/server` reads the environment for
  configuration. Core receives an `AppConfig`.
- **Naming.** Files are kebab-case. Factories are `createX`; schemas are
  `XSchema` with the inferred type `X` exported beside them.
- **Tests.** `foo.test.ts` sits next to `foo.ts`. Test names state behaviour.
  No test starts a real CLI or uses the network beyond loopback.
- **Web.** Every user-visible string goes through `i18n.t` with a key from
  the owner's `messages/` directory (`app.*` or `wall.*`), in both languages.
  Links and navigation use `ROUTES`; styles use only the variables of
  `theme.css` and the two breakpoints of `theme.ts`. The shell provides the
  router and loads settings and providers before it mounts the wall's pages.
  State that belongs to one device (current wall arrangement, maximised
  cell) stays in the browser; shared state goes through the API.
- **Dependencies.** Pin exact versions and verify them with `npm view`. Solid
  is pinned to the 1.x line and TypeScript to 6.0.x because the Solid 2
  toolchain and typescript-eslint's TypeScript 7 support are not released
  yet.
