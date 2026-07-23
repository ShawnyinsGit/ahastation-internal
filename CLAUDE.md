# AhaStation — Claude working notes

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
- `npm run dist:dmg` — full release flow: downloads whisper, bundles Claude
  defaults, builds, then runs `electron-builder --mac --arm64 --publish never`.
  Output lands in `release/` as `Vibe Meet-<version>-arm64.dmg` (unsigned;
  `identity` is explicitly null in `electron-builder.json`).
