# syntax=docker/dockerfile:1

# The server image. Build it from the repository root:
#
#   docker build -f apps/server/Dockerfile -t answerwall .
#
# It holds the compiled server, the compiled core library, the built web UI,
# their production dependencies and a Node runtime. It holds no AI
# command-line tool and no credential: those are installed and signed in by
# the user, into the volume mounted at the home directory (docs/deploy-docker.md).

ARG NODE_VERSION=24.22.3
ARG DEBIAN_RELEASE=trixie
ARG DEBIAN_SNAPSHOT=20261104

# The product name and repository live in packages/core/src/brand.ts. A
# Dockerfile cannot import them, so the build stage fails when these differ.
ARG IMAGE_TITLE=AnswerWall
ARG IMAGE_SOURCE=https://github.com/onlyfly34/answerwall
ARG CLI_NAME=answerwall
ARG PORT=7717

# ---------------------------------------------------------------- build
# Builds the workspace with pnpm, then runs the same packaging script as the
# release (.github/scripts/package-server.mjs): it stages the bundle and
# checks the npm lockfile it generates against pnpm-lock.yaml, so the image
# ships exactly the packages the tests ran against, none with an install
# script.
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS build

# zip: the packaging script also writes the release archives.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends zip \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1 \
    npm_config_update_notifier=false
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /src

# pnpm in the version of the packageManager field.
COPY package.json ./
RUN corepack enable pnpm && corepack install

# The store is filled from the lockfile alone, so a source change does not
# download anything again.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=answerwall-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm fetch

COPY . .
RUN --mount=type=cache,id=answerwall-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# The server and what it depends on (core, the web UI); not the desktop app,
# of which only the manifest is in the build context.
RUN pnpm --filter "@answerwall/server..." run build

ARG IMAGE_TITLE
ARG IMAGE_SOURCE
ARG CLI_NAME
ARG PORT
RUN node --input-type=module -e "\
import { BRAND } from '/src/packages/core/dist/brand.js'; \
const expected = { name: process.env.IMAGE_TITLE, repository: process.env.IMAGE_SOURCE, cliName: process.env.CLI_NAME, defaultPort: Number(process.env.PORT) }; \
for (const [key, value] of Object.entries(expected)) { \
  if (BRAND[key] !== value) { console.error('Dockerfile: ' + key + ' is ' + JSON.stringify(value) + ' but brand.ts says ' + JSON.stringify(BRAND[key])); process.exit(1); } \
}"

# BuildKit passes SOURCE_DATE_EPOCH when the builder sets it; the packaging
# script then stamps the files with it instead of the current time.
ARG SOURCE_DATE_EPOCH
RUN --mount=type=cache,id=answerwall-npm-cache,target=/root/.npm \
    node .github/scripts/package-server.mjs --out /out \
 && mv /out/*-server-*/ /out/app \
 && rm -f /out/*.tar.gz /out/*.zip
WORKDIR /out/app
RUN --mount=type=cache,id=answerwall-npm-cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# -------------------------------------------------------------- runtime
FROM debian:${DEBIAN_RELEASE}-${DEBIAN_SNAPSHOT}-slim AS runtime

# Debian (glibc) because the vendors publish their tools for it. Beyond the
# base system, which already has bash, tar, gzip and the checksum tools the
# vendors' installers call:
#   ca-certificates  TLS to the vendors and to OpenAI-compatible endpoints
#   curl             the vendors' installers are fetched and fetch with it;
#                    the health check uses it too
#   tini             PID 1: forwards signals and reaps what a CLI leaves behind
# git is not installed: none of the four tools needs it to install, to report
# its version or its login state (docs/deploy-docker.md says what was tested).
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# A fixed, unprivileged user. Rebuild with other values to match a host user
# (docs/deploy-docker.md, "User and group id").
ARG ANSWERWALL_UID=10001
ARG ANSWERWALL_GID=10001
ARG CLI_NAME
RUN groupadd --gid "$ANSWERWALL_GID" "$CLI_NAME" \
 && useradd --uid "$ANSWERWALL_UID" --gid "$ANSWERWALL_GID" \
      --home-dir "/home/$CLI_NAME" --create-home --shell /bin/bash "$CLI_NAME" \
 && mkdir /data \
 && chown "$ANSWERWALL_UID:$ANSWERWALL_GID" /data \
 && chmod 0700 /data "/home/$CLI_NAME"

# Only the Node binary: no npm, no corepack, no yarn.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /out/app /opt/answerwall
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/answerwall-entrypoint
COPY --chmod=0755 docker/healthcheck.sh /usr/local/bin/answerwall-healthcheck
COPY --chmod=0755 docker/install-cli.sh /usr/local/bin/answerwall-install-cli
RUN ln -s /opt/answerwall/dist/main.js "/usr/local/bin/$CLI_NAME" \
 && node --version \
 && "$CLI_NAME" --version

ARG PORT
# The vendors' installers put their tools into ~/.local/bin (claude, codex,
# agy), ~/.grok/bin (grok) and ~/.opencode/bin (opencode). They come last, so
# nothing in the volume can stand in for a system command.
ENV HOME=/home/answerwall \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/answerwall/.local/bin:/home/answerwall/.grok/bin:/home/answerwall/.opencode/bin \
    ANSWERWALL_HOST=0.0.0.0 \
    ANSWERWALL_PORT=${PORT} \
    ANSWERWALL_DATA_DIR=/data \
    ANSWERWALL_TLS=auto \
    ANSWERWALL_LOG_FORMAT=text

USER ${ANSWERWALL_UID}:${ANSWERWALL_GID}
WORKDIR /home/answerwall

# /data: database, secrets, generated certificates, work directories.
# /home/answerwall: the tools the user installs and each tool's own state and login.
VOLUME ["/data", "/home/answerwall"]
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["answerwall-healthcheck"]

ENTRYPOINT ["/usr/bin/tini", "--", "answerwall-entrypoint"]
CMD ["serve"]

ARG IMAGE_TITLE
ARG IMAGE_SOURCE
ARG VERSION=0.0.0
ARG REVISION=unknown
ARG CREATED=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.title="${IMAGE_TITLE}" \
      org.opencontainers.image.description="One prompt in, many answers side by side. The server and its web UI; AI command-line tools are not included." \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.url="${IMAGE_SOURCE}" \
      org.opencontainers.image.documentation="${IMAGE_SOURCE}/blob/main/docs/deploy-docker.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
