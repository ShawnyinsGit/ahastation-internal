# AhaStation — Codex working notes

## Environment paths

This shell does not always inherit a usable `PATH`, so `node` / `npm` / `npx`
can come back as "command not found" even when they are installed. Use the
absolute paths below, or prepend the right bin dir to `PATH` once at the start
of a session. On this machine (Apple Silicon, Homebrew) node lives in
`/opt/homebrew/bin` — `/usr/local/bin` is the Intel/Homebrew-alt location and
does **not** exist here; check `which node` once and pick accordingly.

| Tool | Absolute path (this machine) | Fallback (Intel mac) |
|------|------------------------------|----------------------|
| node | `/opt/homebrew/bin/node` | `/usr/local/bin/node` |
| npm  | `/opt/homebrew/bin/npm`  | `/usr/local/bin/npm` |
| npx  | `/opt/homebrew/bin/npx`  | `/usr/local/bin/npx` |

Quick fix at the top of a Bash invocation:

```bash
export PATH=/opt/homebrew/bin:$PATH   # this machine
# export PATH=/usr/local/bin:$PATH    # Intel / Homebrew-alt
```

If `which node` returns nothing, fall back to the absolute path — for example
`/opt/homebrew/bin/node node_modules/typescript/bin/tsc ...`.

## Typecheck

There is no lint script. Typecheck via the npm scripts (or run tsc directly
against each tsconfig):

```bash
# Both sides
/usr/local/bin/npm run typecheck

# Renderer (React app, src/)
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# Electron main + preload
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit -p tsconfig.electron.json
```

Both should exit silently on a clean tree. Run both before declaring a change
done — the renderer and electron sides have separate tsconfigs and one can
break without the other noticing.

## Build / package

- `npm run build` — vite + tsc, no installer. `build:electron` cleans
  `dist-electron/` first so stale output from deleted sources never ships.
- `npm run dist:dmg` — full release flow: downloads the speaker model, bundles Codex
  defaults, builds, then runs `electron-builder --mac --arm64 --publish never`.
  Output lands in `release/` as `AhaStation-<version>-arm64.dmg`.

### Cross-platform packaging from macOS

CI builds each platform on its native runner (`.github/workflows/build-matrix.yml`);
packaging Windows/Linux locally from macOS needs two manual accommodations:

- **platform backend binaries**: npm only installs the host platform's optional
  packages, so cross packages would miss the target's Codex/OpenCode binaries.
  Stage them into `node_modules` before packaging, e.g.
  `npm pack @openai/codex@<ver>-linux-arm64 opencode-linux-arm64@<ver>` and
  copy each `package/` dir to `node_modules/@openai/codex-linux-arm64` /
  `node_modules/opencode-linux-arm64` (alias names — the registry package is
  `@openai/codex@<ver>-<platform>`; `@openai/codex-linux-arm64` itself 404s).
- **linux .deb**: fpm shells out to BSD `ar` on macOS and emits a 96-byte stub.
  Use `python3 scripts/make-local-deb.py` instead (GNU tar + GNU ar format,
  dpkg 1.20 compatible); it packs `release/linux-arm64-unpacked/` produced by
  `electron-builder --linux dir --arm64`.

### macOS signing

`electron-builder.json` sets no `identity`, so electron-builder signs with
whatever identity the environment provides (`CSC_NAME` / keychain). Two
safeguards wrap the build:

- `node scripts/verify-macos-signing.mjs` runs at the end of both `dist` and
  `dist:dmg` and hard-fails the release unless `release/mac-arm64/AhaStation.app`
  carries a Developer ID Application signature, a TeamIdentifier, and the
  audio-input entitlement.
