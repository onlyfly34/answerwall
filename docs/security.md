# Security

[繁體中文](security.zh-TW.md)

What AnswerWall protects, how, and what it leaves to you. The engineering
detail is in [DECISIONS.md](DECISIONS.md) §7; every server option is in
[apps/server/README.md](../apps/server/README.md).

## What it is built for

One person, on machines that person controls. There are no user accounts
and no roles. A paired device can do everything: send prompts under your
vendor accounts, read the whole history, change settings, add endpoints,
pair further devices.

It does not protect against someone who can read the data directory or use
your operating-system account (the database is not encrypted), against a
device you paired and then lost without revoking it, or against what a
vendor CLI does with the rights of the user it runs as.

## Signing in

- Signing in cannot be switched off. Requests from the same machine sign in
  like any other.
- **First device.** When no device is paired, the server writes an 8-digit
  one-time code to its log when it starts. `answerwall pair`, run with the
  same data directory, prints a new one at any time.
- **Further devices.** **Settings > Devices > Create pairing code** on a
  device that is signed in.
- A code is valid for 5 minutes, works once, and is void after 5 wrong
  attempts.
- At most 8 devices. Each gets its own random token; the server stores only
  its SHA-256. **Revoke** signs a device out at once and also cuts the
  answer streams it has open (the ask itself keeps running). **Sign out**
  does the same for the device you are on.
- The browser holds the token in a cookie that script cannot read, sent only
  to the same site, and marked secure whenever the connection is HTTPS. It
  lasts 400 days from its last use.
- Failed attempts are limited to 10 per minute per address (adjustable).
- `ANSWERWALL_TOKEN` sets a static token for automation. It signs in without
  pairing, so treat it like a password and leave it unset unless you need
  it.
- A token never appears in a URL or in the log.

The **Windows app in local mode** works differently: its server listens on
`127.0.0.1` on a random port and accepts only a token that is generated at
every start and added to requests by the app itself, outside the page. It
has no paired devices and refuses to create pairing codes.

## Network exposure

- The server binds `127.0.0.1` unless you set `ANSWERWALL_HOST`. The Docker
  compose file publishes the port on `127.0.0.1` unless you change it.
- Every request must name a host the server knows: a loopback name, or one
  of `ANSWERWALL_PUBLIC_ORIGINS`. Every request that changes something must
  come from the server's own pages. A web page on another origin gets no
  access at all. The one exception is a browser extension you listed
  yourself, and only while web cells are switched on; see
  [Web cells and the browser extension](#web-cells-and-the-browser-extension).
- **Plain HTTP stays local.** With TLS off and a non-loopback address,
  connections from other machines are refused, except from a reverse proxy
  you listed in `ANSWERWALL_TRUSTED_PROXIES`.
  `ANSWERWALL_ALLOW_INSECURE=1` lifts this. Then anyone on the network path
  can read your prompts, answers and session, and the page shows a warning
  for as long as it is set.

### HTTPS

Three ways, in the order we would try them:

1. **A reverse proxy that owns the certificate** (`ANSWERWALL_TLS=off`,
   `ANSWERWALL_PUBLIC_ORIGINS`, `ANSWERWALL_TRUSTED_PROXIES`). Forwarded
   headers are believed only from the listed proxy addresses. A sample nginx
   block is in [apps/server/README.md](../apps/server/README.md#behind-a-reverse-proxy).
   Answers are streamed, so the proxy must not buffer.
2. **Your own certificate** (`ANSWERWALL_TLS=cert` with
   `ANSWERWALL_TLS_CERT` and `ANSWERWALL_TLS_KEY`). Renewed files are picked
   up without a restart.
3. **A generated private certificate authority** (`ANSWERWALL_TLS=auto`).
   The server creates a CA and a certificate for its names. Each device must
   install the CA certificate once: **Settings > Connection security**
   offers `answerwall-ca.crt` for download, with steps for Windows, macOS,
   iPhone and iPad, Android and Linux. The file holds no private key.
   Installing a CA is a real act of trust: keep the server's data directory
   as safe as you would keep any private key.

A phone needs HTTPS with a certificate it trusts before it will install the
page as an app.

## The CLIs

This is where most of the risk is. AnswerWall runs each CLI in the most
restricted way that CLI offers, in an empty directory, and removes its own
variables and, by default, API-key variables from the CLI's environment.
What remains differs per CLI:

| CLI        | The model's tools when AnswerWall runs it                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `claude`   | Off. Confirmed with the real CLI.                                                                                        |
| `codex`    | Almost all off; what remains runs in a read-only sandbox. Confirmed with the real CLI.                                   |
| `agy`      | Unrestricted. The model can act with the rights of the user the server runs as.                                          |
| `grok`     | Read-only sandbox on Linux and macOS, if the CLI can apply it. Unrestricted on Windows.                                  |
| `opencode` | Off, through an agent that denies every permission. Confirmed with the real CLI against a local test endpoint, on Linux. |

A model with tools can be talked into using them by the text it reads,
including text you paste into a prompt. For `agy`, and for `grok` on
Windows, assume that anything your user can read or change is within reach.

- **In Docker the container is the boundary.** Only the data volume and the
  CLI home volume are mounted (and, with your own certificate, its directory,
  read-only), never your home directory, and the process does not run as
  root. This is the place to run a CLI whose tools cannot be
  switched off.
- **On Windows there is no such boundary.** In local mode the CLIs run as
  you.
- With **Allow web search** on, the model reads web pages chosen by a search
  engine. AnswerWall enables only the search that runs on the vendor's
  servers, never a tool that fetches addresses from your machine.

Details per CLI: [providers.md](providers.md).

## Web cells and the browser extension

Off by default, and the extension is not part of a release yet; what is
described here is the server side, which exists.

A web cell shows a site's own web app inside the wall page of the AnswerWall
browser extension, in the browser where you are signed in to that site.
**Settings > Web cells** has a master switch, two separate switches for what
the extension may do on a site (fill in the prompt; read the answer), the
IDs of the extensions that may connect, and the sites.

- **Who may connect.** The extension's page is the only client on another
  origin the server accepts, only while web cells are on, and only for the
  extension IDs you listed. There is no wildcard. The server still sends no
  cross-origin (CORS) permission to anyone, so a web page on another origin
  can read nothing from it, whether an extension is listed or not.
- **How it signs in.** Like any device: with a pairing code. It gets its own
  token, keeps it in the extension's storage, where web pages cannot read
  it, and sends it with each request. It never gets the cookie, and a
  request from an extension that carries the cookie is refused. It appears
  under **Settings > Devices** and is revoked there.
- **What a listed extension can do.** Everything a paired device can. List
  only an extension you installed yourself from this repository. The
  browser names the extension on requests that change something, which is
  where the list is checked; reading always needs the token.
- **What the list cannot do.** An extension that the browser has given
  access to the server's address can read and change the server's own page,
  as it can any website, listed here or not. No server can prevent that.
  Keep the browser you use for AnswerWall free of extensions you do not
  trust.
- **The answer of a web cell** is text the extension read from a web page.
  It is treated like every other answer: stored as text, sanitised before it
  reaches a page. Only the device that created an ask can submit its web
  answers, once per cell, within the time limit and the answer size limit;
  any device can cancel.
- **What the server does not do.** It never contacts these sites, never
  sees your sign-in to them and never sees their cookies.
- **Terms.** These sites restrict automated access to their web apps, more
  explicitly than for their command-line tools. That is why filling in the
  prompt and reading the answer are separate switches that start off.
  AnswerWall makes no statement about what a site's terms permit.

## Answers and the page

Answers are untrusted text. They are rendered as Markdown and sanitised
before they reach the page; scripts and `javascript:` links are removed,
images are not loaded (they become links), and links open outside the app
without passing the page's address along. The content security policy
allows scripts, styles, images and connections from the server itself only,
and forbids framing.

## Secrets

- API keys for OpenAI-compatible endpoints and TLS private keys are in
  `secrets.json`, apart from the database. On Linux and macOS only the
  account that runs the server can read the file. A server run on Windows
  relies on the permissions of the data directory, so keep the data
  directory inside your user profile. The Windows app keeps its keys in a
  file of its own, encrypted by Windows for your user account, and stores
  nothing when that encryption is not available.
- The page can set or delete a key but never read it back.
- A stored key is tied to the address it was entered for; a key supplied
  through the environment is sent only to the origin you name next to it.
  See [providers.md](providers.md#a-key-from-the-environment).
- CLI logins are not AnswerWall's secrets: it never reads them.

## Limits

**Settings > Limits** holds bounds that keep a mistake or a leaked token
from starting processes without end: 32 cells per ask, 4 asks at once,
64 cells in the queue, 5 minutes per answer, 200 KiB per prompt, 2 MiB per
answer, by default. Each has a hard maximum the server enforces.

## The Windows installer is not signed

Windows cannot tell you who built it. Download it only from this
repository's Releases page and compare it with `SHA256SUMS` from the same
release. The checksum shows that the file is the one the release workflow
built, not who wrote it. See the
[README](../README.md#unsigned-windows-build) for SmartScreen and Smart App
Control.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use **Security >
Report a vulnerability** on the
[repository](https://github.com/onlyfly34/answerwall/security), which sends
a private report to the maintainer.
