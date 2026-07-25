#!/bin/sh
set -eu

fail() { printf '%s\n' "[rk3588-gate] FAIL: $*" >&2; exit 1; }
note() { printf '%s\n' "[rk3588-gate] $*"; }

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

check_version() {
  name=$1
  expected=$2
  binary=$(command -v "$name" 2>/dev/null || true)
  if [ -z "$binary" ] && [ "$name" != "kimi" ]; then
    binary=$(bundled_runtime "$name")
  fi
  [ -n "$binary" ] || fail "$name is missing (PATH and $APP_RESOURCES were checked)"
  [ -x "$binary" ] || fail "$name runtime is not executable: $binary"
  actual=$("$binary" --version 2>&1 | sed -n 's/.*[^0-9]\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
  [ "$actual" = "$expected" ] || fail "$name version $actual, expected $expected"
  note "$name $actual ($binary)"
}

check_version claude 2.1.150
check_version codex 0.144.1
check_version opencode 1.18.3
check_version kimi 0.24.1

if command -v glxinfo >/dev/null 2>&1; then
  glxinfo -B | sed -n '1,12p'
else
  note "glxinfo unavailable; install mesa-utils for GPU evidence"
fi

note "platform PASS: Debian 11 aarch64 X11, RAM/disk/audio/git and four runtime versions"
note "next: install the arm64 .deb, open Device Ready, authenticate all four backends, then run the real Meeting and soak checklist"
