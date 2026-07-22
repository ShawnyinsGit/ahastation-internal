# Phase 2 E2E 验收清单（macOS）— OpenCode 全链路实测

- 适用：Phase 2（PR #4/#5/#6）合并后的端到端验收，macOS dev 环境。
- 范围：provider key 链路 → 事件管线 → PermissionBroker → 编辑器面板（Diff/Todo/活动日志）→ 断线 resync → 双参会者隔离。
- 自动化替代：§B 的 `scripts/e2e-opencode-smoke.mjs` 无头覆盖核心链路；本清单 §A 是 GUI 手工验收。

## 0. 前置

- [ ] **代码与依赖**：`git checkout main && git pull`，`npm install` 已跑过（`node_modules/opencode-darwin-arm64` 存在，OpenCode 二进制随 optionalDependencies 分发）。
- [ ] **编译 electron 侧**：`npm run build:electron` 无错误退出。
- [ ] **配置 provider key**（任选一家，与模型 provider 对应）：
  1. 启动 app（见 §A.1）→ 会议页右上角 **⚙ 设置** → 「后端管理 · Backends」→ **OpenCode** tab；
  2. **API Key** 输入框粘贴 key → **保存**（key 经 safeStorage 加密存 settings.json，UI 只显示"已保存"）；
  3. 同卡片 **Model** 下拉选择与 key 匹配的模型：
     - Anthropic key → `anthropic/claude-sonnet-4-5`（或 haiku）→ 注入 `ANTHROPIC_API_KEY`
     - OpenAI key → `openai/gpt-5.4`（或 mini）→ 注入 `OPENAI_API_KEY`
  4. （可选）Base URL 仅自建网关时填，注入 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`。
  - 预期：卡片状态变为「✓ 已配置」。注意 OpenCode 没有 OAuth 按钮（API Key 唯一路径）。
  - 链路说明：设置保存 → `orchestrator` 取明文 → `OpenCodeBackend.buildEnv` 按模型 provider 映射为对应 env 变量 → `spawnOpencodeServer` 经 providerEnv 注入（env 白名单之外唯一放行通道）。
- [ ] **无残留进程**：`pgrep -fl "opencode serve"` 为空（有则先 kill，避免干扰判断）。

## A. GUI 手工验收

### A.1 启动与开会

启动（两个终端）：终端 1 `npm run dev`（vite）；终端 2 `npm run dev:electron`（编译 electron 并起 GUI）。

- [ ] **开会**：首屏 Lobby 点 **"Open another folder"** 选一个**测试用空目录**（建议 `~/tmp/ahastation-e2e`，OpenCode 会在里面写文件）→ 进入会议页。
  - 预期：会议 tab 打开，默认 host（Claude Code）在线；无报错横幅。
- [ ] **邀请 OpenCode 参会者**：参会者画廊底部 **"＋"（邀请参会人）** → 右侧抽屉 Participants tab → OpenCode 行点 **"邀请"**。
  - 预期：画廊出现 OpenCode 参会者卡片；卡片不报错（若 key 未配/配错，会在聊天流出现 auth 错误提示——回到 §0 检查 key 与模型 provider 是否匹配）。

### A.2 让 OpenCode 改文件 + 编辑器面板

- [ ] **下发任务**：在会议聊天里 @ 或直接对 OpenCode 参会者发：`用 todo 工具记一个两步计划，然后创建 hello.txt，内容为 hi`。
  - 预期：OpenCode 状态变为工作中；聊天流开始滚动其输出。
- [ ] **权限审批出现且批准后续跑**（会议头部 **"自动批准"保持关闭**）：
  - 预期：审批表面出现——安全工具（todo/read 类）在 SideDrawer **Chat tab 顶部**弹出权限卡（"⚡ … wants to use …"，按钮 **Allow once / Deny**）；写文件（write/bash 类）弹**原生系统确认框**。逐个点允许。
  - 预期：批准后任务继续推进直至完成；点 Deny 则对应操作中止但会话不死。
- [ ] **文件落盘**：测试目录下出现 `hello.txt`，内容为 `hi`。
- [ ] **打开编辑器窗口**：悬停 OpenCode 参会者卡片 → 操作条第一个图标按钮（tooltip **"打开编辑器"**）。
  - 预期：独立窗口打开，头部显示"← 返回会议"、状态灯、✕。
- [ ] **状态灯变化**：再发一个任务，观察编辑器头部状态灯：空闲 → **工作中**（彩色）→ 完成后回 **空闲**；出错时变 **错误**。
- [ ] **活动日志实时滚动**：右侧「活动日志」随任务推进持续新增条目（🔧 工具调用 / 💬 文本 / 📄 文件 / ⚠️ 状态），无需手动刷新。
- [ ] **Diff 面板 +/−**：右侧「改动」列出 `hello.txt +1 −0` 样式条目（绿色加号/红色减号），点击可打开文件。
- [ ] **Todo 更新**：右侧「待办」出现计划条目，状态图标随完成度变化（⬜ → 🔨 → ✅）。
- [ ] **文件树**：左侧「文件」树可见 `hello.txt`，点选后中间代码区显示内容。
  - 注：底部「终端」面板是 Phase 4 占位（"$ 终端：Phase 4 交付 PtyPanel"），本次不验收。

### A.3 断网恢复（checkpoint-resync）

- [ ] **断网 10s**：在 OpenCode 执行一个较长任务（如"创建一个 50 行的 notes.md"）中途，关闭 Wi-Fi 约 10 秒后恢复。
  - 预期：断网期间输出暂停（可能有"重试中"提示）；网络恢复后活动日志**继续滚动直至任务完成**，中间不丢段（事件流自动重订阅 + 快照合并）。`notes.md` 内容完整。

### A.4 双 OpenCode 参会者隔离

- [ ] **再邀请一个 OpenCode**：Participants tab 再点一次 OpenCode「邀请」。
  - 预期：画廊出现**两张** OpenCode 卡片（hostId 不同）。
- [ ] **各自开编辑器**：分别打开两个参会者的编辑器窗口。
  - 预期：两个窗口并存，标题各含其 hostId；给其中一个发任务，只有它的状态灯/活动日志/Diff 变化，另一个窗口不受串扰。

### A.5 收尾卫生

- [ ] **关会后无孤儿进程**：退出 app，`pgrep -fl "opencode serve"` 为空。

## B. 无头 smoke（自动化替代）

`scripts/e2e-opencode-smoke.mjs` 用真实 adapter 管线跑同一链路（不启动 GUI、不读 app 存储，key 只从环境变量读）：

```bash
export AHAMEET_E2E_API_KEY=sk-ant-...     # 或 OpenAI key
export AHAMEET_E2E_PROVIDER=anthropic      # anthropic(默认) | openai
npm run build:electron && node scripts/e2e-opencode-smoke.mjs
```

- **无 key 时**：打印 SKIP 与用法指引，`exit 0`（可安全挂 CI）。
- **逐步 PASS/FAIL + 汇总退出码**：全过 `exit 0`，任一项 FAIL `exit 1`；key 无效时末行打印鉴权提示。
- 覆盖对应关系：

| smoke 检查项 | 对应手工项 |
|---|---|
| buildEnv 把 key 接到 provider env | §0 key 链路 |
| session 启动（spawn + SSE + create） | A.1 邀请参会者 |
| prompt 回合完成 / hello.txt 落盘 | A.2 任务与文件 |
| permission.updated 被答复（once） | A.2 权限审批（脚本自动答 'once'） |
| session.diff 非空 / todo 更新 | A.2 Diff / Todo 面板数据源 |
| 断流重连后回合完成且事件不丢 | A.3 断网恢复（脚本杀 fetch 流触发 resync） |
| end() 后 server 进程退出 | A.5 进程卫生 |

- 脚本运行在工作目录临时目录（`$TMPDIR/ahameet-e2e-*`），结束自动清理；不触碰仓库与 app 数据。
