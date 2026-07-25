# AhaStation on RK3588 / Debian 11

## Locked target

- RK3588 or RK3588S, `aarch64` (e.g. EmbedFire LubanCat)
- Debian GNU/Linux 11 (bullseye), **glibc 2.31**
- X11
- 8 GiB RAM minimum (typical board ~15 GiB)
- `.deb` is the primary artifact; AppImage is the fallback
- Worker CLIs run on the board; model inference stays cloud-hosted
- **Speech**: Xunfei (讯飞) IAT is the supported ASR path (configure on the
  board in Settings). Local whisper.cpp is not part of `dist:linux:arm64`.

## Release pipeline (source of truth)

| Step | Where |
|------|--------|
| Build + smoke | GitHub Actions `build-matrix` → job `linux-arm64` inside **`debian:11`** |
| Package gate | `scripts/verify-linux-arm64-package.mjs` (arm64 + **GLIBC ≤ 2.31** + Claude/Codex/OpenCode runtimes) |
| Board platform gate | `scripts/board/verify-rk3588.sh` |
| Manual trigger | `workflow_dispatch` or tag `v*` (arm runners are paid minutes) |

Do **not** package linux-arm64 on Windows. Cross-host optionalDeps will miss
`*-linux-arm64` binaries.

### First CI acceptance after Debian 11 restore

1. Run Actions → `build-matrix` → **Run workflow**.
2. Confirm job `linux-arm64 (debian:11 container)` is green.
3. Download `pkg-linux-arm64` artifact (`.deb` / `.AppImage` / `SHA256SUMS`).
4. If the job fails on `verify-linux-arm64-package` with GLIBC > 2.31, Electron
   or a bundled native binary is too new for Bullseye — stop and pin/rebuild;
   do not ship that artifact to the board.

## Build (on Linux arm64 only)

```sh
sudo apt-get update
sudo apt-get install -y build-essential ca-certificates curl file git \
  libarchive-tools python3 rpm xz-utils
npm ci
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
# gpg --verify SHA256SUMS.asc SHA256SUMS   # signed tags only
sudo apt install ./AhaStation-*-arm64.deb
ahastation
```

Do not launch as root and do not add `--no-sandbox`. On odd GPU stacks:

```sh
ELECTRON_OZONE_PLATFORM_HINT=x11 ahastation
```

Backend API keys / OAuth stored via Electron `safeStorage` do not transfer
across machines — authenticate on the board after install.

## Runtime gate

```sh
# After .deb install — bundled Claude/Codex/OpenCode must be present.
sh scripts/board/verify-rk3588.sh

# Release freeze: also require exact versions in scripts/board/runtime-versions.env
AHASTATION_GATE_STRICT=1 sh scripts/board/verify-rk3588.sh

# When Kimi is installed via official installer:
AHASTATION_GATE_REQUIRE_KIMI=1 sh scripts/board/verify-rk3588.sh
```

Default (bring-up) mode checks platform + bundled binaries are runnable and
prints versions. Strict mode pins versions from `runtime-versions.env`.

Open **设备就绪** in the Lobby. A backend stays disabled until binary,
auth and Worker contract are green. OpenCode / Kimi may remain
**experimental** by first-release policy.

## Real-board acceptance

1. Mic capture + playback at 16 kHz mono; ASR returns text after on-board config.
2. One Meeting through `WorkReport → verifying → reviewing → accepted`
   (report-only explore path may skip freeze and land on host Accept).
3. Repeat for each backend you claim supported.
4. Optional soak (2 Hosts + 4 Workers, 2h):

   ```sh
   bash scripts/thermal-log.sh -d 7200 -o ./soak-evidence
   ```

5. Touch panel + external monitor: primary controls ≥ 44 px, no dead overlays.
6. Force-quit mid-task → reopen → task is `interrupted`, no auto Continue/Retry.
7. No OOM, orphaned workers, or corrupt `events.jsonl`.

Four-Worker release status is not complete until this matrix and a signed
artifact verification both pass.
