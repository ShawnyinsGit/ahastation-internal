# AhaMeet 客户端软件细化技术方案

> **版本**：v1.2　**日期**：2026-07-20
> **v1.2 变更**：四路红队 grill（架构安全 / 产品 UX / 语音发布 / 硬件整机）结论落地——§2.2 安全规约六条扩为九条、事件归因表替代 sessionID 过滤、hostId 窗口主键、语音默认改流式 provider、Phase 6 拆分、陪伴屏补差异化判据与气泡规范、Phase 5 验收口径修正等 ~20 处。
> **v1.1 变更**：修正决策登记冲突（新增 §0 映射表）、陪伴屏范围恢复多角色像素会议室、语音供应商口径合并、Electron 33→42、范围声明改写。
> **依据文档**（事实来源，本文不复述其论证过程）：
> - `docs/plan-ahastation-rk3588-overall.md`（下称「整体方案」，v1.1 已经硬件整机 grill 评审修订）
> - `docs/plan-phase2-ide-handheld.md`（下称「Phase2 方案」，v3 红队评审 + grilling 决策版，Phase 0–8，软件 D1–D10）
> - `docs/orchestrator-v2-progress.md`（orchestrator v2 实施状态）
>
> 范围：**以客户端软件本体为主**（AhaMeet，Electron 42 + React 18 + TS）；硬件/系统仅在涉及软件接口处引用（标注「硬件接口」），其论证见整体方案，不在本文展开。

---

## 0. 决策映射（两套决策登记处的对齐与裁决）

本方案引用的决策有两个独立来源，**编号各自独立、同号不同义**：「软件 Dn」出自 Phase2 方案 v3 的 grilling 会话（用户逐题确认）；「整机 Dn」出自整体方案的 grill 会话。正文引用统一带前缀，冲突裁决如下：

| 主题 | 软件 Dn（Phase2 v3） | 整机 Dn（整体方案） | 裁决 |
|---|---|---|---|
| 编辑器掌机形态 | D1：App 内 overlay，会议 hooks 保活 | D7：同 | 一致，不冲突 |
| 外接显示器行为 | D2：外接即桌面模式，内置屏转陪伴屏 | D6 款一：同 | 一致 |
| 陪伴屏形态 | D3：host 吉祥物统筹；D4：**多角色像素会议室 + 每人工位 + NPC 气泡**（真实对话摘要）；D5：Phaser 3 + CC0 素材 | D6 款二：「v1 单吉祥物渲染」 | **以软件 D3/D4/D5 为准**——多角色像素会议室是 v1 目标，「单吉祥物渲染」仅为开发中间切片（整机 D6 已在整体方案 v1.1 回改）。差异化判据与气泡规范见 §3.4 |
| 陪伴屏排期 | D6：独立 Phase 8，MVP 先行，桌面版可用 | §9.1：同 | 一致 |
| 语音链路 | D7：云端优先，本地 whisper 断网兜底，本地三平台内置 | D5：同 | 一致 |
| 云端语音供应商 | D8：provider 可配置 | Q5：供应商未选，验收指标先行锁定 | **v1.2 用户裁决**：默认实现为**流式 ASR provider**（Deepgram/火山/讯飞类，满足流式/首字 <500ms/barge-in）；whisper-1 批量 API 仅作免费兜底 profile（标注达不到延迟与 barge-in 指标）；终选在 Phase 6c 真机验收前定（整机 Q5） |
| Linux 包格式 | D9 | §4.1 | **v1.2 用户裁决**：**AppImage 为主**（SteamOS 装 FUSE2 可跑）；Flatpak 降为「后续评估」——其沙箱与 spawn agent CLI/PTY 的核心功能冲突（见 §3.5）；AhaStation 打系统镜像无此约束 |
| 签名与更新 | D10：未签名 + electron-updater | §3.6/§9.1：系统侧 OTA 对齐 | **按平台拆分**：win/linux 未签名 + electron-updater；**mac 未签名包 Squirrel.Mac 拒装**——mac 短期只做版本检查 + 手动下载提示，签名公证并入 Phase 7 H 项后再开 mac updater（需 zip target + latest-mac.json）；AhaStation 整机走系统 OTA，两轨并存，**OTA 版本仲裁**：系统镜像内置应用版本 ≥ electron-updater 通道版本时以系统为准（防系统 OTA 回滚覆盖应用新版） |
| 整机形态 | — | D2 vs S3 排期矛盾 | **v1.2 用户裁决**：双轨——Track A：v1 公模/中度定制 8" 平板先行；Track B：v2 全新 6.5–7" 手机 ID（T0+12–18 月）；Q11 商业门前移至 S2 样机验收（见整体方案 v1.1 §6/§10） |
| 范围声明（v1.2 补登） | Phase2 §五「不做 Linux ARM」 | AhaStation 即 ARM64 | **Phase2 的"不做 Linux ARM"被本方案推翻**（§3.5 linux-arm64 runner、CX10A 验收）；Phase2 文档该条仅适用于当时对外分发语境 |

---

## 1. 定位与当前基线

AhaMeet 是 AhaStation 的软件本体：语音会议式 AI 编程协作客户端，多 agent（Claude Code / Codex / Kimi ACP / OpenCode）以「数字员工参会者」形式接入，语音（ASR/TTS）为第一交互。在 AhaStation 上它同时服务两种形态（整机 D6/D7）：

- **口袋/掌机模式**：6.5–7" 触屏，App 内全屏，语音优先，编辑器为 App 内 overlay。
- **桌面模式**：外接显示器（DP Alt Mode 热插拔触发），独立窗口多开，内置屏退化为陪伴屏（Phase 8）。

### 1.1 已完成基线（orchestrator v2，2026-07-17 状态）

A–G 全部完成，构成后续工作的地基，**不要重写**：

- Backend 运行时/会话地基、Meeting/Coordinator 领域核心、MeetingCommand + 全局 Scheduler；
- 工作区隔离（Git worktree + 非 Git 路径锁）与恢复（append-only journal、interrupted 任务显式恢复、不自动重放）；
- 三条原生传输：Codex app-server（initialize/account/thread/turn，OAuth 握手）、Kimi ACP（initialize/auth/session/resume/prompt/cancel，强制 plan mode）、Claude Agent SDK 0.3.150 精确锁定 + 原生 sessionId resume；
- 打包态 `app://bundle` 特权协议（path-confined）、`crossOriginIsolated=true`、SharedArrayBuffer 可用（ONNX/VAD）、打包 Whisper（Apple Silicon CPU 插件）中文转写实测通过；
- 109/109 Node 测试、双 tsconfig typecheck 通过、DMG 未签名体验版 `AhaMeet-0.16.3-arm64.dmg`。

**未闭合项**：正式发布门（装机全矩阵手测、2h 2-Host/4-Worker soak、签名公证）——H 项，列入 Phase 7 打包闭环一并收口。

### 1.2 已知缺口（Phase2 方案 Gap 分析，均为代码实测）

P0：编辑器与会话脱节（G1）、权限链路断裂（G2）、事件流无真实数据（G3）、server 端口 4096 撞车（G6）、opencode 二进制不在包里（G9）、server 无鉴权（G12）、既有 IPC 任意文件读取（G11）。
P1：无终端（G4）、文件无写（G5）、无会话恢复（G7）、无 IDE 抽象层（G8）、样式无响应式（G10）。

---

## 2. 进程架构与安全模型（细化）

### 2.1 三进程职责

| 进程 | 职责 | 硬约束 |
|---|---|---|
| Main（Node） | agent server 生命周期（自写 spawn/binaryPath/port=0/exit 监听/进程树 kill）、全部 SSE/WS 消费与**按归属 fan-out**、文件写（path confinement）、PTY 代理、权限 broker、原生确认框、窗口/显示模式管理、**云端语音 key 持有与 WS 发起** | renderer **永不持有** 任何 agent serverUrl 与云端语音 key（Phase2 R8 定案） |
| Preload | 窄 IPC 白名单 API；CSS class 与 preload API 名在 ide-* 通用化中**保留旧名**降低 churn | contextIsolation 开，nodeIntegration 关 |
| Renderer（React） | 会议 UI、编辑器远程控制台 UI、掌机 overlay、云端 TTS 播放管线（§3.2）；全部数据经 IPC | CSP `connect-src 'self'`；编辑器窗口独立 session partition 或全局按 URL 分发的单一 CSP handler |

### 2.2 安全模型（九条不可协商）

1. **全流量主进程代理 + payload 校验落点**：server SSE → main → IPC → renderer；写操作（prompt/interrupt/permission reply/文件读写/PTY）走带校验的 IPC。**校验落点**：`electron/ipc/ide-*.ts` 每 channel 一个 zod schema（zod 已是依赖，集中 `validators.ts`），每条 IPC 校验 `event.sender` 归属；Phase 1 验收含"新 channel 全部有 schema + sender 校验"门禁。
2. **fail-closed 权限**：PermissionBroker 超时（默认 120s，可配，需与 server 端 permission 生命周期对齐——**Phase 0 未能实测**：spike 环境无可用 provider key，列入 Phase 2 首周，见 `docs/spike-opencode-server.md` §7）或崩溃 → 显式 deny；`end()`/窗口关闭/app 退出 auto-reject 全部 pending。
3. **destructive 必须过原生框**：`nativeConfirmDestructive`（main 进程对话框），防 renderer 伪造；broker 复用而非绕过；掌机模态卡与原生框的衔接：模态卡统一承接普通审批，destructive 升级为原生框。
4. **server 鉴权与缓解组合**（**已实测 2026-07-21，前提修正**：opencode 1.18.4 有原生 HTTP Basic auth——`OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`（默认 `opencode`），覆盖全部端点含 SSE，见 `docs/spike-opencode-server.md` §3）：**仅绑 127.0.0.1**（自写 spawn 后 bind 地址是自由选择，一次疏忽即局域网无鉴权 RCE）+ 随机高端口 + **每次启动生成随机 `OPENCODE_SERVER_PASSWORD`（env 注入，main 持有，renderer 永不可见，main 代理时注入 Authorization）** + 全代理 + **spawn 注入钉死 config**（`OPENCODE_CONFIG_CONTENT` 设 permission=ask 类，禁 auto-accept——否则 PermissionBroker 被 server 侧配置架空）+ 威胁模型入文档。实测残余面：服务端不校验 Origin（盲写 CSRF）与 Host（不防 DNS rebinding），密码 + loopback 组合后基本归零；随机端口对同机攻击者是 obscurity，不能替代前五条。
5. **删自建文件 IPC + CSP 具体删除项**：`electron/ipc/opencode-files.ts` 在 Phase 1 删除（cwd 未白名单 = 任意文件读取）；`opencode-editor:open` 加来源窗口校验 + cwd 白名单（**hostId 主键**，cwd 由 main 从 orchestrator 按 hostId 解析，renderer 提供的值仅作显示）；**删除编辑器窗口 CSP 的 `connect-src http://localhost:*`**（opencode-window-manager.ts，存在期间规则 1/4 全部归零）与 prod CSP 的 `'unsafe-eval'`（编辑器不跑 ONNX/VAD，白送 eval 面）；四处 `onHeadersReceived` 收敛为单 handler 按 URL 分发或编辑器窗口独立 partition。
6. **server file API 隔离**（**已实测 2026-07-21**：默认 instance directory 内 confinement 有效——`../` 与根外绝对路径均被拒（500 "Path escapes the location"）；**但 `directory` query 参数可把根换成任意绝对路径而无校验，`directory=/` 实测读通 `/etc/passwd`，隔离等于无效**，见 `docs/spike-opencode-server.md` §4）——**main 侧 path confinement 必须做**：代理 file/pty/session 类请求时剥除或白名单化 `directory` 参数（只允许 registry 登记的 cwd），`path` 解析后必须落在 cwd 内。
7. **fan-out 路由与权限隔离（多参会者防串台）**：每编辑器窗口创建时在 main 登记 `(hostId, opencodeSessionID) ↔ webContents.id` 绑定；fan-out **按绑定点对点 send，禁止 `getAllWindows()` 广播**；permission 事件只投 owning 窗口 + 主会议窗；每次投递校验 sender 归属；窗口关闭/re-attach 时重建绑定。过滤（入口）≠ 路由（出口）。
8. **PTY 条款**：`pty.create` 的 body 即任意命令（command/args/env），pty 事件 server-global 无 sessionID——pty IPC 绑定 webContents.id，每次 input 校验 sender；create 视为 destructive（用户显式打开 + 绑定创建）；input 帧加大小/频率限制；威胁模型显式声明残余风险"编辑器窗口 renderer 被信任持有 shell 等价 IPC 面"。
9. **spawn env 卫生与 auth 注入**：SDK spawn 把 `...process.env` 全量遗传 agent 子进程（Electron 主进程持有的各家 provider key 全泄）——自写 spawn 必须 **env 白名单** + per-backend key 按需注入（修复 `buildEnv` 死代码/`validateAuth` 只校验不传递的断裂）。

### 2.3 事件归因表（替代 v1.1 的 sessionID 过滤规则）

「必须带 sessionID 过滤」对 SDK 类型写错了对象，按事件类型分两级归因：

| 级别 | 事件 | sessionID 位置 | 路由 |
|---|---|---|---|
| session 级 | `message.part.updated` / `message.updated` / `session.*` | `properties.part.sessionID` / `properties.info.sessionID`（注意 `session.error` 的 sessionID optional） | 按规则 7 点对点投递 owning 窗口 |
| instance 级 | `file.edited` / `file.watcher.updated` / `vcs.branch.updated` / `lsp.*` / `pty.*` / `server.connected` | **无 sessionID** | 按 server instance → registry `(meetingId, cwd)` → 该 server 上全部绑定窗口；**文档显式承认泄漏面**：同 server 多参会者互见文件活动 |

---

## 3. 模块细化方案

### 3.1 IDE 适配层（编辑器 = OpenCode server 的「远程控制台」）

```text
electron/
  ide/
    ide-adapter.ts                 # EditorIdeAdapter 接口（attach → IdeEditorHandle）
    ide-registry.ts                # 已安装 IDE + defaultIdeId + perHostOverride（userData JSON）
    ide-window-manager.ts          # 窗口创建（workAreaSize 默认尺寸，掌机 maximize，无 minWidth）
    opencode/
      opencode-editor-adapter.ts
      opencode-server-registry.ts  # 键 (meetingId, cwd)；显式端口；refcount；exit 监听；孤儿回收
```

关键设计点（v1.2 修订）：

- **窗口与 IPC 主键 = hostId**：现窗口键 `backendId:sessionId`（sessionId 为会议 tab id）——两个 OpenCode 参会者同会（Phase 0 验收项）键必撞，第二个编辑器开不出来；调用侧有 hostId 但在 IPC 边界丢弃。窗口键、`opencode-editor:open/close/list` payload、fan-out 绑定全部改 hostId（与 IDE override 键对齐），**列入 Phase 1 安全修复**而非 Phase 3。
- **二进制分发（G9，Phase 0 定案，已实测 2026-07-21）**：`opencode-ai@1.18.4` = 空壳 + postinstall（硬链平台包 binary 到 `bin/opencode.exe`，138MB），12 个平台 optionalDeps 自包含；**打包直接依赖平台包 `opencode-<platform>-<arch>`（如 `opencode-darwin-arm64`）+ asarUnpack `**/node_modules/opencode-*/bin/**`，绕开 postinstall**；linux x64 需按 AVX2/musl 选 baseline/musl 变体（选择逻辑可照抄 postinstall），RK3588 有官方 `opencode-linux-arm64`。**自写 spawn（估 ~120 行**——含 env 白名单、config 注入、stdout banner 解析、port=0、启动后 exit 监听、进程树 kill）**实测可行**：`--port=0` 首选 4096、被占自动挑空闲端口（双实例不撞），banner 为 `opencode server listening on http://…`（未设密码时前面多一行 warning，解析须全文正则），无子进程、SIGTERM 干净退出无孤儿，`GET /global/health` 可作 liveness；绕开 `createOpencodeServer`（无 binaryPath 注入点、exit handler 仅启动期有效）。与 SDK client 配对：banner 解析得 url 后 `createOpencodeClient({ baseUrl: url, directory: cwd })`（SDK 公开导出，directory 经 header/query 注入），一 `(meetingId, cwd)` 一 client。证据见 `docs/spike-opencode-server.md` §1/§2。
- **事件流硬顺序与重连（G3）**：**subscribe-before-create**：subscribe → `session.create` → 注册 sessionID 过滤项 → 首个 prompt（现 adapter 先 create 后订阅，greeting 触发的即时 `permission.updated` 会丢）。断线重连 = **checkpoint-resync 带去重**：重订阅 → buffer 新事件 → 全量拉 `session.messages/todo/diff` → 按 (messageID, partID) 去重（last-write-wins）→ 续播（拉取期间订阅活跃会双计 delta，拉完才订阅会丢窗口期事件，两种裸实现都做不到"断流不丢"）。**SSE Last-Event-ID 已实测 2026-07-21：不支持**——事件帧从不带 SSE `id:` 行（evt_ id 只在 JSON payload 内），`Last-Event-ID` 被服务端忽略、断线窗口事件不补发（SDK 客户端的续传逻辑因此是死代码），checkpoint-resync 方案保留。**SSE 端点选择已定：per-instance `/event`**——`/global/event` 是全局总线且事件多包一层 `{"payload":…}`，一 `(meetingId, cwd)` 一 server 架构下 only 增加跨 directory 泄漏面。证据见 `docs/spike-opencode-server.md` §5。
- **活动日志映射**：`message.part.updated`(text/tool/step)、`session.diff`、`todo.updated`、`session.idle/status/error`（状态灯）、`file.edited`——按 §2.3 归因表路由。
- **权限桥（G2）**：新建 provider-neutral PermissionBroker，复用 `auto-approve-policy` 风险分类；值域 UI `allow/deny` → opencode `once/reject`（always 不上 UI）；opencode 工具名 → `SAFE_BUILTIN_TOOLS` 映射表必做；双端可见审批靠 `EventPermissionReplied` 幂等消除。**always 的后续闭环**：Phase 0 spike 两项验证**未能实测**（spike 环境无可用 provider key，见 `docs/spike-opencode-server.md` §7）——server 端 permission 生命周期（有无自身超时）、`always` 答复后同类请求是否还发 `permission.updated`（若不发，broker 对该类工具永久失明），均列入 Phase 2 首周；答复端点 `POST /session/{id}/permissions/{permissionID}` 已从 SDK 类型确认存在。
- **文件与编辑（G5）**：读走 SDK `file.list/read/status` + `find`；写只有 main `fs.writeFile` 一条路径，写后靠 server watcher 的 `EventFileWatcherUpdated`，UI 手动 refresh 兜底；diff 用 `session.diff` 不自算。
- **终端（G4）**：`@xterm/xterm` + `addon-fit`（~90KB gzip），命名 `PtyPanel`（避免与 TerminalPanel 冲突）；main 做 WS 代理（**已实测 2026-07-21**：WS 下行 text/binary 混合帧、上行两种都收，xterm `write()` 均兼容；**resize 走 REST `PUT /pty/{id}` `{size:{rows,cols}}`**，WS 无控制通道；连接后服务端发初始缓冲输出；Basic auth 下浏览器 WebSocket 无法带 `Authorization` header，main 代理是硬需求——见 `docs/spike-opencode-server.md` §6）；PTY 生命周期归 registry，每窗口最多 1 个；安全条款见 §2.2 规则 8。
- **会话恢复（G7）**：**journal 是 session 身份唯一真相**（orchestrator v2 已有 per-host `{sessionId, protocol}` 快照与 `resumeBackendSessions`）；registry userData JSON **只存易失运行时**（pid/port/启动戳/liveness），不存 session 身份——杜绝双真相源发散。re-attach 统一走 `sessions:open(recoveryMeetingId)` → orchestrator resume 驱动 registry 重建，编辑器侧不做独立恢复路径。`end()` 只断 stream 不 delete——**契约变更需扩散**：orchestrator 会议结束路径对 OpenCode 变为挂起语义，re-attach 的事件源重建一并设计（现 adapter `emit('ended')` 后 noop 化 emit，与 re-attach 冲突）。registry 补**生命周期矩阵**（end/窗关/app 退/会议删除 × 杀或留）与 **adopt-or-kill 规则**（同 cwd 孤儿：探活，活则 adopt，死则回收；macOS 无 pdeathsig，探测依据 = pid 存活 + port 探测 + 启动时间戳）。
- **IDE 选择**：override 键是 **hostId 不是 backendId**；Hermes/Pi 只留接口 + 降级路径（capabilities 隐藏面板，退化为 fs 浏览 + 会议事件转发）。

### 3.2 会议语音链路（整机 D5/§3.4/§4.3–4.4）

| 链路 | 在线（主） | 离线（兜底） |
|---|---|---|
| ASR | **流式 profile（默认）**：Deepgram/火山/讯飞类 WS/gRPC 流式，中文优先，首字 <500ms，支持会话内取消。**批量 profile（免费兜底）**：OpenAI whisper-1——批量 HTTP 非流式，**达不到 <500ms 与 barge-in 指标**，UI 明示能力差异 | whisper.cpp NEON 自编译（RK3588 cmake，CI 纳入），small-q5_1 实时率 ≥1× 为可用线（CX10A 实测标定） |
| TTS | 云端流式，延迟 <1s | 开放问题 Q6（piper 类，v1.x 评估）；Linux Chromium `speechSynthesis` 零语音是已知坑（R10），启动枚举 `getVoices()` 为空则明确降级提示 |
| 弱网降级 | 降级顺序（v1.2 修正，ASR 上行仅 ~16–32kbps 从不是瓶颈）：**TTS 降文字气泡 → agent 心跳/事件降频 → ASR 最后**（保交互核心，极端断网才切本地 whisper）；触发信号用现成指标（云端 ASR 首字延迟、TTS 首包延迟的滑动窗口），不另起 RTT 探测体系 | 5G/WiFi 自动切换，切换对 ASR 流的断线 resync 复用断线重连设计 |
| 省电 | 电量 <10%（v1.2 修正）：**停 TTS 播报转文字气泡、保 ASR**（弱网+低电时砍本地兜底 = 语音全灭） | — |

- **provider 口径（§0 裁决）**：验收指标先行锁定（上表）；provider 抽象可配置，默认实现流式 ASR profile + 同家/ OpenAI-compatible TTS profile；key 管理复用现有 backend 设置；**key 只存 main，WS 由 main 发起**（与 §2.2 规则 1 一致）；音频流经 main 代理的 IPC 拷贝成本计入首字延迟预算（架构决策，不留到实现期）；音频出本机 UI 明示 + **组织级禁用云端语音的硬开关**（企业采购门槛项）；终选 Phase 6c 前定（整机 Q5）。
- **renderer 音频播放管线（v1.2 新增，此前无人认领）**：云端流式 TTS 需要新播放层——chunk 无缝拼接（Web Audio/MSE）、barge-in 时 abort HTTP 流 + 丢弃已缓冲音频、播放状态抽象为 `suppressed` 信号接口（云端/本地 TTS 都喂它）。
- **barge-in（v1.2 重新界定）**：是**客户端属性**，云端 ASR 只需支持会话内取消。本地已有 VAD 级半成品（TTS 播放中 VAD trip → 置信度门控 → voice-lock 回声门 → cancelSpeech），前提是播放状态本地可知——TTS 换云后 `suppressed` 信号源需按上条重建。**AEC 责任归一**：优先 Chromium `echoCancellation`（AEC3），双麦阵列只做降噪，不叠 webRTC APM/SpeexDSP 双 AEC；RK3588 上 AEC3 的 CPU 开销列入 Phase 6c 实测。

### 3.3 掌机 UI（Phase2 §3 + 整机 D6/D7/§5.2）

- **判定**：手动「掌机模式」三档开关为主（自动/强制掌机/强制桌面，Settings 持久化）；启发式只定首值：`(pointer:coarse)` 且 `screen.width ≤ 1300`。**掌机布局由模式开关状态驱动根 class**，宽度断点只做档内微调（v1.2 修正：纯宽度断点在两个目标设备上都不命中——Steam Deck 1280 落 desktop 档、AhaStation 1080p 7" 按 2x 缩放横屏 960 落 compact 档）。三档参考值按 **2x @1080p/7"（~310dpi）假设重算**：desktop ≥1100 / compact 720–1100 / handheld <720（档内微调用）。
- **密度**：不做全量 token 化（323 处硬编码 font-size 不重构），新增 `--density-scale` 只在掌机模式覆盖关键组件；触控目标 ≥44px；hover-only 交互在 coarse 下常显/长按。
- **会议小屏布局**：stage 全宽顶部、磁贴变横向 chip 条、聊天变底部抽屉、底栏固定 5 键（mic/扬声器/共享/打断/结束；现底栏 7 键，快照/聊天进「更多」，聊天与底部抽屉同一入口）、**权限审批 = 底栏角标 + 模态卡**（最高频阻塞交互，不收抽屉；destructive 按 §2.2 规则 3 升级原生框）、横屏优先（头+底+chip 预算 ≤200px，相对横屏逻辑高 540px 约 37%，已核算）。
- **编辑器掌机形态（整机 D7 / 软件 D1 已定案）**：App 内全屏 **overlay 非路由替换**——会议 hooks（useClaude/useAsr/useTtsWiring/useVoiceLock）挂 App 树，替换渲染即杀死语音链路；overlay 底部保留迷你语音条；三栏折叠为底部 tab（文件/代码/日志/终端）；顶部员工 chip 条做多员工导航；设置改全屏页，stage popout 禁用。
- **侧键交互（整机 §5.2，v1.2 补全）**：**默认连续对话**（与桌面一致，不开倒车到 PTT）；K1 按住 = 临时开麦（对齐桌面空格语义）、K2 打断、K3 电源/亮灭屏/双击开会议、K4 自定义；模式状态进底栏常显 + 切换提示音（双击可发现性问题）；**唤醒吞键策略**：suspend 下按 K1 = 仅唤醒，松开后再按才开始说话（防误录）；**overlay 上下文的语音路由**：语音默认发会议，长按员工 chip 可锁定对讲该员工；**GPIO → input 子系统 → Electron 注入通道**（uinput 虚拟键盘或 native globalShortcut）列为 Phase 6c 工作项；K1/K3 为 suspend 唤醒源（BSP 设备树 GPIO wake 配置，硬件接口）。

### 3.4 陪伴屏（Phase 8，软件 D2–D6）

- **差异化判据（v1.2 新增，产品判据）**：会议窗格 = 操作与细节；陪伴屏 = **聚合态 + 异常 + 氛围**。陪伴屏存在的真正场景：桌面模式下编辑器窗口盖住会议窗口时，陪伴屏是**唯一的会议感知通道**；掌机口袋模式瞄一眼知道"会还在跑、没人卡死"。信息分工规则落入验收：mascot 聚合提醒（"3 人工作中 / 1 人卡住 / 1 条待审批"）为一级信息，逐人气泡为二级氛围信息。
- **状态模型内核一次到位**：虚拟办公室状态模型（参会者/任务/空闲等状态机）与渲染解耦。
- **v1 渲染目标（软件 D3/D4 保，补内容规范）**：像素风虚拟会议室 MVP——固定会议室地图一张 + 每个参会员工一个角色一个工位 + 状态动画（idle/工作中/卡住/完成庆祝/告警）+ **头顶 NPC 聊天气泡** + host 吉祥物统筹提醒。**气泡内容规范**（v1.2 新增，Phase 8 验收前置项）：① 数据源与 TTS 播报同源（天然串行限频，不跟 firehose 事件流）；② 单气泡 ≤40 字硬截断 + 尾部省略；③ 每角色同时 1 条，新消息替换旧消息，生命周期 ≤8s；④ 多条积压合并为计数徽标；⑤ 非对话事件（tool/diff/todo）映射固定短语模板（"正在编辑 auth.ts"/"等待审批"），不进气泡正文。
- **多会议与工位生命周期（v1.2 新增）**：多会议 tab 时 v1 跟 activeId + 切会过渡动画，mascot 跨会聚合异常提醒；工位固定 6 槽位——加入 = 空槽落座动画，退出 = 工位空置蒙尘，超出 6 人进「站立旁听」区；coordinator 移交时 mascot 换形做过场动画。
- **音效策略（v1.2 新增）**：与会议 TTS 同设备同扬声器——mascot 提醒音与 TTS 播报**互斥**（TTS 活动时静默），ducking 规则；提醒分级（权限请求 = 强提醒 / 交付完成 = 轻提示）；默认开启可关。
- **性能/功耗预算（v1.2 新增，顶整机 R4 散热第一风险）**：静态场景降帧 ≤15fps；无状态变化时停渲染只留合成；整机温度联动降档（与三档 DVFS 挂钩）；「陪伴屏常亮」纳入 S1 散热验收周负载定义。
- **技术与素材（软件 D5）**：Phaser 3 + CC0 素材（Kenney 等）或 AI 生成像素素材；**禁用 Star-Office-UI 素材**（非商用授权）；BFS 寻路与状态机思路可参考 PixelAgents（MIT）。
- **触发矩阵（v1.2 补全三类入口）**：AhaStation——DRM hotplug → 显示模式切换守护进程 → 整机 D6 状态机；通用掌机——Electron `screen` display 事件驱动；**纯桌面 Mac/PC——手动开关**（底栏或托盘入口 + 悬浮窗形态，软件 D6「桌面版同样可用」）。双屏迁移只动 BrowserWindow bounds，不重建 webContents（语音不断）；overlay↔独立窗形态切换经 renderer 状态序列化保留现场。

### 3.5 平台与打包（Phase2 §3.4 + 整机 §4.1）

1. **CI matrix 是结构前提**：macos/windows/ubuntu 三 runner 分别构建（codex/opencode 平台子包按宿主解析，单机交叉打包不成立），废弃 `dist:all`；linux-arm64 runner 随 Phase 6b 加入（GitHub public 仓库可用免费 `ubuntu-24.04-arm` runner）；win/linux 的 arm64 target 在验证前从配置修剪或标注未验证（口径与 Phase2「不做 Linux ARM」的推翻登记一致，见 §0）。
2. **whisper 跨平台**：x64 用 whisper.cpp v1.9.1 官方预编译（修 fetch 脚本 404）；**ARM64 必须 NEON 自编译**（官方预编译仅 x64）——fetch 脚本目前只有下载/brew 两条路径，cmake 编译逻辑要新写；`GGML_BACKEND_PATH` 硬编码 `libggml-cpu-apple_m1.so` 按平台参数化（Linux 下 ggml backend 命名/加载机制不同，不只是换文件名）；模型「包内 vs 首启按需下载」Phase 6b 前定案，按需下载必须带 hash 校验与版本管理（现 fetch 脚本只比 size）；**CI 加打包后资产断言**（whisper 二进制 + 模型缺失即 fail——现脚本下载失败 exit 0，会静默产出无 whisper 的包）。
3. **OSK 现实**：Linux 掌机 Electron 无可靠 OSK 通道 → 语音优先 + 内嵌 web 键盘兜底 + `visualViewport` 处理；Win11 touch keyboard 实测。
4. **显示服务器**：`ozone-platform-hint` 策略、分数缩放、触屏手势 XWayland 表现入 Phase 6c 实测矩阵；出货 AhaStation 为 Wayland 单栈 + `--ozone-platform=wayland`。
5. **包格式与更新（v1.2 用户裁决 + 修正）**：AhaStation 自身打进系统镜像（deb/rootfs 内置）；对外掌机 Linux **AppImage 为主**（注明 FUSE2 依赖），**Flatpak 后续评估**——其沙箱内看不到宿主 node/git/opencode，`flatpak-spawn --host` 需高危权限且 Flathub 审查严，与产品核心功能冲突，若未来上架只能发功能受限版。更新：**发布自动化流水线是 electron-updater 的前置**（CI 构建 → 上传 GitHub Releases → latest.yml，当前 `--publish never` + `writeUpdateInfo: false` 连物料都不产出）；win/linux 未签名 + electron-updater；**mac 未签名 Squirrel.Mac 拒装**——短期版本检查 + 手动下载提示，签名公证（Phase 7 H 项）后开 mac updater（补 zip target + latest-mac.json）；系统 OTA 与 electron-updater 的版本仲裁见 §0。
6. **Agent CLI 集成矩阵**（整机 §4.2，已核实）：OpenCode/Claude Code/Codex/Grok Build 均有官方 aarch64；Hermes（纯 Python）/Pi（纯 Node）/OpenClaw（仅 CLI）跨平台可跑——ARM64 无平台障碍。

---

## 4. 分期路线（v1.2：Phase 6 拆分，软件 Phase 与硬件阶段对齐）

| Phase | 内容 | 验收 | 硬件时间轴（整机 §9.2） |
|---|---|---|---|
| 0 | spike：二进制分发、端口分配、server 鉴权、PTY 协议、SSE Last-Event-ID、always 后续行为、server file API 隔离强度 | **已实测 2026-07-21（6/7 项）**，结论回填 §2.2 规则 2/4/6、§3.1 G2/G3/G9，证据 `docs/spike-opencode-server.md`：自写 spawn 可行、原生 Basic auth 存在、file API 隔离被 `directory` 参数绕过（main 必须 confinement）、SSE 无续传（checkpoint-resync 保留）、PTY resize 走 REST PUT；always 后续行为与双 OpenCode 参会者同会**未验**（无 provider key），列 Phase 2 首周 | T0，S0 黑客松（RDK X5） |
| 1 | 安全修复：删 opencode-files、open 校验白名单（hostId）、CSP 收敛（删 localhost:* 与 unsafe-eval）、新 channel zod schema 门禁、窗口键改 hostId | 漏洞 case 回归；双参会者编辑器双开 | T0 |
| 2 | 编辑器接真实会话：全代理事件流（归因表路由）+ subscribe-before-create + checkpoint-resync 去重 + 权限桥 + Diff/Todo | 会中改文件编辑器实时可见；审批后工具继续；断流不丢事件 | T0+2–4 周 |
| 3 | ide-* 通用化 + server registry（生命周期矩阵 + adopt-or-kill）+ IDE registry + Settings 真实数据 | 第二个 IDE adapter 只需实现接口 | T0+2–4 周，S1 到货散热 P0 测试 |
| 4 | PtyPanel 终端 + 文件编辑保存 + shiki 按需高亮 | 终端可执行；保存后 agent find 可搜到 | T0+4–8 周 |
| 5 | 掌机 2d1：模式开关驱动布局 + 密度/触控/审批模态 | **700px 窗口**（handheld 档内）会议完整操作无横向滚动 | T0+4–8 周，S2 询价 |
| 6a | overlay（hooks 存活）+ 双屏迁移（状态保留）——纯软件，桌面可验 | 720px 模拟窗 + CX10A 双轨；overlay↔独立窗切换现场保留 | T0+8–12 周 |
| 6b | CI matrix + arm64 runner + 发布自动化 + AppImage + whisper 三平台（资产断言） | 三平台安装包 CI 产出；whisper 缺失即 fail | T0+8–12 周，S2 工程样机 |
| 6c | 语音链路（流式 ASR/播放管线/barge-in）+ Wayland/OSK/AEC 真机实测 + 侧键注入通道——**显式依赖 S1 散热结论** | CX10A 全链路：启动→开会→overlay→返回会议语音不断；形态相关项挂「工程样机复验」标签 | T0+8–12 周，S2 工程样机 |
| 7 | 会话恢复（journal 唯一真相）+ 打包闭环 + 正式发布门（orchestrator v2 H 项：全矩阵手测 + 2h soak + 签名公证，含 mac updater 开启） | 重启 re-attach 只读历史；三平台安装包全链路 | T0+8–12 周 |
| 8 | 陪伴屏：状态模型内核 + 像素会议室 MVP（气泡规范为验收前置）+ 差异化判据落地 + 三类触发入口 | 插外显自动切桌面模式，内置屏陪伴屏；员工状态与规范气泡实时上屏；mascot 聚合提醒 | T0+3–6 月，S3 EVT |

并行性：Phase 5 可与 2–4 并行；6a/6b 可并行；6c 依赖 4（终端 tab）、6b（CI）与真实掌机环境。

## 5. 明确不做（本期，v1.2 修正自相矛盾）

- 不自研编辑器内核、不上 Monaco（shiki fine-grained 按需加载）；不做 gamepad；Hermes/Pi 不做真实集成（接口 + 降级）。
- **编辑器不做会话写操作**（prompt/会话控制归会议 orchestrator）；**用户在编辑器的手动保存与终端属用户主动行为**，走 §2.2 规则 1/3/8 的 IPC 校验与原生框路径（v1.2 修正：旧表述"只读+审批"与 Phase 4「文件编辑保存/终端可执行」矛盾）。
- 编辑器不做多文件 tab；陪伴屏不做走位漫游/互动/养成（MVP 外）。

## 6. 顶层风险（软件侧摘编，v1.2 增补）

| 风险 | 等级 | 缓解 |
|---|---|---|
| opencode server 无鉴权被同机驱动 | 高 | §2.2 规则 4 四件套（loopback + 随机端口 + 全代理 + config 钉死）+ 威胁模型文档 |
| fan-out 串台（A 窗口批准 B 的权限） | 高 | §2.2 规则 7 绑定路由，禁广播 |
| 权限桥 fail-open / always 失明 | 高 | broker 超时 deny + destructive 原生框 + config 钉死 ask + Phase 0 验证 always 后续 |
| 断流丢权限请求/日志 | 高 | checkpoint-resync 去重 + 断流期 pending 上报 |
| PTY 成 shell 等价攻击面 | 高 | §2.2 规则 8（sender 绑定 + destructive 定级 + 限频） |
| 单机交叉打包不可能 | 高 | CI matrix 三 runner |
| Panfrost/Electron GPU 加速不达标（R2） | 高 | CX10A 实测；Mali blob + gbm 短期兜底 |
| Linux 掌机无 OSK / TTS 失声 | 中 | 语音优先 + web 键盘兜底；getVoices 检测降级 + 云端 TTS |
| 云端语音 key/隐私/成本 | 中 | key 只存 main；UI 明示 + 组织级硬开关；常开 mic 按分钟计费成本模型 Phase 6c 估 |
| mac 更新通道缺失 | 中 | 短期版本检查 + 手动下载；签名公证（Phase 7）后开 updater |
| Flatpak 核心功能冲突 | 中 | v1.2 裁决 AppImage 为主，Flatpak 后续评估受限版 |
|  renderer 播放管线工作量 | 中 | §3.2 单独立项，barge-in 取消语义先行定义 |
