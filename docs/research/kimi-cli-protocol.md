# Kimi Code CLI 协议速查（Phase 0 调研产出）

本机版本：0.29.1（`~/.kimi-code/bin/kimi`）｜文档：https://moonshotai.github.io/kimi-code/

## 拉起与注入
- 交互 TUI：`kimi`（默认），cwd 即工作目录；`--add-dir` 加额外工作区
- 一次性：`kimi -p "<prompt>" --output-format stream-json`
- 恢复：`-S/--session [id]` 恢复指定会话；`-c/--continue` 续当前目录上一个会话
- 模型：`-m/--model <alias>`；技能目录：`--skills-dir`
- prompt 注入方式：pty bracketed paste（与 claude-terminal 相同；TUI 无 argv prompt 参数）

## 审批模式
- 默认：TUI 内逐个询问
- `-y/--yolo`：自动批准常规工具调用，仍可能提问
- `--auto`：全自动，不提问（映射 auto-approve "全部"档）

## Hooks（轮结束 + 批准信号的关键）
配置于 `~/.kimi-code/config.toml` `[[hooks]]`（event/matcher/command/timeout），
stdin 收 JSON 上下文，退出码 0=允许 / 2=阻止（stderr 反馈给 LLM），超时 fail-open。
- 事件全集（13+）：PreToolUse✓阻、UserPromptSubmit✓阻、**Stop✓阻（轮结束信号）**、
  PostToolUse、PostToolUseFailure、**PermissionRequest（仅观察，批准等待前触发）**、
  PermissionResult、SessionStart、SessionEnd、SubagentStart/Stop、StopFailure、
  Interrupt、PreCompact/PostCompact、Notification（matcher=permission_prompt）
- **PreToolUse 为 deny-only**：ask/modify/additionalContext 被静默丢弃 → 不能用 hook 代批准，
  批准只能 ①用户键盘 ②-y/--auto ③经 session-actions 向 tty 打字
- Stop 防循环：二次触发时 `stop_hook_active=true`
- ⚠️ hooks 是用户级配置：worker 会话写入 hook 需用 per-session 配置注入
  （claude 用 `--settings <file>`；kimi 无等价 flag → 需测 `KIMI_CODE_HOME` 环境变量
  重定向数据根，或接受写入用户 config.toml 并管理冲突）

## 状态文件（观察层已有读取器）
- `~/.kimi-code/session_index.jsonl`（会话索引）
- 每会话 `state.json`（标题/状态，electron/observe/statefiles/kimi-sessions.ts 已解析）

## 集成决策
| 问题 | 选型 |
|---|---|
| 轮结束检测 | **Stop hook → 写 per-session JSONL → adapter tail**（同 claude 模式） |
| 批准等待检测 | PermissionRequest hook（观察事件）→ "等待批准"状态 |
| 代批准 | tty 打字（session-actions），不自动 |
| 审批档位 | off=默认 / read=-y / all=--auto |
| 配置注入 | **已实测 KIMI_CODE_HOME 有效**（kimi doctor 确认从重定向根读 config.toml）：用应用托管 home 注入 hooks，oauth/credentials 需 symlink 进托管 home |
