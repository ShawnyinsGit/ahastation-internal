# AhaStation on RK3588 / Debian 11

## Locked target

- RK3588 or RK3588S, `aarch64`
- Debian GNU/Linux 11 (bullseye), glibc 2.31
- X11
- 8 GiB RAM minimum; the photographed board has about 15 GiB
- `.deb` is the primary artifact; AppImage is the fallback
- All four CLIs and orchestration run on the board. Model inference remains cloud-hosted.

The release job builds inside a Debian 11 arm64 container. The
`prebuild:whisper:linux-arm64` script compiles static whisper.cpp v1.9.1
binaries with native ARM/NEON optimizations, verifies that they do not retain
an unpackaged whisper/ggml shared-library dependency, and the package gate
verifies that packaged ELF files do
not require a GLIBC version newer than 2.31, and checks that Claude, Codex,
OpenCode and Whisper native assets are present. Kimi Code is installed through
its official installer after the user explicitly selects Install in Device
Ready; it is not redistributed by AhaStation.

## Build

Run on the board or in the `debian-11-arm64` CI job:

```sh
sudo apt-get update
sudo apt-get install -y build-essential ca-certificates cmake curl file git \
  libarchive-tools python3 rpm xz-utils
npm ci

# This command self-builds whisper.cpp before fetching the model.
npm run dist:linux:arm64
```

Artifacts:

```text
release/AhaStation-<version>-arm64.deb
release/AhaStation-<version>-arm64.AppImage
release/SHA256SUMS
release/SHA256SUMS.asc  # release tags only; GPG signing key is mandatory
```

## Install and start

```sh
sha256sum -c SHA256SUMS
gpg --verify SHA256SUMS.asc SHA256SUMS
sudo apt install ./AhaStation-*-arm64.deb
ahastation
```

Do not launch the app as root and do not add `--no-sandbox`. The package
installs a normal desktop entry. On an X11 image with unusual GPU drivers,
start with `ELECTRON_OZONE_PLATFORM_HINT=x11 ahastation` and inspect Device
Ready before changing Chromium GPU flags.

## Runtime gate

Run:

```sh
sh scripts/board/verify-rk3588.sh
```

The gate requires these contract-tested versions:

| Backend | Version | Packaging |
|---|---:|---|
| Claude Code | 2.1.150 | Bundled SDK platform runtime |
| Codex | 0.144.1 | Bundled Linux arm64 platform runtime |
| OpenCode | 1.18.3 | Bundled Linux arm64 platform runtime |
| Kimi Code | 0.24.1 | Official installer, user-authorized |

After installation, open **设备就绪** in the Lobby. A backend remains disabled
until its binary, exact version, authentication and Worker contract are all
green.

## Real-board acceptance

1. Confirm microphone capture and playback at 16 kHz mono.
2. Run a Claude-hosted Meeting with one OpenCode task through
   `WorkReport → verifying → reviewing → accepted`.
3. Repeat the same contract slice for Claude, Codex and Kimi.
4. Run 2 Hosts + 4 Workers for two hours while collecting:

   ```sh
   bash scripts/thermal-log.sh -d 7200 -o ./soak-evidence
   ```

   Run this from the source checkout. The script samples once per second and
   writes a CSV plus a Markdown verdict into the selected output directory.

5. Pass both the built-in touch display and an external monitor:
   no inaccessible drawer/overlay, all primary controls at least 44 px, audio
   uninterrupted and UI still interactive.
6. Force-close the app during a running task. Reopen it and confirm the task is
   `interrupted`, prior WorkReport/test history remains visible, and neither
   Continue nor Retry happens without an explicit user action.
7. Confirm no OOM, orphaned Worker process or corrupt `events.jsonl`.

Four-Worker release status must not be declared complete until this real-board
matrix and the signed artifact verification both pass.
