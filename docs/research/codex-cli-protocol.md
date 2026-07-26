# Codex CLI 协议速查（Phase 0 调研产出）

本机版本：codex-cli 0.144.1（`/opt/homebrew/bin/codex`）｜仓库：openai/codex

## 拉起与注入
- 交互 TUI：`codex [PROMPT]`——**首条 prompt 可直接作为 argv 传入**（比 paste 更稳）
- 一次性：`codex exec "<prompt>"`（非交互）；`codex review` 代码评审
- 恢复：`codex resume [id]`（picker）；`codex resume --last` 续最近；`codex fork` 分叉
- 桌面联动：`codex app` / `codex app-server`（observe 层已有 codex-desktop 读取器）

## 审批模式
- 默认：TUI 内逐个询问（Approve/Deny）
- `--full-auto`：自动执行低危，高危仍询问（映射 "仅读取" 档语义相近，需实测）
- `--dangerously-bypass-approvals-and-sandbox`：全跳过（映射 "全部" 档）
- `--sandbox <mode>`：read-only / workspace-write / danger-full-access

## Hooks（≥0.124 默认启用；0.125 起 inline TOML）
配置于 `~/.codex/config.toml`：`hooks = true` + `[[hooks.<Event>]]` +
`[[hooks.<Event>.hooks]]`（type = "command"，command，timeout）。
- 事件：SessionStart（matcher startup/resume/clear）、UserPromptSubmit、
  **PreToolUse**、**PermissionRequest**、PostToolUse、
  **Stop（轮结束信号）**、SubagentStart/Stop、PreCompact/PostCompact
- 不支持 Notification 事件（tui.notifications = true 可作桌面通知补充）
- ⚠️ **非托管 command hooks 需在 TUI 里 `/hooks` 手动信任一次才生效**——
  集成必须在首次拉起时引导用户点信任，或以 managed hooks（requirements.toml）下发
- Legacy `notify = ["program", "turn-ended"]` 仍可用（用户 config 已有实例），
  作为 Stop hook 之外的冗余轮结束信号；plugin hooks 需 `codex features enable plugin_hooks`

## 状态文件（观察层已有读取器）
- `~/.codex/sessions/**/rollout-*.jsonl`（electron/observe/statefiles/codex-sessions.ts 已解析）
- `~/.codex/history.jsonl`、`session_index`（若有，按读取器现状）

## 集成决策
| 问题 | 选型 |
|---|---|
| prompt 注入 | **argv 直传 `codex "<prompt>"`**，pty paste 兜底 |
| 轮结束检测 | Stop hook 写 JSONL（主）+ notify 回调（冗余，用户已有先例） |
| 批准等待检测 | PermissionRequest hook → "等待批准"状态 |
| 代批准 | tty 打字（session-actions）；hooks 信任问题需首跑引导 |
| 审批档位 | off=默认 / read=--full-auto / all=--dangerously-bypass-approvals-and-sandbox |
| 配置注入 | **已实测**：`CODEX_HOME=<dir>` 支持叠加 `<name>.config.toml`，`-c key=value` 可覆盖任意配置项；托管 home 注入 hooks + symlink auth.json/sessions 即可不动用户配置 |
