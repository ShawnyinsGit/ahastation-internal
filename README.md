# AhaStation

**语音会议式 AI 编程协作客户端** — 多个 CLI coding agent（Claude Code / Codex / Kimi / OpenCode / Qoder）以「数字员工参会者」身份加入你的视频会议：你说话，它们听、看、写代码、跑命令，并把进展讲给你听。

每个 backend 都是一个数字员工，语音对话开会即可完成协作；要看细节，点开任意员工的独立编辑器窗口。运行于桌面（macOS 优先），并为 RK3588 掌机（AhaStation 硬件）做了掌机模式与双屏适配。

## 核心特性

- **会议模式（默认）** — 语音优先的会议界面：员工磁贴（状态/speaking/权限卡）、屏幕共享与快照、会议级 Coordinator 编排多员工并行交付
- **会议内可见任务协作** — Coordinator 规划/审查/集成；Worker 在隔离 worktree 执行；高风险始终用户确认；最终 Meeting 验收才发布到用户基线
- **审查必须走完** — 冻结候选交给 Coordinator 后进入受驱动的审查回合：未覆盖完就按回合续推，审查期其它会议工具一律拒绝；停滞则暂停并交回用户，绝不自动判过
- **稳定 Worker 门禁** — Claude Code / Codex 需通过真实纵切烟测才标为 stable；OpenCode / Kimi 首发保持 experimental
- **员工独立编辑器窗口** — 每个数字员工一扇：文件树、代码查看（shiki 高亮）与编辑保存、Diff/Todo/活动实时面板、PTY 终端（xterm.js）
- **权限桥** — 工具调用的审批统一走会议 UI，destructive 操作落 macOS 原生确认框（防 renderer 伪造）；fail-closed 超时
- **陪伴屏** — 像素风虚拟会议室悬浮窗：每个员工一个角色一个工位，状态动画 + NPC 气泡 + 吉祥物聚合提醒（"3 人工作中 · 1 人卡住 · 1 条待审批"）
- **语音链路** — 本地 whisper.cpp ASR（Apple Silicon 实测）+ 系统 TTS；VAD barge-in 打断、声纹锁
- **掌机模式** — 小屏布局（chip 条/底部抽屉/审批模态卡）、编辑器 App 内 overlay（语音不断）、双屏热插拔迁移（外接显示器 = 桌面模式，内置屏 = 陪伴屏）
- **会话恢复** — append-only journal，重启后会议与员工会话可恢复（只读再激活）

## 运行要求

- macOS（Apple Silicon arm64）— 当前发布形态；Linux/Windows 在 CI matrix 上推进中
- Node.js 22+
- 至少一家 backend 的凭证（Anthropic / OpenAI / Kimi Code API key，或 Claude Pro/Max 订阅）

## 开发

```bash
npm ci
npm run dev          # vite + electron 开发模式
npm test             # 全量 node 测试（先构建 electron 侧）
# 双侧 typecheck
npm run typecheck
```

### 真实 Worker 稳定性烟测（付费，默认保护）

```bash
# 显式启用后才会调用真实 Claude / Codex Worker
set AHASTATION_REAL_WORKER_SMOKE=1
npm run test:real-workers
```

覆盖：WorkReport、Steering interrupt/resume、高风险权限桥、规范化决策、
审查集成与最终 Meeting 发布。OpenCode / Kimi 不因此升为 stable。

烟测**不会替会议提交审查结论**：它从不调用 `submitDeliveryChunkReview` /
`completeDeliveryReview`，只断言 Coordinator 自己调用了这些 MCP 工具并把覆盖率
走完。审查中途停住就是失败，不会被脚本补一刀盖过去。

## E2E 冒烟（OpenCode 后端全链）

```bash
export AHAMEET_E2E_API_KEY=sk-...        # 或 OpenAI / Kimi Code key
export AHAMEET_E2E_PROVIDER=anthropic    # anthropic(默认) | openai | kimi
npm run build:electron && node scripts/e2e-opencode-smoke.mjs
```

覆盖：二进制分发 → 密钥注入 → 会话与事件流 → 权限答复 → Diff/Todo 数据源 → 断流重连 → 进程卫生，共 10 项。

## 构建安装包

```bash
npm run dist:dmg     # macOS arm64 DMG（未签名体验版）
```

## 文档

`docs/` 下有设计/调研文档：OpenCode server 接入实测（`spike-opencode-server.md`）、Phase 2 验收清单（`e2e-phase2-checklist.md`）、Qoder/多后端 harness 调研、掌机与 UI 规划等。

## License

待定（未定开源协议前，保留所有权利）。
