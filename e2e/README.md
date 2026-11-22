# End-to-end tests

Playwright tests that drive the built web UI in a real browser against the
compiled server, with the mock CLIs from `tools/mock-clis` as the only
providers. No real account, no real CLI and no network beyond loopback is ever
used.

## Running

```
pnpm --filter ./e2e browsers        # once: download Chromium for Playwright
pnpm --filter ./e2e test            # all three viewports
pnpm --filter ./e2e test:phone      # one viewport: test:desktop, test:tablet, test:phone
pnpm --filter ./e2e test:web-cells  # the web-cell tests with the unpacked test extension
pnpm --filter ./e2e test:extension  # the browser extension itself (apps/extension, test build)
pnpm --filter ./e2e exec playwright test tests/ask.spec.ts -g "12 slots"
E2E_HTML_REPORT=1 pnpm --filter ./e2e test   # also write an HTML report
pnpm --filter ./e2e report          # open that report
```

The global setup builds the repository first when `apps/server/dist`,
`packages/core/dist` or `packages/web/dist` is missing or older than its
sources. `E2E_BUILD=always` forces the build, `E2E_BUILD=never` fails instead
of building.

On Linux the browser needs a few system libraries. Where they are missing,
`pnpm --filter ./e2e exec playwright install --with-deps chromium` installs
them (it needs root), or run the suite in the official Playwright container
image of the same version as `@playwright/test`.

A failed test leaves a trace, a screenshot and the server's log in
`test-results/`; open a trace with `pnpm exec playwright show-trace <file>`.

| Variable               | Effect                                                                |
| ---------------------- | --------------------------------------------------------------------- |
| `E2E_BUILD`            | `auto` (default), `always` or `never`; see above.                     |
| `E2E_MAX_LONG_TASK_MS` | Longest main-thread task allowed while 12 cells stream (default 500). |
| `E2E_MAX_FRAME_GAP_MS` | Longest gap between two animation frames in that test (default 1000). |
| `E2E_HTML_REPORT`      | Also write the HTML report to `playwright-report/` (always in CI).    |
| `CI`                   | One retry, four workers, the HTML report and the GitHub reporter.     |

## How it is built

| Path                         | Content                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `playwright.config.ts`       | Three projects of the same browser: `desktop` (1440×900), `tablet` (820×1180, touch), `phone` (390×844, touch, mobile). |
| `support/global-setup.ts`    | Builds when needed; creates the run directory with the sandbox.                                                         |
| `support/global-teardown.ts` | Ends and reports anything a test left running, removes the run directory.                                               |
| `support/environment.ts`     | The sandbox: the `PATH` and environment a test server gets.                                                             |
| `support/server.ts`          | Starts and stops one compiled server; a small API client for arranging a test.                                          |
| `support/stub.ts`            | Loopback helpers: a scripted OpenAI-compatible endpoint, a canary origin, a relay whose connections can be cut.         |
| `support/fixtures.ts`        | The fixtures, and the guard that watches every browser context.                                                         |
| `support/wall.ts`            | Locators and actions on the wall.                                                                                       |
| `support/probes.ts`          | In-page recording of every cell's phases; long-task and frame measurements.                                             |
| `support/hostile.ts`         | The hostile Markdown and the checks that rendered content is inert.                                                     |
| `support/touch.ts`           | A real touch swipe.                                                                                                     |
| `tests/*.spec.ts`            | The tests, one file per area.                                                                                           |
| `extension/`                 | The `extension` project: `apps/extension` as its test build, against the stand-in site and a real server; see below.    |
| `web-cells/`                 | The `web-cells` project: a test extension, a stand-in vendor site and their tests; see below.                           |

**A server per test.** Every test starts its own server on an ephemeral
loopback port with its own temporary data directory, so tests share no
history, presets, settings, devices or failed sign-in attempts, and the suite
runs fully in parallel. The server is stopped gracefully after the test; a
mock CLI that outlives it fails the test, and the global teardown fails the
run if any server or mock is still alive at the end.

**No real CLI is reachable.** A test server's `PATH` holds exactly two
directories: the mock launchers, and a private directory with a link to
`node` (on Windows, Node's own directory, after checking that no CLI sits next
to `node.exe`). Its `HOME` is a temporary directory and nothing of the
caller's environment is passed on beyond what a process needs to start.

**States instead of races.** "Mid-stream" is a state the test holds: the stub
endpoint stops at a chosen piece until the test releases it, and CLI cells use
the `hang` scenario where a test needs a cell that stays running. States that
last only a moment (a cell queued behind another for a second) are read from a
timeline recorded inside the page, not polled for.

**The guard.** Every browser context is watched for the whole test. Any of
these fails the test that caused it:

- a request to any origin other than the test's own server (it is recorded
  and aborted before it leaves the browser);
- a Content-Security-Policy violation;
- an uncaught exception or a console error (a `401` from the API, which is how
  the server says "not signed in", is expected; anything else a test must
  declare with `guard.allowConsole`);
- a dialog.

**Viewports.** A test whose title or `describe` carries `@desktop`, `@tablet`
or `@phone` runs only in that project; everything else runs in all three.

**Web cells.** The `web-cells` project does not use the fixtures above. Each
of its tests starts a Chromium with a profile of its own and the unpacked
Manifest V3 extension from `web-cells/extension` (`channel: 'chromium'`: the
headless shell cannot load extensions), a stand-in vendor site
(`web-cells/support/vendor-site.ts`, reached as `http://vendor.localhost:<port>`,
which refuses framing and signs in with a `SameSite=Lax; HttpOnly` cookie)
and, where needed, a compiled server. The global setup copies the extension
into the run directory and builds the web UI into it from
`web-cells/embedded` (the `@answerwall/web/embed` entry), so the UI can be
driven as an extension page. No real site is ever contacted and no site rule
for a real site is exercised. [docs/web-cells.md](../docs/web-cells.md)
explains what each test proves.

## What is covered

| File                | Subject                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth.spec.ts`      | First device with the logged code, wrong and malformed codes, a second device with a code from Settings, the `pair` command, the access token, rate limiting, sign-out, revoking this device, being revoked from elsewhere.    |
| `providers.spec.ts` | Detection results of the mocks, no identifying details, CLIs run only on Refresh, enabling and disabling, the agy risk notice, adding and removing an endpoint with a write-only key, a missing CLI, logged-out CLIs.          |
| `ask.spec.ts`       | 12 slots across providers with queueing, 12 cells streaming at once with responsiveness measured, Ctrl+Enter, cancel one, cancel a queued one, cancel all, block streaming, every failure state, timeout, truncation, copying. |
| `resume.spec.ts`    | Reload, navigation and a cut connection in mid-stream without lost or repeated text; a running ask followed from a second tab; closing the page does not cancel.                                                               |
| `presets.spec.ts`   | Save, switch, update, rename, delete; the per-device default preset.                                                                                                                                                           |
| `history.spec.ts`   | List, search in prompts and answers, open read-only, ask again, delete, paging.                                                                                                                                                |
| `layout.spec.ts`    | Desktop: automatic and fixed columns, minimum width, shared settings, preset layout, maximise, reorder by drag and keyboard. Tablet: two columns by default. Phone: one cell, swipe, tabs, status dots.                        |
| `language.spec.ts`  | English and Traditional Chinese on every page, on the sign-in page, across devices; no untranslated key on screen.                                                                                                             |
| `security.spec.ts`  | Hostile Markdown streamed in torn pieces, as a prompt, in history and in names: nothing loaded, nothing run. The CSP header on every response; the app running clean under it.                                                 |
| `pwa.spec.ts`       | Manifest and icons; the service worker installs, serves the shell, never answers for `/api/`, caches nothing at runtime; offline start; a page older than the server.                                                          |
| `settings.spec.ts`  | Limits and their bounds, enforced by page and server; the about and connection sections.                                                                                                                                       |
| `web-cells.spec.ts` | The web cells settings; a web slot answered by a scripted client, stored and rendered like any answer (hostile Markdown included); another device cannot answer for it but can cancel it; failure with a reason; timeout.      |

The `web-cells` project (one desktop viewport):

| File                          | Subject                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-cells/mechanism.spec.ts` | With third-party cookies allowed and blocked: the extension page frames the stand-in site and nothing else can; the session cookie and storage of a normal tab apply in the frame; the content script fills, submits, reads; inert elsewhere.        |
| `web-cells/server.spec.ts`    | What an extension page's requests look like; the extension id allowlist; a web page gains nothing; pairing for a token, a web slot from ask to history with the stream read by `fetch`; cancel from another device; the web UI as an extension page. |

Not covered here, because it cannot be done in this setup: a real CLI, a real
account, TLS modes (the browser would need the private CA installed), the
desktop app, a server restart in the middle of an ask (`pnpm smoke:mock`
covers that over the API), and browsers other than Chromium.

## Known product bugs

None. A test that fails because of a product bug is not marked as an expected
failure; it stays red until the product is fixed.

The `extension` project (one desktop viewport) loads the test build of
`apps/extension`, which the global setup builds into the run directory: the
release code, plus the stand-in site in place of the site `claude`.

| File                     | Covers                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/wall.spec.ts` | The fixed extension ID; the first-run page, a refused and an accepted pairing, change server; a mixed ask with a mock CLI cell and a web cell; a field and a rich editor filled in; the answer in the history; a rule that no longer matches; each combination of the two switches; cancel; sign-in inside a cell; the header rule's reach. |
