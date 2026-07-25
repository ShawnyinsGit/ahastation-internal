#!/bin/sh
set -eu

fail() { printf '%s\n' "[rk3588-gate] FAIL: $*" >&2; exit 1; }
note() { printf '%s\n' "[rk3588-gate] $*"; }

STRICT=${AHASTATION_GATE_STRICT:-0}
REQUIRE_KIMI=${AHASTATION_GATE_REQUIRE_KIMI:-0}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSIONS_FILE=${AHASTATION_GATE_VERSIONS:-"$SCRIPT_DIR/runtime-versions.env"}

[ "$(uname -m)" = "aarch64" ] || fail "expected aarch64, got $(uname -m)"
. /etc/os-release
[ "${ID:-}" = "debian" ] || fail "expected Debian, got ${ID:-unknown}"
[ "${VERSION_ID:-}" = "11" ] || fail "expected Debian 11, got ${VERSION_ID:-unknown}"
[ "${XDG_SESSION_TYPE:-}" = "x11" ] || fail "expected X11 session, got ${XDG_SESSION_TYPE:-unset}"

memory_kib=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
[ "${memory_kib:-0}" -ge 8000000 ] || fail "at least 8 GiB RAM is required"
available_kib=$(df -Pk / | awk 'NR==2 {print $4}')
[ "${available_kib:-0}" -ge 5242880 ] || fail "at least 5 GiB free storage is required"

command -v git >/dev/null 2>&1 || fail "git is missing"
git worktree list >/dev/null 2>&1 || fail "git worktree support is unavailable"
command -v aplay >/dev/null 2>&1 || fail "alsa-utils/aplay is missing"
command -v arecord >/dev/null 2>&1 || fail "alsa-utils/arecord is missing"

APP_RESOURCES=${AHASTATION_APP_RESOURCES:-/opt/AhaStation/resources}

if [ -f "$VERSIONS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$VERSIONS_FILE"
fi

bundled_runtime() {
  case "$1" in
    claude)
      find "$APP_RESOURCES" -type f -path '*claude-agent-sdk-linux-arm64*/claude' -print 2>/dev/null | head -n 1
      ;;
    codex)
      find "$APP_RESOURCES" -type f -path '*codex-linux-arm64*/vendor/aarch64-unknown-linux-musl/bin/codex' -print 2>/dev/null | head -n 1
      ;;
    opencode)
      find "$APP_RESOURCES" -type f -path '*opencode-linux-arm64/bin/opencode' -print 2>/dev/null | head -n 1
      ;;
  esac
}

read_version() {
  binary=$1
  # Match a semver either mid-line (preceded by a non-digit) or at line start
  # (e.g. "2.1.150 (Claude Code)", "1.18.5"); the old pattern required a
  # non-digit prefix and silently failed on leading-version output.
  "$binary" --version 2>&1 | sed -n \
    -e 's/^\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    -e 's/.*[^0-9]\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    | head -n 1
}

check_runtime() {
  name=$1
  expected=$2
  required=$3
  binary=$(command -v "$name" 2>/dev/null || true)
  if [ -z "$binary" ] && [ "$name" != "kimi" ]; then
    binary=$(bundled_runtime "$name")
  fi
  if [ -z "$binary" ]; then
    if [ "$required" = "1" ]; then
      fail "$name is missing (PATH and $APP_RESOURCES were checked)"
    fi
    note "$name skipped (not installed)"
    return 0
  fi
  [ -x "$binary" ] || fail "$name runtime is not executable: $binary"
  actual=$(read_version "$binary")
  [ -n "$actual" ] || fail "$name did not print a parseable --version ($binary)"
  if [ "$STRICT" = "1" ]; then
    [ -n "$expected" ] || fail "$name expected version missing from $VERSIONS_FILE"
    [ "$actual" = "$expected" ] || fail "$name version $actual, expected $expected"
  elif [ -n "$expected" ] && [ "$actual" != "$expected" ]; then
    note "$name $actual ($binary) — differs from pinned $expected (set AHASTATION_GATE_STRICT=1 to fail)"
    return 0
  fi
  note "$name $actual ($binary)"
}

check_runtime claude "${CLAUDE_VERSION:-}" 1
check_runtime codex "${CODEX_VERSION:-}" 1
check_runtime opencode "${OPENCODE_VERSION:-}" 1
check_runtime kimi "${KIMI_VERSION:-}" "$REQUIRE_KIMI"

if command -v glxinfo >/dev/null 2>&1; then
  glxinfo -B | sed -n '1,12p'
else
  note "glxinfo unavailable; install mesa-utils for GPU evidence"
fi

if [ "$STRICT" = "1" ]; then
  note "platform PASS (strict versions): Debian 11 aarch64 X11 + pinned runtimes"
else
  note "platform PASS (bring-up): Debian 11 aarch64 X11, RAM/disk/audio/git + runnable bundled runtimes"
fi
note "next: open Device Ready, authenticate backends, then run the real Meeting checklist"
