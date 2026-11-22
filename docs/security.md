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
  come from the server's own pages. There is no cross-origin access at all.
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

| CLI      | The model's tools when AnswerWall runs it                                               |
| -------- | --------------------------------------------------------------------------------------- |
| `claude` | Off. Confirmed with the real CLI.                                                       |
| `codex`  | Almost all off; what remains runs in a read-only sandbox. Confirmed with the real CLI.  |
| `agy`    | Unrestricted. The model can act with the rights of the user the server runs as.         |
| `grok`   | Read-only sandbox on Linux and macOS, if the CLI can apply it. Unrestricted on Windows. |

A model with tools can be talked into using them by the text it reads,
including text you paste into a prompt. For `agy`, and for `grok` on
Windows, assume that anything your user can read or change is within reach.

- **In Docker the container is the boundary.** Only the data volume and the
  CLI home volume are mounted, never your home directory, and the process
  does not run as root. This is the place to run a CLI whose tools cannot be
  switched off.
- **On Windows there is no such boundary.** In local mode the CLIs run as
  you.
- With **Allow web search** on, the model reads web pages chosen by a search
  engine. AnswerWall enables only the search that runs on the vendor's
  servers, never a tool that fetches addresses from your machine.

Details per CLI: [providers.md](providers.md).

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
  account that runs the server can read the file. On Windows it is protected
  by the permissions of the data directory, so keep the data directory
  inside your user profile.
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
