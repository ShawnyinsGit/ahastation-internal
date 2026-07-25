# AhaStation — Claude working notes

## Environment paths (macOS shells)

On macOS the shell does not always inherit a usable `PATH`, so `node` / `npm` /
`npx` can come back as "command not found" even when they are installed. Use
the absolute paths below, or prepend `/usr/local/bin` to `PATH` once at the
start of a session:

```bash
export PATH=/usr/local/bin:$PATH
```

On Windows the standard `node` / `npm` on `PATH` work as-is.

## Typecheck

There is no lint script. Typecheck both sides via npm scripts (the renderer
and electron sides have separate tsconfigs and one can break without the
other noticing):

```bash
npm run typecheck            # both sides
npm run typecheck:renderer   # React app, src/ (tsconfig.json)
npm run typecheck:electron   # main + preload (tsconfig.electron.json)
```

Both should exit silently on a clean tree. Run both before declaring a change
done.

## Build / package

- `npm run build` — vite + tsc, no installer. `build:electron` cleans
  `dist-electron/` first so stale output from deleted sources never ships.
- `npm run dist:dmg` — full release flow: downloads the speaker model, bundles
  Claude defaults, builds, then runs `electron-builder --mac --arm64 --publish
  never`. Output lands in `release/` as `AhaStation-<version>-arm64.dmg`.

### macOS signing

`electron-builder.json` sets no `identity`, so electron-builder signs with
whatever identity the environment provides (`CSC_NAME` / keychain).
`node scripts/verify-macos-signing.mjs` runs at the end of both `dist` and
`dist:dmg` and hard-fails the release unless `release/mac-arm64/AhaStation.app`
carries a Developer ID Application signature, a TeamIdentifier, and the
audio-input entitlement.
