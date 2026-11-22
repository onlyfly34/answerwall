# AnswerWall server

The Node entry point: it reads the configuration, starts the core server and
serves the web UI and the API on one origin.

```
answerwall [serve] [options]   start the server
answerwall pair [options]      print a new pairing code for the running server
answerwall --help | --version
```

During development, `pnpm --filter @answerwall/server dev` runs the
TypeScript sources directly; `pnpm build` produces `dist/main.js`, which is
what the `answerwall` binary points to.

## Options

Every option is an environment variable; most also have a command-line flag,
which wins. An unknown `ANSWERWALL_*` variable stops the start, so a typo is
never silently ignored. Variables starting with `ANSWERWALL_SECRET_` belong to
the secret store and are not listed here.

| Variable                     | Flag                | Default            | Meaning                                                                         |
| ---------------------------- | ------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `ANSWERWALL_HOST`            | `--host`            | `127.0.0.1`        | Address to bind.                                                                |
| `ANSWERWALL_PORT`            | `--port`            | `7717`             | Port to bind; `0` picks a free one.                                             |
| `ANSWERWALL_DATA_DIR`        | `--data-dir`        | `~/.answerwall`    | Database, secrets, generated certificates, work directories.                    |
| `ANSWERWALL_WEB_ROOT`        | `--web-root`        | the bundled UI     | Directory of the built web UI; must contain `index.html`.                       |
| `ANSWERWALL_PUBLIC_ORIGINS`  | `--public-origins`  | derived, see below | Comma list of the origins browsers use (`https://wall.example.com`).            |
| `ANSWERWALL_TRUSTED_PROXIES` | `--trusted-proxies` | none               | Comma list of proxy addresses or CIDR ranges whose `X-Forwarded-*` is honoured. |
| `ANSWERWALL_TLS`             | `--tls`             | `off`              | `off`, `cert` or `auto`.                                                        |
| `ANSWERWALL_TLS_CERT`        | `--tls-cert`        |                    | PEM certificate chain, with `cert`.                                             |
| `ANSWERWALL_TLS_KEY`         | `--tls-key`         |                    | PEM private key, with `cert`.                                                   |
| `ANSWERWALL_TLS_HOSTNAMES`   | `--tls-hostnames`   | derived, see below | DNS names and IP addresses of the generated certificate, with `auto`.           |
| `ANSWERWALL_ALLOW_INSECURE`  | `--allow-insecure`  | `0`                | Accept plain HTTP from other machines.                                          |
| `ANSWERWALL_TOKEN`           | none                | none               | Static bearer token for automation, 16 to 512 characters.                       |
| `ANSWERWALL_LOG_LEVEL`       | `--log-level`       | `info`             | `debug`, `info`, `warn` or `error`.                                             |
| `ANSWERWALL_LOG_FORMAT`      | `--log-format`      | by terminal        | `json` or `text`; text on a terminal, JSON otherwise.                           |

The token has no flag on purpose: a command line is visible in the process
list.

Derived values:

- With `auto` and no `ANSWERWALL_TLS_HOSTNAMES`, the certificate is issued for
  the hosts of the `https` public origins and for the bind address when that
  is a specific one. The loopback names are always included.
- Without `ANSWERWALL_PUBLIC_ORIGINS`, the certificate names and a specific
  bind address are allowed as origins on the server's own port. Set the
  variable whenever browsers use another name or port, for example behind a
  proxy or a published container port.

## Signing in

There is no way to turn authentication off, and requests from the same
machine sign in like any other.

When no device is paired, the server writes a one-time pairing code to its
log at start. `answerwall pair`, run with the same data directory, prints a
new one at any time, also while the server is running. A code is valid for
five minutes, works once and is void after five wrong attempts. Signed-in
devices create codes for further devices in the settings page.

## TLS

- `off` serves plain HTTP. On a non-loopback address, connections from other
  machines are refused unless they come from a trusted proxy;
  `ANSWERWALL_ALLOW_INSECURE=1` lifts that and is announced with a warning.
- `cert` serves the given PEM files and picks up renewed files without a
  restart. An unusable replacement is ignored and the old certificate stays.
- `auto` creates a private certificate authority and a server certificate in
  the data directory. Devices must install the CA certificate, which the
  settings page offers for download.

## Behind a reverse proxy

The proxy owns the certificate and talks plain HTTP to AnswerWall:

```
ANSWERWALL_HOST=0.0.0.0
ANSWERWALL_TLS=off
ANSWERWALL_PUBLIC_ORIGINS=https://wall.example.com
ANSWERWALL_TRUSTED_PROXIES=172.18.0.0/16
```

A matching nginx server block:

```nginx
server {
  listen 443 ssl;
  server_name wall.example.com;
  ssl_certificate     /etc/ssl/wall.example.com/fullchain.pem;
  ssl_certificate_key /etc/ssl/wall.example.com/privkey.pem;

  location / {
    proxy_pass http://answerwall:7717;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Answers are streamed: no buffering, and no timeout shorter than a slow answer.
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

`X-Forwarded-For` and `X-Forwarded-Proto` are believed only when the
connection comes from an address in `ANSWERWALL_TRUSTED_PROXIES`.

## Shutdown

`SIGINT` or `SIGTERM` stops accepting requests, cancels running asks, ends
their child processes and closes the database. A second signal, or a shutdown
that takes longer than ten seconds, ends the process at once.
