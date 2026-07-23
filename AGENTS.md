# AhaStation — Codex working notes

## Environment paths

This shell does not always inherit a usable `PATH`, so `node` / `npm` / `npx`
can come back as "command not found" even when they are installed. Use the
absolute paths below, or prepend `/usr/local/bin` to `PATH` once at the start
of a session.

| Tool | Absolute path |
|------|---------------|
| node | `/usr/local/bin/node` |
| npm  | `/usr/local/bin/npm` |
| npx  | `/usr/local/bin/npx` |

Quick fix at the top of a Bash invocation:

```bash
export PATH=/usr/local/bin:$PATH
```

If `which node` returns nothing, fall back to the absolute path — for example
`/usr/local/bin/node node_modules/typescript/bin/tsc ...`.

## Typecheck

There is no dedicated `lint` / `typecheck` npm script. Run TypeScript directly
against each tsconfig:

```bash
# Renderer (React app, src/)
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# Electron main + preload
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit -p tsconfig.electron.json
```

Both should exit silently on a clean tree. Run both before declaring a change
done — the renderer and electron sides have separate tsconfigs and one can
break without the other noticing.

## Build / package

- `npm run build` — vite + tsc, no installer.
- `npm run dist:dmg` — full release flow: downloads whisper, bundles Codex
  defaults, builds, then runs `electron-builder --mac --arm64 --publish never`.
  Output lands in `release/` as `AhaMeet-<version>-arm64.dmg`.

### macOS signing

`electron-builder.json` sets no `identity`, so electron-builder signs with
whatever identity the environment provides (`CSC_NAME` / keychain). Two
safeguards wrap the build:

- `scripts/sign-helpers.mjs` (electron-builder `afterPack` hook) re-signs the
  bundled whisper.cpp helpers with a Developer ID certificate so notarization
  doesn't reject ad-hoc executables. Identity comes from
  `$APPLE_HELPER_IDENTITY`, then `$CSC_NAME`, then `mac.identity`; when none
  is set it logs a warning and skips (local dev builds).
- `node scripts/verify-macos-signing.mjs` runs at the end of both `dist` and
  `dist:dmg` and hard-fails the release unless `release/mac-arm64/AhaMeet.app`
  carries a Developer ID Application signature, a TeamIdentifier, and the
  audio-input entitlement.
