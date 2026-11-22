#!/bin/sh
# Entry point of the container, started by tini.
#
#   (no arguments), serve, pair, --flags   -> the answerwall command
#   anything else                          -> run as given (a shell, the CLI
#                                             install helper, a CLI's login)
#
# It changes no setting and reads no credential. It only refuses to start
# when a volume is not writable, because the server would otherwise fail
# later with an error that names neither the directory nor the user id.
set -eu

data_dir="${ANSWERWALL_DATA_DIR:-/data}"

check_writable() {
  if [ ! -d "$1" ] || [ ! -w "$1" ]; then
    echo "answerwall: $1 ($2) is not writable by user id $(id -u), group id $(id -g)." >&2
    echo "answerwall: give that directory to this user id, or see \"User and group id\" in docs/deploy-docker.md." >&2
    exit 78
  fi
}

run_server() {
  check_writable "$data_dir" "the data directory"
  check_writable "$HOME" "the home directory, where the AI command-line tools live"
  exec answerwall "$@"
}

case "${1:-serve}" in
  serve | pair | help | -*) run_server "$@" ;;
  *) exec "$@" ;;
esac
