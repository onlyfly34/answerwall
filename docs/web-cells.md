# Web cells: developer notes

Web cells show a vendor's own web app in a frame of the wall page of a
browser extension, next to the CLI and API cells
([DECISIONS.md](DECISIONS.md) §11 for the plan, §5.4, §6, §6.1 and §7 for
the binding rules). This file holds what was
proven about the mechanism, the contract between the extension and the
server, how the extension is built, and where the evidence ends.

- **Built**: the proof of the mechanism in a real Chromium, the protocol and
  the server side, the web UI's ability to run from the extension's origin,
  the extension itself (`apps/extension`), the site rules as data files, and
  web cells in the wall.
- **Not done**: no rule has been run against a real site. All five are
  marked unverified; [verify-web-cells.md](verify-web-cells.md) is the hand
  check.

Nothing here says that driving a vendor's web app through this is permitted
by that vendor. Their terms restrict automated access to their web apps; the
user docs must say so plainly and claim nothing else.

## 1. What was proven, and how

All of it runs as the Playwright project `web-cells`
(`pnpm --filter ./e2e test:web-cells`, also part of `pnpm e2e`). The browser
is Playwright's Chromium 159 (`@playwright/test` 1.65.1, `channel: 'chromium'`,
new headless mode) on Linux, with a fresh profile per test and an unpacked
Manifest V3 extension. Nothing was run in branded Chrome, in Edge, headed,
or on Windows or macOS.

The stand-in site (`e2e/web-cells/support/vendor-site.ts`) is reached as
`http://vendor.localhost:<port>`; the AnswerWall server is on
`http://127.0.0.1:<port>`. They are different sites, and both differ from the
extension. Every page of the stand-in answers with `X-Frame-Options: DENY`
and a `Content-Security-Policy` that ends in `frame-ancestors 'none'`.
Signing in sets `vendor_session` (`SameSite=Lax; HttpOnly`), `vendor_strict`
(`SameSite=Strict; HttpOnly`) and `vendor_probe` (`SameSite=None; Secure`).
The chat page has an input (a `textarea`, or a `contenteditable` element with
`?editor=rich`), a button that is enabled only by an `input` event, and an
answer that streams in and is marked when it has finished.

Each claim below was run with third-party cookies allowed and with them
blocked (`profile.cookie_controls_mode: 1` written into the profile before
the start). A control test shows that the setting is in effect: under a plain
web page, the stand-in's frame gets `vendor_probe` when allowed and no cookie
at all when blocked.

| Question                                                                                           | Result                                      | Test (`e2e/web-cells/`)                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| (a) Can an extension page, as top-level document, frame the site once the two headers are removed? | Yes.                                        | `mechanism.spec.ts` "(a) the extension page frames the site; nothing else is changed" |
| (a) Is anything else changed?                                                                      | No, see the list below.                     | same test                                                                             |
| (a) Is scoping the rule by initiator enough?                                                       | **No.** Scope it by tab.                    | `mechanism.spec.ts` "(a) a navigation the site starts inside the frame needs …"       |
| (b) Is the `SameSite=Lax` session cookie of a normal tab sent inside the frame, untouched?         | Yes, also with third-party cookies blocked. | `mechanism.spec.ts` "(b) the session cookie of a normal tab is sent inside the frame" |
| (b) Does signing in inside the frame work?                                                         | Yes, in both profiles.                      | `mechanism.spec.ts` "(b) signing in inside the frame works too"                       |
| (c) Can a content script limited to frames under the wall fill, submit and read?                   | Yes, for both kinds of input.               | `mechanism.spec.ts` "(c) the content script fills, submits and reads the answer"      |
| (c) Is it inert everywhere else?                                                                   | Yes.                                        | `mechanism.spec.ts` "(c) the content script is inert outside the wall"                |
| (d) Can the extension page call a server on another origin with a bearer token and read a stream?  | Yes, without any CORS header.               | `server.spec.ts`, every test                                                          |

Details that matter for part 2:

- **(a) What "nothing else is changed" means, as tested.** Without the rule
  the browser refuses the frame (its document is `chrome-error://…`). With
  the rule installed and the wall open, a plain web page in another tab that
  frames the site is still refused. Inside the wall's own frame, and in an
  ordinary tab, `fetch('/')` still sees both headers: only the frame's
  document (`resourceTypes: ['sub_frame']`) is touched. Closing the wall tab
  removes the rule (the worker listens to `tabs.onRemoved`).
- **(a) Scope the rule by tab, not by initiator.** With
  `initiatorDomains: [chrome.runtime.id]` the first load works, but a
  navigation the site starts inside the frame (the sign-in form's POST and
  its redirect, in the test) has the site as its initiator, keeps its
  headers and is refused. A **session rule with `tabIds: [<the wall's tab>]`**
  covers every sub-frame request of that tab and of no other. That is the
  rule the test extension installs (`extension/wall.js`, `installRule`).
  The real extension adds `initiatorDomains: [<extension id>, ...<listed
hosts>]` to the same condition (`apps/extension/src/shared/frame-rule.ts`):
  the tab **and** an initiator that is the wall page or a listed site, so
  that a page of any other site that ends up in the wall's tab gets nothing.
  Signing in inside the frame works with it (`e2e/extension/wall.spec.ts`).
  The test extension's rule:

  ```js
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { tabIds: [tabId], requestDomains: [host], resourceTypes: ['sub_frame'] },
      },
    ],
  });
  ```

  Permissions: `declarativeNetRequestWithHostAccess` plus host permission for
  the site. Session rules are gone after a browser restart; the wall page
  installs its rule on every load. The whole `Content-Security-Policy` header
  goes, not only `frame-ancestors` (the API cannot edit a header's value), so
  inside that one frame the site runs without its own policy. That is a real
  cost and belongs in the user docs.

- **(b) What the site receives.** The frame's document request, as recorded
  by the stand-in: `Cookie` with `vendor_session`, `vendor_strict` and
  `vendor_probe`; `Sec-Fetch-Dest: iframe`; `Sec-Fetch-Mode: navigate`;
  `Sec-Fetch-Site: cross-site`. Requests the framed page makes itself are
  ordinary same-origin requests (`Sec-Fetch-Site: same-origin`, the site's
  own `Origin` and `Referer`). The cookies in the profile are identical
  before and after (name, value, attributes): the extension has no `cookies`
  permission and nothing touches them. `localStorage` written by an ordinary
  tab is read by the frame: storage is the site's own, not a partition.
  **A site can see `Sec-Fetch-Dest: iframe` and refuse on its server.** The
  extension must never change that or any other request header.
- **(c) The content script** (`extension/content.js`) is declared for the
  site's host with `all_frames: true` and returns at once unless
  `window.parent === window.top`, `location.ancestorOrigins` has exactly one
  entry and that entry is `chrome-extension://<own id>`. The wall page takes
  a port only from a sender whose tab is its own. In an ordinary tab and
  under a plain web page the script leaves no mark and connects to nothing.
  Filling uses the native value setter (or `textContent` for a
  `contenteditable`) followed by an `InputEvent`; that is enough for the
  stand-in, and proves nothing about a real site's editor.
- **(d) What a server receives from an extension page with host
  permission.** `POST`: `Origin: chrome-extension://<id>`,
  `Sec-Fetch-Site: none`, `Sec-Fetch-Mode: cors`. `GET`: **no `Origin`
  header**, otherwise the same. No cookie unless the page asks for
  `credentials: 'include'`. The response is readable without any
  `Access-Control-*` header, streamed bodies included
  (`Cross-Origin-Resource-Policy: same-origin` on the server's responses does
  not get in the way). A plain web page on a third origin gets a `TypeError`
  for the same requests.
- **The web UI as an extension page.** The stock UI, built from its `embed`
  entry into the test extension, pairs through its sign-in page, keeps the
  token in `chrome.storage.local`, asks, streams, navigates, survives a
  reload on `#/settings`, and signs out. It runs under the default
  extension-page CSP of Manifest V3 with no console error.

## 2. The contract the extension builds against

### 2.1 Settings

`GET/PUT /api/settings`, section `webCells` (merged field by field):

```ts
webCells: {
  enabled: boolean;       // master switch
  fillPrompt: boolean;    // the extension may type and submit; the extension enforces it
  readAnswer: boolean;    // the extension may read the answer; the server enforces it too
  extensionIds: string[]; // exact ids, /^[a-p]{32}$/, at most 8, no wildcard
}
```

All off and empty by default. A web provider is an entry of `providers`:

```ts
{ id: 'web-<site>', kind: 'web', site, label, enabled, concurrency, models: [] }
```

`site` is one of `WEB_SITES` in `packages/core/src/protocol/web.ts`
(`claude`, `chatgpt`, `gemini`, `grok`, `zai`, each with its host and a
default label). The id must be `webProviderId(site)`, `models` must be empty
and `concurrency` is 1 to 8 (default 2). `GET /api/providers` lists it with
`detection: null`, `models: []`, `toolAccess: 'unrestricted'`.

The settings page has the section (**Settings > Web cells**, English and
zh-TW): the three switches, the id list, one checkbox per site. The
providers page shows no card for a web provider.

### 2.2 Becoming a client

1. The user adds the extension's id under **Settings > Web cells** on a
   device that is already signed in, and switches web cells on.
2. The extension page sends `POST /api/auth/pair` with
   `{ code, deviceName }`, `Content-Type: application/json` and
   `credentials: 'omit'`. The browser adds `Origin: chrome-extension://<id>`.
3. The answer is `{ device, token }` and sets no cookie. The token is the
   device token; keep it in `chrome.storage.local` and send it as
   `Authorization: Bearer <token>` on every request.

What the server refuses (`403 forbidden`): an extension origin while web
cells are off or whose id is not listed; an extension origin together with
the session cookie. `POST /api/auth/session` (checking a token the user
typed) and `POST /api/auth/logout` work for an extension and set no cookie.
A `401` means the token is dead: forget it (the remote connection in
`packages/web` does), because presenting it again counts against the failed
sign-in limit of 10 per minute.

Because a `GET` carries no `Origin`, switching web cells off stops an
extension's writes at once but not its reads; revoke the device under
**Settings > Devices** to end those.

### 2.3 Asking

`POST /api/ask` with `runsWebSlots: true` when any target is a web provider:

```json
{
  "prompt": "…",
  "targets": [
    { "slotId": "w1", "providerId": "web-claude" },
    { "slotId": "c1", "providerId": "claude" }
  ],
  "runsWebSlots": true
}
```

| Refusal                   | When                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `400 web_client_required` | A web target without `runsWebSlots: true`.                        |
| `400 provider_disabled`   | Web cells off, reading answers off, or the web provider disabled. |
| `400 unknown_provider`    | No such provider (the site was never added).                      |

`model` and `effort` of a web target are ignored and not recorded. With
`readAnswer` off the server takes no web slot at all, so the extension then
shows its web cells without putting them into the ask (and, with nothing but
web cells on the wall, sends no ask).

### 2.4 Running a web slot

The stream (`GET /api/ask/:askId/stream`, read with `fetch`) carries the
normal events for the slot:

```
queued?  ->  start { streaming: 'block', at }  ->  [delta]  ->  done | error | cancelled | timeout
```

- **Wait for `start`.** A web slot waits for a permit of its provider like
  any slot; `concurrency` bounds the frames of one site answering at once.
  Do nothing in the frame while the slot is `queued`.
- **After `start`:** fill in and submit the prompt (when `fillPrompt` is
  on), wait for the answer to finish, read it, and submit the result. The
  server measures the time from `start`; the slot timeout
  (`limits.slotTimeoutMs`, 5 minutes by default) ends it with `timeout`.
- **Watch the stream while working.** `cancelled` (any device may cancel),
  `timeout` and `error` (a server restart) end the slot from outside: stop,
  and do not submit.

`POST /api/ask/:askId/slots/:slotId/result`, one of:

```json
{ "outcome": "done", "text": "the answer, plain text or Markdown" }
{ "outcome": "failed", "code": "not_logged_in", "message": "optional, at most 500 characters" }
{ "outcome": "cancelled", "reason": "optional, at most 500 characters" }
```

`code` is one of `not_logged_in`, `quota`, `rate_limited`, `network`,
`prompt_too_long`, `bad_output` (the site rule found no input, no submit
control or no answer), `unsupported` (the site cannot be shown or driven
here), `unknown`. They are the slot error codes every cell already has
messages for.

Answer `200 { status: 'done' | 'error' | 'cancelled', truncated }`. What the
other devices then see in the stream: for `done`, one `delta` with the text
and `done`; for `failed`, `error` with the code and message; for
`cancelled`, a `provider` notice with the reason (when given) and
`cancelled`.

| Status                  | Meaning                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `200`                   | Accepted, or the same result sent again (safe to retry after a lost response).                     |
| `400 bad_request`       | Malformed body, empty `text`, a `code` outside the list, or the slot is not a web slot.            |
| `403 forbidden`         | The caller did not create the ask; or `done` while reading answers is switched off.                |
| `404 not_found`         | No such ask or slot.                                                                               |
| `409 conflict`          | The slot is still queued, has ended (cancel, timeout, restart), or already has a different result. |
| `413 payload_too_large` | The request is larger than `limits.maxRequestBodyBytes` (1 MiB by default).                        |

Bounds: `text` beyond `limits.maxOutputBytesPerSlot` (2 MiB by default) is
cut on a character boundary and flagged (`truncated: true`, the
`output_truncated` notice). The request body limit is smaller by default, so
an answer between the two is refused with `413`: cut it in the extension, or
report `failed`.

"The caller that created the ask" is the device (or the static token) that
sent `POST /api/ask`. A reloaded wall page of the same extension is the same
device and may still submit. Once the ask has left the server's memory (it
keeps the last few finished asks) a repeated result is a `409`.

When a site rule fails, DECISIONS §11 wants the cell to stay usable by hand
and the answer not stored: submit `failed` with `bad_output`, and leave the
frame alone.

### 2.5 The web UI on the extension's origin

```ts
import { mountEmbedded } from '@answerwall/web/embed';

mountEmbedded({
  root, // HTMLElement
  server, // the server's origin, e.g. 'https://wall.example.com'
  tokens, // { get(): string | undefined | Promise<…>; set(token | undefined): void | Promise<void> }
  webCells, // a WebCellHost: this page can frame the vendors' sites
});
```

It returns `{ services, unmount }`. In this mode
(`packages/web/src/infra/connection.ts`, `services.ts`):

- every request, the event stream included, goes to `server` with
  `Authorization: Bearer` and `credentials: 'omit'`; a request to any other
  origin is refused before it is sent;
- `api.pair` stores the returned token and does not pass it on; `api.signIn`
  stores the typed token once the server accepted it; `api.logout` forgets
  it; a `401` for the current token forgets it;
- routes live in the fragment (`#/history`), plain links to a route point
  there too (`hrefOf` in `contracts/routes.ts`), no service worker is
  registered, and the page is "stale" only when `apiVersion` differs (the
  status screen then asks for an update instead of reloading);
- `services.remote` is `true`, and `services.webCells` is the host.

`@answerwall/web/embed` is exported for the `answerwall-source` condition
only: the consumer builds it from source with Vite (`apps/extension/build.mjs`).

### 2.6 Web cells in the wall

The wall (`packages/web/src/wall`) knows web cells through one interface,
`WebCellHost` in `contracts/services.ts`, which only the extension's page
provides:

```ts
interface WebCellHost {
  site(site: WebSiteId): { url: string; verified: boolean } | undefined;
  attach(frame: HTMLIFrameElement, site: WebSiteId): WebCellFrame;
}
interface WebCellFrame {
  connection(): 'loading' | 'ready' | 'unreachable';
  run(options: { prompt; fill; read; signal; onStage? }): Promise<WebCellRunResult>;
  dispose(): void;
}
```

- **With a host**, a cell whose provider is a web provider renders the frame
  (`components/WebCellFrame.tsx`: the `<iframe>`, reload, open in a tab, the
  connection, the "Unverified rule" mark) and no model picker. The frame is
  keyed by the site alone, so it survives every other change to the
  provider.
- **`wall/state/web-runner.ts`** joins frames and slots for the ask this
  wall sent: `follow(askId, prompt, slots)` runs a web slot's frame once the
  slot is `running`, submits `done` / `failed` / `cancelled`, and stops
  waiting when the slot ended some other way. The slots it started are
  remembered in the session storage, so a reloaded page cancels a running
  slot with a reason instead of typing again. An answer larger than
  `limits.maxRequestBodyBytes` is cut to fit, with a marker line.
- **The switches** (`WallPage.tsx`): with `readAnswer` on, web cells are
  targets of the ask and the request carries `runsWebSlots`. With it off
  they are left out; `fillPrompt` then still types the prompt
  (`runner.fillOnly`) and the cell shows a local note. With both off, and
  nothing but web cells on the wall, Send is disabled with a reason.
- **Without a host** (the server's own page, the desktop app, the PWA) the
  providers store still lists web providers, and the wall treats them as
  `extension_only`: a notice in the cell, disabled in the pickers, left out
  of an ask and of a fresh wall. A stored ask shows the web slot's answer
  like any other.

Known behaviour that follows from this design: leaving the wall (another
page, or a past ask) unmounts the cells and therefore cancels web slots that
are running; dragging a web cell moves its frame in the document, which
reloads it.

### 2.7 The extension

| Path (`apps/extension/`)       | Content                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.mjs`                 | The manifest as data: permissions, hosts, the pages' content security policy, the public key that fixes the ID (`nffcmlcjkacklpololkpdmhcfokannom`). |
| `build.mjs`                    | Three Vite builds into one directory: the wall page, the content script and the worker (each one classic script). `--test` makes the test build.     |
| `rules/<site>.json`            | One rule per site of `WEB_SITES`, plus `standin.json` for the tests. `src/rules/schema.ts` says what a rule is and validates one.                    |
| `src/page/main.tsx`            | The wall page: first-run page or `mountEmbedded`, the header rule, the strip under the wall.                                                         |
| `src/page/pairing.ts`          | The server's address, the optional host permission, pairing, what is kept in `chrome.storage.local` (`server`, `deviceToken`).                       |
| `src/page/host.ts`             | `WebCellHost`: binds a content script's port to its frame, tracks the connection, one run at a time, resumes a read when the page was replaced.      |
| `src/content/main.ts`          | The content script: returns unless `isUnderWall`, then connects and runs the rule for its host.                                                      |
| `src/content/engine.ts`        | Applies a rule: find the message box, fill it, submit, wait for the new answer to finish, read it.                                                   |
| `src/content/markdown.ts`      | Rendered answer back to Markdown.                                                                                                                    |
| `src/shared/frame-rule.ts`     | The header rule, installing, removing and sweeping it.                                                                                               |
| `src/shared/storage-access.ts` | Closes `chrome.storage.local` to the content script (`TRUSTED_CONTEXTS`); called by the worker at every start and by the wall page.                  |
| `src/worker/main.ts`           | Opens the wall on a click on the toolbar button; removes the rule of a tab that no longer shows a wall.                                              |

**Frame and port.** A port from `chrome.runtime.connect` says which tab its
content script is in, not which frame element. The content script therefore
sends one random value twice: over the port, and with `postMessage` to its
parent, addressed to the extension's origin. The page uses a port only when
both arrived, the port is from its own tab, the message's `source` is the
window of one of its frames, and its origin is the site that frame was
opened for. A page's own script cannot open a port to the extension.

**A rule** lists selectors for the message box, the send control and the
answers, and says how to recognise "finished": no `busy` element anywhere,
the `done` mark when the rule has one, and text that stood still for
`quietMs`. Every list is tried in order; the first selector that matches is
used. What is on the page before a run is not its answer: a run reads the
answer that appears after it. Filling a field goes through the native value
setter and an `input` event; a rich editor gets a paste event, then
`execCommand('insertText')`, then its text content.

**The test build** (`node build.mjs --test`, used by `e2e/extension`) is the
same code with `__TEST_SITE__` set: the rule of the stand-in site takes the
place of the site `claude`, at the origin a test writes into the extension's
storage; the manifest also lists `http://vendor.localhost/*` and
`http://127.0.0.1/*` (a test cannot answer the permission prompt). A release
build contains none of it: `build.mjs`, the packaging script and a unit test
check that.

## 3. The test harness, and how to extend it

| Path                                   | Content                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `e2e/web-cells/extension/`             | The test extension: manifest, wall page, content script, worker. Plain files, no build.         |
| `e2e/web-cells/embedded/`              | The entry that mounts the web UI as a page of the test extension (`app/index.html?server=…`).   |
| `e2e/web-cells/support/vendor-site.ts` | The stand-in site; records every request it receives.                                           |
| `e2e/web-cells/support/fixtures.ts`    | A Chromium with a profile per test and the extension, the stand-in, a third origin, the server. |
| `e2e/web-cells/mechanism.spec.ts`      | Claims (a), (b), (c), each with third-party cookies allowed and blocked.                        |
| `e2e/web-cells/server.spec.ts`         | Claim (d) against the compiled server; the web UI as an extension page.                         |

The global setup copies the extension into the run directory and builds the
UI into `app/` there, so the source directory stays clean. The
`blockThirdPartyCookies` fixture option writes the profile preference before
the browser starts.

The extension itself is tested in the project `extension`
(`pnpm --filter ./e2e test:extension`):

| Path                                | Content                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/extension/support/fixtures.ts` | A Chromium with the test build of `apps/extension`, on top of the fixtures above.                                                                         |
| `e2e/extension/wall.spec.ts`        | First run and pairing, a mixed ask, both kinds of message box, a failing rule, the switches, cancel, sign-in inside a cell, the reach of the header rule. |

The global setup builds the test build into the run directory. The stand-in
answers slowly for a prompt that contains `[slow]`, and `?layout=changed`
serves the same chat page under other ids, which the stand-in's rule no
longer finds.

## 4. Open questions and limits of the evidence

1. **Real sites.** Nothing was tried against one, on purpose. Known ways a
   site can still refuse: answering differently to `Sec-Fetch-Dest: iframe`;
   script that compares `top` with `self`; a sign-in that leaves for another
   host (an identity provider) whose pages would also need the header rule.
   Signing in in a normal tab first avoids the last one and is what the
   tests do.
2. **Real cookies.** The stand-in is plain HTTP on a `localhost` name. Real
   sites use HTTPS, `Secure`, sometimes `__Host-` prefixes or partitioned
   cookies. `SameSite=Lax`, `Strict` and `None; Secure` were all sent in the
   frame here; partitioned cookies and the Storage Access API were not
   looked at.
3. **Other browsers and platforms.** Edge, branded Chrome, headed mode,
   Windows and macOS are untested. Branded Chrome no longer accepts
   `--load-extension`, so the tests need Playwright's Chromium. Whether Edge
   sends `chrome-extension://` as the origin of its extensions was not
   checked; the server's allowlist matches that scheme only.
4. **The CI leg on Windows** has not run with the `web-cells` project. It
   relies on Chromium resolving `*.localhost` to loopback by itself.
5. **A server that is not on loopback.** From an extension page to plain
   HTTP on a LAN address, or to HTTPS with a private CA, nothing was tested:
   mixed-content rules and the browser's local-network permission may apply.
6. **`optional_host_permissions`.** The extension asks for the server's
   origin when the user pairs (`chrome.permissions.request`). No automated
   test can answer that prompt, so the test build declares the loopback
   server in its manifest and the request itself is covered only by unit
   tests with a fake permissions API and by the hand check.
7. **Markdown.** The content script reconstructs Markdown from the rendered
   answer (`src/content/markdown.ts`, unit-tested on hand-written markup).
   How well that fits each site's real markup is unknown until checked.
8. **Finished detection** in the stand-in is an attribute the page sets.
   The real rules rely on a "stop" control being present while the site
   answers and on the text standing still; whether those selectors match,
   and whether a model that pauses mid-answer is read too early, is unknown.
9. **`fillPrompt` is enforced only by the extension.** The server stores the
   switch; it cannot know whether a prompt was typed by hand.
10. **The removed policy.** Removing the site's `Content-Security-Policy`
    for its frame weakens that page's own defences inside the frame. No
    narrower rule is possible with `declarativeNetRequest`.
11. **Rules for real sites.** All five were written from the publicly
    visible page structure and from general knowledge of these apps, without
    signing in and without running them. Expect several to be wrong in
    detail. Quota and rate-limit pages are not recognised.
12. **Reordering and leaving the wall.** Moving a frame in the document
    reloads it; leaving the wall cancels running web slots (§2.6).
13. **The worker's second line.** The wall page removes its header rule on
    `pagehide`, and the rule's initiator condition already excludes other
    sites; the worker's sweep on `tabs.onUpdated` is a further safeguard
    whose timing against a fast navigation was not measured.
14. **Edge.** Whether Edge sends `chrome-extension://` as the origin of its
    extensions was not checked; the server's allowlist matches that scheme
    only. Edge may also derive a different ID from the same key.
