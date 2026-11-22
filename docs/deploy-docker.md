# Running AnswerWall in Docker

The server image holds AnswerWall and nothing else: the compiled server, the
web UI and a Node runtime. It contains **no** AI command-line tool and no
login. You install the tools you want into a volume, with each vendor's own
installer, and sign in to each of them yourself.

The files this page refers to are in [`docker/`](../docker):

| File                 | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `compose.yaml`       | The service, hardened, with built-in TLS on loopback.        |
| `compose.proxy.yaml` | Addition for a reverse proxy that terminates TLS.            |
| `compose.cert.yaml`  | Addition for your own certificate files.                     |
| `.env.example`       | Every setting, commented. Copy it to `.env`.                 |
| `nginx.conf.example` | A reverse proxy configuration that keeps answers streaming.  |
| `test/smoke.mjs`     | The test that builds the image and drives it with mock CLIs. |

The image is built for `linux/amd64` and `linux/arm64`. It is about 90 MB to
download and 370 MB on disk.

## Quick start

Until a release has published the image to
`ghcr.io/onlyfly34/answerwall`, build it from a clone of the repository:

```
git clone https://github.com/onlyfly34/answerwall.git
cd answerwall/docker
cp .env.example .env
docker compose build
docker compose up -d
docker compose logs
```

With a published image, `docker compose up -d` pulls it and the `build` step
is not needed; set `ANSWERWALL_IMAGE` in `.env` to a version instead of
`latest` if you want to decide when to upgrade.

The log shows a line like this while no device is paired:

```
WARN  No device is paired yet. Pair the first device with this one-time code: 1234 5678
```

Open <https://localhost:7717> on the Docker host and enter the code. It is
valid for five minutes and for one device; `docker compose exec answerwall
answerwall pair` prints a new one at any time.

The browser warns about the certificate on the first visit, because the
server made its own certificate authority (CA) when it started. Either accept
the warning for now and download the CA certificate from the settings page
later, or install it before the first visit:

```
docker compose exec answerwall cat /data/tls/ca.crt > answerwall-ca.crt
```

`answerwall-ca.crt` is a public certificate, not a secret. Import it as a
trusted certificate authority in the browser or the operating system of every
device that should open AnswerWall. The settings page lists the steps per
platform.

Nothing can answer yet: continue with [Installing the
command-line tools](#installing-the-command-line-tools), or add an
OpenAI-compatible endpoint in the settings.

### Why there is no plain-HTTP quick start

Inside the container the server listens on every interface, so it treats a
plain-HTTP connection as coming from the network: it refuses it unless it
comes from the container's own loopback or from a listed reverse proxy. A
request from the Docker host to the published port does not arrive from
loopback but from the gateway address of the Docker network. Asking
`http://localhost:7717` of a server started with `ANSWERWALL_TLS=off` and no
trusted proxy therefore answers:

```
{"error":{"code":"forbidden","message":"Plain HTTP is accepted only from this machine or a trusted proxy"}}
```

So the image defaults to `ANSWERWALL_TLS=auto` (the server's own default
outside Docker is `off`). Use setup A below when something else terminates
TLS.

## The three setups

Who can reach the server at all is decided by `PUBLISH_ADDRESS` in `.env`:
`127.0.0.1` (the default) publishes the port only on the Docker host itself.
Every setup signs devices in by pairing; there is no way to turn
authentication off.

### A. Behind a reverse proxy that terminates TLS

The proxy owns the certificate and talks plain HTTP to AnswerWall.

```
COMPOSE_FILE=compose.yaml:compose.proxy.yaml
ANSWERWALL_PUBLIC_ORIGINS=https://wall.example.com
```

`compose.proxy.yaml` turns TLS off, gives the project's network a fixed
subnet (`PROXY_SUBNET`, default `172.30.77.0/24`) and trusts that subnet's
gateway (`ANSWERWALL_TRUSTED_PROXIES`, default `172.30.77.1`). The gateway is
how a proxy that runs on the Docker host and connects to `127.0.0.1:7717`
appears to the container. If Docker reports that the subnet overlaps with an
existing network, choose another free private range and set both variables.

- `ANSWERWALL_PUBLIC_ORIGINS` is the address in the browser's address bar,
  scheme included, with the port if it is not 443. Requests under any other
  host name are refused.
- `X-Forwarded-For` and `X-Forwarded-Proto` are believed only from the
  addresses in `ANSWERWALL_TRUSTED_PROXIES`. The proxy must send
  `X-Forwarded-Proto: https`, or the session cookie is not marked `Secure`.
- Keep `PUBLISH_ADDRESS=127.0.0.1`. On some Docker configurations every
  connection to a published port arrives from the gateway; a port published
  to other machines would then be trusted like the proxy.
- A proxy that runs in a container instead: attach it to this project's
  network (`answerwall_default`), let it reach `http://answerwall:7717`, and
  set `ANSWERWALL_TRUSTED_PROXIES` to that container's address. The port then
  needs no publishing at all.

A configuration for nginx is in
[`docker/nginx.conf.example`](../docker/nginx.conf.example). The part that
matters for streamed answers:

```nginx
location / {
  proxy_pass http://127.0.0.1:7717;
  proxy_http_version 1.1;
  proxy_set_header Connection "";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  proxy_buffering off;
  proxy_cache off;
  gzip off;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;
}
```

Answers arrive as a server-sent event stream over an ordinary HTTP response.
WebSocket support is not needed. What a proxy must not do is hold the
response back (buffering), cache or compress it, or close it while an answer
is still being written. The server sends a comment line every 15 seconds, so
an idle timeout longer than that is never reached while it is alive; the long
read timeout only protects slow answers from a proxy that counts differently.
For another proxy, look for the same three things: no response buffering, no
compression of `text/event-stream`, a generous read timeout.

### B. Built-in TLS with a private CA (the default)

Nothing to configure for `https://localhost:7717` on the Docker host. To use
it from other machines, publish the port on a reachable address and tell the
server its names:

```
PUBLISH_ADDRESS=0.0.0.0
ANSWERWALL_TLS_HOSTNAMES=wall.home.arpa,192.168.1.20
ANSWERWALL_PUBLIC_ORIGINS=https://wall.home.arpa:7717,https://192.168.1.20:7717
```

`ANSWERWALL_TLS_HOSTNAMES` are the DNS names and IP addresses the certificate
is issued for (the loopback names are always included);
`ANSWERWALL_PUBLIC_ORIGINS` are the addresses browsers will use. After a
change, `docker compose up -d` issues a new server certificate from the same
CA, so devices that already trust the CA need nothing new.

Every device has to trust the CA certificate once (see the quick start). The
CA's private key never leaves the data volume.

### C. Your own certificate

```
COMPOSE_FILE=compose.yaml:compose.cert.yaml
TLS_CERT_DIR=/srv/answerwall/certs
ANSWERWALL_PUBLIC_ORIGINS=https://wall.example.com:7717
PUBLISH_ADDRESS=0.0.0.0
```

`TLS_CERT_DIR` is a directory on the Docker host that holds
`fullchain.pem` and `privkey.pem` (other names: `TLS_CERT_FILE`,
`TLS_KEY_FILE`). It is mounted read-only at `/certs`.

- The files must be readable by the user the container runs as (user id 10001
  unless you changed it). A private key that only `root` can read does not
  load.
- They must be regular files inside that directory. The `live/` directory of
  certbot holds links into `../archive`, which do not resolve inside the
  container: copy the two files in a renewal hook instead.
- The server reloads the files when they change, so a renewal needs no
  restart. This is why the directory is mounted and not the two files: a
  renewal that replaces a file would be invisible through a file mount.

## First device and further devices

- First device: the code in `docker compose logs`, or a new one from
  `docker compose exec answerwall answerwall pair`. (With plain `docker`:
  `docker logs <container>` and `docker exec <container> answerwall pair`.)
- Further devices: a signed-in device creates a code on the settings page.
- A code is valid for five minutes, works once and is void after five wrong
  attempts. At most eight devices; each can be revoked on the settings page.
- `ANSWERWALL_TOKEN` in `.env` sets a static bearer token for scripts. Anyone
  who has it is signed in, so leave it unset unless you need it.

## Installing the command-line tools

The image contains none of them. `answerwall-install-cli` installs one, on
request, by running the installation command from the vendor's documentation,
unchanged, as the container's unprivileged user. It first prints that command,
the page it was copied from and the vendor's terms, and waits for you to type
`yes`:

```
docker compose exec answerwall answerwall-install-cli claude
docker compose exec answerwall answerwall-install-cli codex
docker compose exec answerwall answerwall-install-cli grok
docker compose exec answerwall answerwall-install-cli agy
```

`answerwall-install-cli --list` prints the same information without
installing anything. The helper never signs in, never reads or writes a
login, and passes none of AnswerWall's own settings to the installer. It is
never run automatically. You can just as well run a vendor's command yourself
in `docker compose exec answerwall bash`.

| Tool     | Command the helper runs                                        | Copied from                                       | Installs into                                  |
| -------- | -------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `claude` | `curl -fsSL https://claude.ai/install.sh \| bash`              | <https://code.claude.com/docs/en/setup>           | `~/.local/bin/claude`, `~/.local/share/claude` |
| `codex`  | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`        | <https://developers.openai.com/codex/cli>         | `~/.local/bin/codex`, `~/.codex/packages`      |
| `grok`   | `curl -fsSL https://x.ai/cli/install.sh \| bash`               | <https://docs.x.ai/build/overview>                | `~/.grok/bin/grok`                             |
| `agy`    | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | <https://antigravity.google/docs/getting-started> | `~/.local/bin/agy`                             |

`~` is `/home/answerwall`, the second volume. Both directories are on the
`PATH` of the container, after the system directories.

Architectures: every vendor publishes Linux builds for x86-64 and for 64-bit
ARM and for nothing else, and the helper refuses any other machine. Anthropic
states "x64 or ARM64 processor", OpenAI ships `x86_64` and `aarch64` release
archives, xAI states "Linux (x86_64 or arm64)". Google's documentation does
not list architectures for the CLI; its installer accepts `amd64` and `arm64`.

The vendors' terms, which the helper prints before it installs:

- Anthropic: <https://www.anthropic.com/legal/consumer-terms>,
  <https://www.anthropic.com/legal/commercial-terms>,
  <https://code.claude.com/docs/en/legal-and-compliance>
- OpenAI: <https://openai.com/policies/terms-of-use/>; the CLI's licence is
  <https://github.com/openai/codex/blob/main/LICENSE>
- xAI: <https://x.ai/legal/terms-of-service>; the CLI's licence is
  <https://github.com/xai-org/grok-build/blob/main/LICENSE>
- Google: <https://antigravity.google/terms>,
  <https://antigravity.google/docs/faq>

The project's [README](../README.md) quotes what these say about using a
subscription through another program. Read it before you sign in.

After an installation, press **Refresh** on the providers page.

### What was checked

On 2026-11-22, on a 64-bit ARM host, each of the four commands above was run
through the helper in a container started like `compose.yaml` starts it
(read-only root file system, no capabilities). Each tool then reported its
version to the container's user (claude 2.1.330, codex-cli 0.171.0, grok
1.0.92, agy 1.5.14), and AnswerWall's providers page reported `claude` and
`codex` as installed and not logged in, `grok` and `agy` as installed with an
unknown login state (neither has a command that reports it). `claude` and
`codex` were also installed and run under a user id without a name (see
[User and group id](#user-and-group-id)).

Not checked, because it needs an account: signing in inside the container,
and answering a question through a real tool inside the container. The
x86-64 installs were not run either.

## Signing in to each tool

AnswerWall never performs a login and never reads one. You run the vendor's
own login command in a terminal attached to the container; the login is
stored by the tool in the home volume and survives a re-create of the
container. A container has no browser, so each tool prints an address that
you open on your own machine.

```
docker compose exec answerwall claude auth login
docker compose exec answerwall codex login --device-auth
docker compose exec answerwall grok login --device-auth
```

(With plain `docker`, the same commands after `docker exec -it <container>`.)

- **claude** — `claude auth login` signs in with a Claude subscription
  (`--console` for a Console account). It cannot open a browser here: copy the
  address it shows, open it on your machine, sign in, and paste the code the
  page gives you back at the `Paste code here if prompted` prompt. Source:
  <https://code.claude.com/docs/en/authentication>.
- **codex** — `codex login --device-auth` prints an address and a one-time
  code; open the address on your machine and enter the code. OpenAI marks the
  device-code login as beta, and it has to be enabled first in the security
  settings of the ChatGPT account (or by the workspace admin). Plain
  `codex login` waits for a browser on `localhost:1455` of the container and
  cannot complete here. Source: <https://developers.openai.com/codex/auth>.
- **grok** — `grok login --device-auth` prints an address and a short code.
  Source: <https://docs.x.ai/build/overview>.
- **agy** — see below.

Then press **Refresh** on the providers page. To sign out, use the tool's own
command the same way (`claude auth logout`, `codex logout`, `grok logout`).

The providers page names `codex login` as the login command; in a container
use the `--device-auth` form above.

### agy in a container

`agy` keeps its Google sign-in in the operating system's keyring: on Linux
the Secret Service, reached over D-Bus
(<https://antigravity.google/docs/install>). The image has neither a D-Bus
session nor a keyring service, and nothing in the volumes would hold such a
login.

- What works: installing `agy` with the helper, `agy --version`, and
  AnswerWall detecting it as installed.
- What is not supported: signing in with a Google account inside the
  container. Whether the tool refuses, or accepts a sign-in that is lost with
  the process, was not tested, because it needs an account.
- What Google documents as alternatives without a keyring, untested here: an
  API key (`"modelProvider": "gemini"` in
  `~/.gemini/antigravity-cli/settings.json` plus the `GEMINI_API_KEY`
  variable, which you would add to the service's environment and allow with
  the provider's "use API key from environment" switch), or Application
  Default Credentials. Both are billed as API use, not through a consumer
  plan.

If you want `agy` with a Google account, run AnswerWall directly on a host
that has a desktop keyring instead of in this container. `agy` also stays
switched off in AnswerWall until you acknowledge Google's wording about
third-party tools on the providers page.

## Where the state lives

Two volumes, and nothing else, survive the container:

| Volume     | Mounted at         | Content                                                                                                                                                                                             |
| ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data`     | `/data`            | `answerwall.sqlite` (history, presets, settings, paired devices), `secrets.json` (API keys of endpoints, TLS private keys), `tls/` (certificates in setup B), `work/` (empty between asks).         |
| `cli-home` | `/home/answerwall` | The installed tools and everything they keep: `~/.local`, `~/.claude` and `~/.claude.json`, `~/.codex`, `~/.grok`, `~/.gemini`, `~/.cache`, `~/.config`. Each tool's login is in its own directory. |

Compose prefixes the names with the project: `answerwall_data` and
`answerwall_cli-home`. With `claude` and `codex` installed the home volume
holds about 850 MB, with all four tools about 1.3 GB.

Everything else in the container is read-only or temporary: the root file
system cannot be written, and `/tmp` is a memory file system that is empty
after a restart.

## Upgrading

AnswerWall:

```
docker compose pull        # or: git pull && docker compose build
docker compose up -d
```

The volumes are kept. The database is migrated forward at start; a newer
database cannot be opened by an older image, so make a backup before a
version jump you might want to undo.

The tools: each lives in the home volume and is upgraded the vendor's way,
with its own update command:

```
docker compose exec answerwall claude update
docker compose exec answerwall codex update
docker compose exec answerwall grok update
docker compose exec answerwall agy update
```

These commands are listed in each tool's `--help`; they were not run for this
page. Running the helper again does the same for `claude`, `codex` and
`grok`, whose installers replace an existing installation. Press **Refresh**
on the providers page afterwards. A new image never changes an installed
tool, and a tool update never needs a new image.

## Backup

Both volumes contain secrets (`secrets.json`, the CA's private key, each
tool's login). Treat a backup like a password store.

```
docker compose stop
docker run --rm -v answerwall_data:/data:ro -v "$PWD":/backup \
  debian:trixie-slim tar -C /data -czf /backup/answerwall-data.tar.gz .
docker run --rm -v answerwall_cli-home:/home:ro -v "$PWD":/backup \
  debian:trixie-slim tar -C /home -czf /backup/answerwall-cli-home.tar.gz .
docker compose start
```

Stopping first gives a consistent copy of the database. The data volume is
the one that matters; the home volume can be rebuilt by installing and
signing in again. To restore, create the empty volumes with `docker compose
create`, then unpack each archive the same way with `tar -xzf` (without
`:ro`), and start.

## User and group id

Every process in the container runs as user id and group id **10001**; no
process runs as root, and the container has no capability to become it. With
the named volumes this needs no attention.

To keep the state in directories of the Docker host instead, owned by your
own user:

```
mkdir -p /srv/answerwall/data /srv/answerwall/home
```

```
DATA_VOLUME=/srv/answerwall/data
CLI_HOME_VOLUME=/srv/answerwall/home
CONTAINER_USER=1000:1000
```

`CONTAINER_USER` is the output of `id -u` and `id -g` of the owner of the
two directories. The user needs no name inside the container; `claude` and
`codex` were installed and run this way. When a directory is not writable,
the container stops at once and says which directory and which user id.

Two other ways to the same end:

- Keep the image's user and give the directories to it:
  `chown -R 10001:10001 /srv/answerwall`.
- Build an image whose user has your ids:
  `docker build -f apps/server/Dockerfile --build-arg ANSWERWALL_UID=1000
--build-arg ANSWERWALL_GID=1000 -t answerwall:local .`, then set
  `ANSWERWALL_IMAGE=answerwall:local` and `CONTAINER_USER=1000:1000`.

Do not switch `CONTAINER_USER` on existing named volumes: their files belong
to the previous user id.

## What the container can and cannot reach

The container is the security boundary around the command-line tools.
AnswerWall starts each tool with its tools switched off as far as the vendor
allows (the README lists what remains per tool; `agy` cannot be restricted).
Whatever a tool still does, it does inside this container.

It can read and write:

- the two volumes: the data directory and the home directory;
- `/tmp`, in memory.

It cannot read or write:

- your home directory, your files, your SSH keys, or the logins of tools
  installed on the Docker host: nothing of the host is mounted;
- the Docker socket;
- its own program files: the root file system is read-only;
- anything as root: no process runs as root, every capability is dropped and
  `no-new-privileges` is set.

What this does not cover, so that you can judge it:

- **The network is open.** The container can reach the internet (the tools
  need their vendors) and, like any container, other machines on your network
  and services on the Docker host that listen on its Docker bridge address.
  Restrict that with your firewall if it matters.
- **The server and the tools share one user.** A tool runs as the same user
  as AnswerWall, so a tool that reads files can read the data directory
  (history, `secrets.json`) and the other tools' logins in the home
  directory. The boundary is around the container, not inside it.
- **Do not add mounts.** Mounting a host directory, the Docker socket or the
  host network into this service removes the boundary for whatever you
  mounted.

## A local OpenAI-compatible endpoint on the Docker host

A model server on the Docker host (anything that speaks
`/v1/chat/completions`) is reached from the container as
`host.docker.internal`. Add the endpoint in the settings with a base URL like:

```
http://host.docker.internal:11434
```

- `compose.yaml` maps that name to the host (`extra_hosts`). On Linux it
  resolves to the address of Docker's default bridge, usually `172.17.0.1`.
- The model server must listen on that address (or on all interfaces). A
  server bound to `127.0.0.1` only is unreachable from any container: the
  providers page then shows "The endpoint could not be reached
  (ECONNREFUSED)".
- A host firewall must allow connections from Docker's networks to that port.
- An endpoint in another container: attach both to one network and use the
  service name instead.

An API key entered in the settings is stored in `secrets.json` in the data
volume. To supply it from the environment instead, add both
`ANSWERWALL_SECRET_PROVIDER_<ID>_API_KEY` and
`ANSWERWALL_SECRET_PROVIDER_<ID>_API_KEY_ORIGIN` to the service's
`environment` in an additional compose file; the server README explains the
pair.

## Troubleshooting

**`Plain HTTP is accepted only from this machine or a trusted proxy` (403).**
TLS is off and the request did not come from a trusted proxy. See [Why there
is no plain-HTTP quick start](#why-there-is-no-plain-http-quick-start); with
setup A, check that `ANSWERWALL_TRUSTED_PROXIES` is the address the proxy
connects from. The request log shows it as `client=`.

**`This host name is not allowed` (403).** The browser used a name that is
not in `ANSWERWALL_PUBLIC_ORIGINS`. List every address you use, with scheme
and port. Behind a proxy, check that it passes the `Host` header on.

**The browser warns about the certificate.** In setup B, the device does not
trust the CA yet, or the name you typed is not in `ANSWERWALL_TLS_HOSTNAMES`.

**Answers appear all at once at the end.** A proxy buffers the response. See
the nginx settings in setup A.

**The container exits at once.** `docker compose logs` has the reason in one
line: an unknown `ANSWERWALL_` variable (a typo is never ignored), a setting
that does not fit the TLS mode, a certificate file that cannot be read, or a
volume that is not writable by the container's user id (exit code 78).

**`Pool overlaps with other one on this address space`.** The subnet of
`compose.proxy.yaml` is taken on this host. Set `PROXY_SUBNET` and
`ANSWERWALL_TRUSTED_PROXIES` to another private range.

**A tool is installed but shown as not installed.** Press **Refresh** on the
providers page; detection runs at start and on Refresh only. Check
`docker compose exec answerwall claude --version`.

**The pairing code expired.** `docker compose exec answerwall answerwall
pair`.

**The health check.** `docker compose ps` shows `healthy` when
`GET /api/meta` answers inside the container.
`docker compose exec answerwall answerwall-healthcheck; echo $?` runs it by
hand.

**codex and its sandbox.** `codex` isolates commands with user namespaces
(bubblewrap). In a container started with Docker's default security profile
these cannot be created: `codex sandbox -- /bin/true` fails here with "No
permissions to create a new namespace", with and without the hardening of
`compose.yaml`. AnswerWall starts `codex` with its shell switched off, so an
answer should not need the sandbox, but an answer from a signed-in `codex`
inside the container has not been verified. If `codex` fails in the
container and works on the host, this is the first place to look. Do not
"fix" it by running the container privileged or without its security
profile: that removes the boundary this page describes.

**grok and its sandbox.** `grok` is started with a read-only sandbox that it
applies on a best-effort basis. Whether it can be applied inside the
container was not tested.

## Building and testing the image

From the repository root:

```
docker build -f apps/server/Dockerfile -t answerwall:local .
node docker/test/smoke.mjs              # builds, then tests
node docker/test/smoke.mjs --all        # also setups A and C, with nginx
```

The test runs on Linux only and needs Docker with the compose plugin
(`--all` also needs `openssl` and pulls an nginx image). It starts
`compose.yaml` as shipped with the mock CLIs of `tools/mock-clis` mounted
in, pairs a device from the log and one with `answerwall pair`, sends an ask
across the four mocks, cancels and stops while mocks are running (some
ignore `SIGTERM`), checks that no process, work directory, container or
volume is left, that state survives a re-create, that the image contains no
AI command-line tool and no vendor SDK, and that nothing runs as root. It
never starts a real tool.

What the image contains, and why:

| Part                      | Reason                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Debian 13 "slim" (glibc)  | The vendors build their tools for glibc Linux. It already has `bash`, `tar`, `gzip` and checksum tools. |
| The Node binary           | Runs the server. No npm, no corepack, no yarn.                                                          |
| `/opt/answerwall`         | The same file tree as the released server bundle, with its production dependencies.                     |
| `ca-certificates`         | TLS to the vendors and to OpenAI-compatible endpoints.                                                  |
| `curl`                    | The vendors' installers are fetched with it and use it; the health check uses it.                       |
| `tini`                    | Process 1: forwards signals to the server and reaps processes a tool leaves behind.                     |
| `bash` (part of the base) | The installers of `claude`, `grok` and `agy` are bash scripts, and `claude` needs bash or zsh.          |
| No `git`                  | No tool needed it to install, to report its version or to report its login state.                       |

The build stage compiles the workspace with pnpm and then runs the release's
packaging script, so the image and the server bundle of a release hold the
same files, checked against `pnpm-lock.yaml`.
