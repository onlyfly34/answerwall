#!/bin/bash
# answerwall-install-cli: installs one AI command-line tool into the home
# volume of the container, with the vendor's own installer.
#
#   docker exec -it <container> answerwall-install-cli <claude|codex|grok|agy>
#
# It is never run automatically. For the tool you name it
#   1. prints the vendor's terms and the exact command it is about to run,
#   2. waits for you to type "yes" (or takes --yes),
#   3. runs that command, which is the installation command from the vendor's
#      documentation, unchanged, as the container's unprivileged user,
#   4. prints the version the installed tool reports.
#
# It does not sign in, does not write or read any login, and passes none of
# this application's settings to the installer. Signing in is a separate step
# that you do yourself with the vendor's own login command.
#
# The commands and their sources were read from the vendors' documentation on
# 2026-11-22. A vendor can change its installer at any time; compare with the
# linked page when in doubt.
set -euo pipefail

readonly PROGRAM=answerwall-install-cli
readonly SUPPORTED="claude codex grok agy"

# Per tool: the vendor, the documentation page the command was copied from,
# the command itself, the terms that apply to the tool and the service behind
# it, where the installer puts the executable, and the vendor's login command.
describe() {
  case "$1" in
    claude)
      vendor="Anthropic"
      source_url="https://code.claude.com/docs/en/setup"
      command='curl -fsSL https://claude.ai/install.sh | bash'
      terms="https://www.anthropic.com/legal/consumer-terms
https://www.anthropic.com/legal/commercial-terms
https://code.claude.com/docs/en/legal-and-compliance"
      executable="$HOME/.local/bin/claude"
      login="claude auth login"
      note=""
      ;;
    codex)
      vendor="OpenAI"
      source_url="https://developers.openai.com/codex/cli"
      command='curl -fsSL https://chatgpt.com/codex/install.sh | sh'
      terms="https://openai.com/policies/terms-of-use/
https://github.com/openai/codex/blob/main/LICENSE"
      executable="$HOME/.local/bin/codex"
      login="codex login --device-auth"
      note=""
      ;;
    grok)
      vendor="xAI"
      source_url="https://docs.x.ai/build/overview"
      command='curl -fsSL https://x.ai/cli/install.sh | bash'
      terms="https://x.ai/legal/terms-of-service
https://github.com/xai-org/grok-build/blob/main/LICENSE"
      executable="$HOME/.grok/bin/grok"
      login="grok login --device-auth"
      note=""
      ;;
    agy)
      vendor="Google"
      source_url="https://antigravity.google/docs/getting-started"
      command='curl -fsSL https://antigravity.google/cli/install.sh | bash'
      terms="https://antigravity.google/terms
https://antigravity.google/docs/faq"
      executable="$HOME/.local/bin/agy"
      login="agy"
      note="agy keeps its Google sign-in in the operating system's keyring (the
Secret Service on Linux). This image has no keyring service, so signing in
with a Google account inside the container is not supported: the tool will
install and report its version, and that is all that is known to work here.
Read \"agy in a container\" in docs/deploy-docker.md before you continue."
      ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<EOF
Usage: $PROGRAM <tool> [--yes]
       $PROGRAM --list

Installs one AI command-line tool into the home directory of the container
($HOME) with the vendor's official installer. Tools: $SUPPORTED.

  --yes    Do not ask for confirmation (needed when there is no terminal).
  --list   Print the command, its source and the terms for every tool; install nothing.

Nothing is installed without this command, and it never signs you in.
EOF
}

print_details() {
  echo "Tool:      $1 ($vendor)"
  echo "Command:   $command"
  echo "Copied from the vendor's documentation: $source_url"
  echo "Installs:  $executable"
  echo "Terms and licence that apply to the tool and the service behind it:"
  printf '%s\n' "$terms" | sed 's/^/  /'
}

tool=""
assume_yes=false
for argument in "$@"; do
  case "$argument" in
    --yes | -y) assume_yes=true ;;
    --list)
      for name in $SUPPORTED; do
        describe "$name"
        print_details "$name"
        echo
      done
      exit 0
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    -*)
      echo "$PROGRAM: unknown option $argument" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$tool" ]; then
        echo "$PROGRAM: one tool at a time" >&2
        exit 2
      fi
      tool="$argument"
      ;;
  esac
done

if [ -z "$tool" ]; then
  usage >&2
  exit 2
fi
if ! describe "$tool"; then
  echo "$PROGRAM: unknown tool \"$tool\". Supported: $SUPPORTED." >&2
  exit 2
fi

if [ "$(id -u)" = "0" ]; then
  echo "$PROGRAM: refusing to install as root. Run it as the container's own user:" >&2
  echo "  docker exec -it <container> $PROGRAM $tool" >&2
  exit 1
fi
if [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then
  echo "$PROGRAM: the home directory $HOME is not writable by user id $(id -u)." >&2
  exit 1
fi

# Every vendor publishes Linux builds for these two architectures and no
# other (claude: "x64 or ARM64 processor"; codex: x86_64 and aarch64 release
# archives; grok: "Linux (x86_64 or arm64)"; agy: its installer accepts amd64
# and arm64, its documentation does not list architectures for the CLI).
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *)
    echo "$PROGRAM: $vendor publishes no official $tool build for Linux on $machine." >&2
    echo "$PROGRAM: nothing was installed." >&2
    exit 1
    ;;
esac

print_details "$tool"
if [ -n "$note" ]; then
  echo
  echo "Note: $note"
fi
echo
echo "The command downloads and runs the vendor's installer as user id $(id -u)."
echo "By continuing you accept the vendor's terms above. Nothing is signed in."

if [ "$assume_yes" != true ]; then
  if [ ! -t 0 ]; then
    echo "$PROGRAM: no terminal to ask on. Run it with \"docker exec -it\", or pass --yes." >&2
    exit 1
  fi
  printf 'Type "yes" to run it: '
  read -r answer
  if [ "$answer" != "yes" ]; then
    echo "Nothing was installed."
    exit 1
  fi
fi

# The installer gets the environment of the container minus this
# application's own settings and secrets, which no installer needs.
clean_env=(env)
while IFS= read -r name; do
  clean_env+=(-u "$name")
done < <(compgen -e | grep '^ANSWERWALL_' || true)

echo
echo "Running: $command"
echo
if ! "${clean_env[@]}" bash -o pipefail -c "$command"; then
  echo >&2
  echo "$PROGRAM: the installer of $vendor failed. Nothing else was changed." >&2
  exit 1
fi

echo
if [ ! -x "$executable" ]; then
  echo "$PROGRAM: the installer finished, but $executable does not exist." >&2
  echo "$PROGRAM: the vendor may have changed where it installs; see $source_url" >&2
  exit 1
fi
if ! reported="$("${clean_env[@]}" timeout 60 "$executable" --version 2>&1)"; then
  echo "$PROGRAM: $executable was installed but \"$tool --version\" failed:" >&2
  printf '%s\n' "$reported" >&2
  exit 1
fi
echo "Installed: $tool $(printf '%s\n' "$reported" | head -n 1)"
echo
if [ "$tool" = "agy" ]; then
  echo "It is not signed in, and its Google sign-in needs a keyring service that"
  echo "this container does not have. See \"agy in a container\" in"
  echo "docs/deploy-docker.md for what can be used instead."
  exit 0
fi
echo "It is not signed in. To sign in, run the vendor's login command yourself,"
echo "on the Docker host, in a terminal:"
echo "  docker exec -it <container> $login"
echo "Then press Refresh on the providers page."
