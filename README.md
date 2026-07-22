# AhaMeet

A real-time meeting-style collaboration app that pairs you with Claude Code over screen sharing and voice. Think of it as having an AI engineering co-pilot in a video call — you talk, Claude listens, sees your screen, writes and runs code, and narrates what it's doing.

## Features

- **Voice-first interaction** — speak naturally, Claude transcribes and responds in real-time using on-device Whisper ASR
- **Screen sharing** — take manual snapshots of any window or screen and send them to Claude as context
- **Multi-agent execution** — Claude spawns parallel worker agents to tackle complex tasks concurrently, each shown as a tile in the meeting view
- **Text-to-speech narration** — Claude's replies are spoken aloud with macOS system voices (supports Siri Premium / Lili voices)
- **Voice lock** — enroll a voice print so only your voice triggers Claude
- **Cross-meeting memory** — key decisions, todos, and facts are stored and recalled across sessions
- **Claude authentication** — use an Anthropic API key or log in with your Claude Pro/Max subscription account

## Requirements

- macOS (Apple Silicon arm64)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — bundled inside the app
- Anthropic API key **or** Claude Pro / Max subscription

## Installation

1. Download `AhaMeet-0.5.5-arm64.dmg` from [Releases](../../releases)
2. Open the DMG and drag AhaMeet to Applications
3. Right-click → Open (first launch only, app is unsigned)

**Linux (AppImage)**: AppImage requires **FUSE2** (`sudo apt install libfuse2` on Ubuntu/Debian; Fedora 默认自带）。然后 `chmod +x AhaMeet-*.AppImage && ./AhaMeet-*.AppImage`。AppImage 与 deb 均有 x64 与 arm64 构建（arm64 目前标注未验证，验证走 CI 的 linux-arm64 手动 job）。

## Authentication

On the login screen, expand **Claude authentication** and choose one of:

| Method | When to use |
|--------|-------------|
| **API Key** | You have an `sk-ant-...` key from [console.anthropic.com](https://console.anthropic.com) |
| **Claude Account** | You have a Claude Pro or Max subscription at [claude.ai](https://claude.ai) |

For the API key method, paste your key and click Save. For the subscription method, click **Log in with Claude** — a browser window will open for OAuth.

## Usage

1. Choose your authentication method (first time only)
2. Pick a working directory — Claude will read and write files here
3. Click **Start meeting**
4. Talk naturally or type; use ⌥ (Option) to interrupt Claude mid-reply
5. Click the screen icon in the toolbar to send a snapshot of your screen

## Building from source

```bash
# Install dependencies
npm install

# Development (renderer only, hot reload)
npm run dev

# Full build
npm run build

# Package as DMG (downloads Whisper model ~190MB on first run)
npm run dist:dmg
```

### Prerequisites for building

- Node.js 18+
- macOS with Xcode Command Line Tools (`xcode-select --install`)

## Tech stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 33 |
| UI | React 18 + TypeScript |
| Bundler | Vite 6 |
| AI | Claude Code SDK (`@anthropic-ai/claude-agent-sdk`) |
| ASR | Whisper (via `whisper-cli` binary, ONNX Runtime on-device) |
| TTS | macOS Web Speech Synthesis API |
| Voice detection | `@ricky0123/vad-web` (Silero VAD, ONNX) |

## Project structure

```
electron/          Electron main process
  main.ts          Window, IPC handlers, auth
  orchestrator.ts  Multi-agent session coordinator
  claude-session.ts  Claude Code SDK wrapper
  settings-loader.ts  Subprocess env (API key injection)
  store.ts         Persistent settings (JSON)
  memory.ts        Cross-meeting memory store
  whisper.ts       On-device ASR

src/               Renderer (React)
  App.tsx          Top-level state, session lifecycle
  components/      UI components
  lib/             Meeting store, hooks (speech, VAD, ASR)

scripts/           Build helpers
  fetch-whisper.mjs     Downloads Whisper model + CLI
  bundle-claude-defaults.mjs  Bundles Claude agent defaults
```

## License

MIT
