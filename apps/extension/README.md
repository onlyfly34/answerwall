# The browser extension

The extension for web cells: a wall page that is the AnswerWall web UI
(`packages/web`, mounted through its `embed` entry) and that shows the
vendors' own web apps as frames next to the other cells. Chrome and Edge,
Manifest V3. Off by default on the server, loaded unpacked, in no store.

For users: [docs/providers.md](../../docs/providers.md#web-cells) (what it
does and does not do, the exact permissions, installing, the two switches)
and [docs/verify-web-cells.md](../../docs/verify-web-cells.md) (checking a
site by hand). For developers: [docs/web-cells.md](../../docs/web-cells.md).

The terms of the vendors restrict automated access to their web apps.
Nothing in this directory says that using them this way is permitted.

```
pnpm --filter @answerwall/extension build     # dist/, the folder to load unpacked
pnpm vitest run --project extension           # unit tests
pnpm --filter ./e2e test:extension            # in a real Chromium, against the stand-in site
node build.mjs --out <dir> --test             # the test build (stand-in site), for tests only
```

| Path           | Content                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `manifest.mjs` | The manifest as data: the whole permission list, and the key for the ID |
| `rules/`       | One data file per site: where its message box and its answers are       |
| `src/page/`    | The wall page: first run, pairing, the frames of the web cells          |
| `src/content/` | The content script: applies a rule to the page it is framed in          |
| `src/worker/`  | The service worker: opens the wall, removes stale header rules          |
| `src/shared/`  | The header rule, and the messages between page and content script       |

Every rule for a real site is marked `"verified": false` until someone has
checked it by hand: no rule has been run against a real site by the
project's tests, and none may be.
