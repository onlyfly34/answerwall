#!/bin/sh
# Health check of the container: GET /api/meta on loopback, inside the
# container. The route is public and starts nothing.
#
# The scheme follows ANSWERWALL_TLS; the other one is tried as well, for a
# server whose TLS mode was given as a command-line flag. The certificate is
# not verified: this is the server asking itself whether it answers, and with
# a certificate for a public name the name "127.0.0.1" would never match.
set -u

port="${ANSWERWALL_PORT:-7717}"
case "${ANSWERWALL_TLS:-off}" in
  auto | cert) first=https second=http ;;
  *) first=http second=https ;;
esac

probe() {
  curl --fail --silent --show-error --insecure --max-time 2 --output /dev/null \
    "$1://127.0.0.1:$port/api/meta" 2>/dev/null
}

probe "$first" || probe "$second"
