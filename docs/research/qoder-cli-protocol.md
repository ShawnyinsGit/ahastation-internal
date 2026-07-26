# Qoder CLI 协议速查（Phase 0 调研产出）

二进制：`/Applications/QoderWork.app/Contents/Resources/bin/qodercli`（Mach-O arm64，
`qodercli install` 可装入标准 PATH）｜另有 npm 包 `@qoder-ai/qoder-agent-sdk`（query() 编程路径）
｜桌面端：QoderWork.app，会话数据 `~/Library/Application Support/QoderWork/qoderwork-sessions`

## 拉起与注入
- 交互 TUI：`qodercli`（默认 interactive chat interface）
- 工作目录：`-w/--workspace <dir>`
- 一次性：`-p "<prompt>"`，`-f/--output-format text|json|stream-json`，`-q` 静默
- 恢复：`-r/--resume <sessionId>`；`-c/--continue` 续最近；`--fork-session` 恢复时开新会话
- 模型：`--model auto|efficient|lite|performance|ultimate|qmodel|kmodel|mmodel|gmodel|q35model`
- 自定义 agents：`--agents '<json>'`；附件：`--attachment`
- **`--with-claude-config`**：加载 .claude 目录的 skills/commands/subagents（兼容层）
- 并发作业：`--worktree` + `--path` + `--branch` 起 worktree job；`qodercli jobs` 列表、`qodercli rm` 清理

## 审批模式
- 默认：TUI 内逐个权限确认
- `--yolo` / `--dangerously-skip-permissions`：跳过全部权限检查（映射 "全部" 档）
- `--allowed-tools` / `--disallowed-tools`：工具白/黑名单（可映射 "仅读取" 档：
  允许 Read/Grep/Glob 等只读工具，禁 Bash/Edit/Write）

## Hooks / 轮结束信号
- `--help` 无 hooks 相关 flag；`--with-claude-config` 是否携带 hooks 未验证（Phase 4 实测项）
- 无 hooks 情况下的轮结束检测降级链：
  ① `qodercli jobs` 轮询 job 状态（running/done）——CLI 自带作业管理，最可靠
  ② stream-json 非交互模式不适用 TUI Worker 场景
  ③ 人工确认条兜底（与 claude-terminal 一致，完成判定本就在人）

## 状态文件
- `~/Library/Application Support/QoderWork/qoderwork-sessions`（桌面端会话，待 Phase 5 解析格式）
- `~/.qoder/`：external-commands/registry.json（可下载的外部命令插件）、logs、skills
- CLI 自身会话存储位置待 Phase 4 实测（估计 `~/.qoder/sessions` 或 QoderWork 共享）

## 集成决策
| 问题 | 选型 |
|---|---|
| 拉起方式 | qodercli TUI，`-w <worktree>`；binary 优先 PATH，回落 QoderWork.app 包内路径 |
| prompt 注入 | pty bracketed paste（无 argv prompt 参数） |
| 轮结束检测 | `jobs` 轮询（主）+ 人工确认条（兜底）；Phase 4 先实测 hooks 兼容性 |
| 批准等待检测 | 无 hook 事件 → 观察层读会话状态文件（Phase 5 解析格式后定） |
| 审批档位 | off=默认 / read=--allowed-tools 只读集 / all=--yolo |
| 风险 | 无官方 hooks 文档，全部行为需实测验证；jobs 语义需实测（TUI 模式是否入 jobs） |
