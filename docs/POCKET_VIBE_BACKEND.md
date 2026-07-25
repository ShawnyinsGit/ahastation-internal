# Pocket Vibe Backend — 交接说明（给后续维护的 CLI/开发者）

> 本文档描述 2026-07-26 合入的 `pocket-vibe` 远程 backend。**改动尚未 commit**，
> 任何后续修改都必须基于当前工作区（不要从 /opt 安装版或旧 commit 出发）。

## 这是什么

`pocket-vibe` 是一个**远程 backend**：本机没有 CLI 子进程，任务通过 HTTP 发给
pocket-vibe hub（FastAPI，默认 `http://127.0.0.1:8787`），hub 再派发给注册上来的
远程 agent（Windows/Mac/Linux 上的 Codex/Claude CLI）。hub 源码在仓库外：
`../`（即 pocket-vibe-linux 项目根的 `device/`、`web/`）。

它同时支持两种会议角色：

- **Worker**（默认）：主持人 `delegate_task` 派活，远程 agent 用 ```work-report
  围栏帧交付（无 MCP，与 OpenCode 同模式）。
- **Host/参会者**：`capabilities.coordinate: true`，可在侧边栏"参与者"里被"邀请"
  进会议。协调走 codex 同款 portable 通道：模型输出 ```meeting-command 围栏帧，
  adapter 解析后经 `extra.meetingCommandHandler` 路由给
  `Orchestrator.executeMeetingCommand`。

## 改动文件（git status 可见，未提交）

| 文件 | 说明 |
|---|---|
| `electron/backends/pocket-vibe-adapter.ts` | 新增。`PocketVibeBackend` + `PocketVibeSession`（轮询式，串行队列） |
| `electron/backends/registry.ts` | +1 行注册 |
| `electron/backends/task-profile.ts` | +`compilePocketVibeTaskProfile` |
| `electron/orchestrator.ts` (~465) | PORTABLE_MEETING_COMMAND_PROMPT 追加条件扩展到 pocket-vibe |
| `tests/pocket-vibe-adapter.test.mjs` | 新增，14 个用例（worker+host+auth） |

⚠️ `electron/main.ts` 也显示 modified——那是**用户自己的改动**（RK3588 小屏
clamp + ANGLE/GLES），与本功能无关，**不要动、不要 revert**。

## 怎么跑最新版 app（关键！）

机器上有两个 AhaStation，别搞混：

- `/opt/AhaStation`（桌面图标）：**旧安装版，没有 pocket-vibe**。两者共用
  单实例锁，旧版在跑时新版会静默退出。
- **最新版 = 本源码树**，用项目根（pocket-vibe-linux）下的脚本启动：

```bash
../start-ahastation-dev.sh          # 或绝对路径
/home/cat/ai-voice/ahastation/pocket-vibe-linux/start-ahastation-dev.sh
../start-ahastation-dev.sh --build  # 改过 electron/ 后强制重建
```

脚本流程：检查 /opt 旧版冲突 → 按需构建 `dist-electron/` → 起 vite(:5173) →
开窗口。手动等价步骤：`npm run build:electron` + `npm run dev`（后台）+
`VITE_DEV_SERVER_URL=http://localhost:5173 node_modules/.bin/electron .`

### node 路径（与 AGENTS.md 不同！）

`/usr/local/bin/node` **不存在**。实际 node v22 在：

```bash
export PATH=/home/cat/ai-voice/ahastation/pocket-vibe-linux/.tools/node22/bin:$PATH
```

## 测试依赖：pocket-vibe hub

app 里的 pocket-vibe backend 需要 hub 才能真跑。hub 源码在
`pocket-vibe-linux/device/`（不在本 git 仓库内），启动方式：

```bash
cd /home/cat/ai-voice/ahastation/pocket-vibe-linux/device
../.venv/bin/python device_hub.py &        # :8787，token 默认 dev-token / dev-tool-token
POCKET_VIBE_AGENT_ID=linux-worker ../.venv/bin/python desktop_agent.py &
```

注意：未配 `--local-agent-config` 时 bridge 是 **echo 模拟**（不真跑 LLM），
适合测链路；要真执行需配 `configs/local_agent.example.json` 指向
`examples/codex_cli_adapter.py` 之类。

app 内配置（设置 → Pocket Vibe (远程)）：Base URL = `http://127.0.0.1:8787`，
API Key = `dev-tool-token`，Model = 目标 agent_id（如 `linux-worker`）。
**API Key 输入后需按回车/点保存才落盘。**

## 验证命令（改完必须跑）

```bash
export PATH=.../.tools/node22/bin:$PATH
npm run typecheck          # renderer + electron 两个 tsconfig 都要过
npm test                   # 全量（含 pocket-vibe 用例），基线 679 pass / 2 skipped
# 只跑本 backend：
npm run build:electron && node --test --test-timeout=120000 \
  --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" \
  tests/pocket-vibe-adapter.test.mjs
```

## 已踩过的坑（别再踩）

1. **"未配置"假象**：侧边栏参与者列表的"已配置"只认 `checkAuthStatus()`；
   新 backend 必须实现它（我们已补：有已存 tool token 即 loggedIn）。
2. **resolveBinary() 不能返回 null**：否则 registry 当"未安装"把卡片藏起来。
   远程 backend 返回哨兵 `'pocket-vibe-remote'`。
3. **worker 必须实现** `compileTaskProfile` 和 `normalizePermissionRequest`，
   否则注册表/计划门禁抛错。
4. pkill/pgrep 匹配 electron 路径时会匹配到 shell 自身命令行导致自杀，
   用 `pgrep -f "[e]lectron/dist/electron"` 字符类写法。

## 已知限制（设计使然）

- hub 无流式、无取消：每轮发言是完整远程 turn，延迟以十秒计；interrupt 只停本地轮询。
- 远程 agent 无 AhaStation MCP：worker 完成信号唯一通道是 ```work-report 帧；
  host 协调唯一通道是 ```meeting-command 帧。
- 不配 `POCKET_VIBE_SESSION_ID` 时远程侧无对话记忆（每轮新 exec，靠
  systemPrompt 重放兜底）。
- `FIRST_RELEASE_STABLE_WORKERS` 不含 pocket-vibe → UI 会标"实验"，属预期。
