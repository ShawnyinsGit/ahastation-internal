# Spike：opencode server 未知项实测（Phase 0）

- 日期：2026-07-21
- 环境：macOS arm64（Darwin 25），node v25.9.0，实验目录 `/tmp/opencode-spike`（未触碰仓库 `electron/`、`src/`）
- 版本：`opencode-ai@1.18.4` / `@opencode-ai/sdk@1.18.4`（npm latest；方案调研时是 1.18.3）
- 纪律：全部 server 进程实验结束已 SIGTERM 并确认无残留（`pgrep -fl opencode` 为空）；未读任何密钥文件

## 结论速览

| # | 项目 | 结论 |
|---|------|------|
| 1 | 二进制分发 | `opencode-ai` + 12 个平台 optionalDeps（`opencode-<platform>-<arch>[变体]`），postinstall 硬链到 `bin/opencode.exe`；打包直接依赖平台包 + asarUnpack |
| 2 | 自写 spawn | **可行**。`--port=0` 首选 4096、被占则随机空闲端口，双实例不撞；banner `opencode server listening on http://…` 在 stdout；无子进程，SIGTERM 干净退出 |
| 3 | 鉴权 | **1.18.x 已有原生 HTTP Basic auth**（`OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`，覆盖 SSE），方案"无鉴权"前提过时；CORS 默认不放行、Host 不校验、Origin 不拦截写 |
| 4 | file API 隔离 | 默认 instance directory 内 confinement 有效（`../`/外部绝对路径 → 500 "Path escapes the location"），**但 `directory` query 参数可任意换根**（`directory=/` 读通 `/etc/passwd`）→ 隔离等于无效，main 侧必须 confinement |
| 5 | SSE 续传 | 事件帧**从不带 SSE `id:` 行**（id 只在 JSON payload 内），`Last-Event-ID` 被服务端忽略、断线事件不补发 → 无断点续传，保留 checkpoint-resync 方案 |
| 6 | PTY | REST 建/删/改 + WS `/pty/{id}/connect`；下行 text/binary 混合帧、上行两种都收；**resize 走 `PUT /pty/{id}` `{size}`（实测 stty 24×80 → 43×132 生效），WS 无控制通道**；连接后有初始缓冲输出 |
| 7 | 权限生命周期 | **未能实测**（无 ANTHROPIC/OPENAI/MOONSHOT/KIMI 环境 key）→ 列入 Phase 2 首周 |

---

## 1. 二进制分发

**命令**：`npm i opencode-ai @opencode-ai/sdk`，检查 `node_modules/opencode-ai/package.json`、`postinstall.mjs`、`opencode-darwin-arm64/`。

**关键输出**：

- `opencode-ai@1.18.4`，`bin: { "opencode": "./bin/opencode.exe" }`，`os: darwin/linux/win32`，`cpu: arm64/x64`
- 12 个 optionalDependencies，全部同版本号 `1.18.4`：

```text
opencode-darwin-arm64            opencode-darwin-x64          opencode-darwin-x64-baseline
opencode-linux-arm64             opencode-linux-arm64-musl
opencode-linux-x64               opencode-linux-x64-baseline  opencode-linux-x64-musl  opencode-linux-x64-baseline-musl
opencode-windows-arm64           opencode-windows-x64         opencode-windows-x64-baseline
```

- `postinstall.mjs`：按平台/AVX2/musl 选平台包，把其 `bin/opencode`（win 为 `opencode.exe`）**硬链（失败则拷贝）**到 `opencode-ai/bin/opencode.exe`，再 `spawnSync(target, ["--version"])` 验证；解析失败时回退 `npm install --prefix <tmp> <平台包>`。
- 平台包自包含：`opencode-darwin-arm64/bin/opencode` = 138,295,010 B Mach-O arm64，与 postinstall 产物 sha256 一致（`9449af91…`）。版本 `1.18.4`（`--version` 实测）。

**对方案的影响**：

- 打包内置**优先直接依赖平台包**（如 `opencode-darwin-arm64`）进 optionalDependencies，绕过 `opencode-ai` 的 postinstall（它依赖安装期 npm 与网络回退，electron-builder 打包场景是负担）；运行时从 `node_modules/opencode-<platform>-<arch>/bin/opencode` 取 binary。
- asarUnpack 模式：`**/node_modules/opencode-*/bin/**`（138MB Mach-O 必须在 asar 外）。若沿用 `opencode-ai` 主包，则 unpack `opencode-ai/bin/opencode.exe` 亦可（产物相同），但平台包路径更直。
- baseline/musl 变体存在 → linux x64 目标需按 AVX2/libc 选包（postinstall 的选择逻辑可照抄：darwin 查 `sysctl hw.optional.avx2_0`，linux 查 `/proc/cpuinfo` avx2 + `ldd` musl）。
- RK3588（linux-arm64）有官方包 `opencode-linux-arm64` → 整机方案不被二进制分发卡死。

## 2. 自写 spawn 可行性

**脚本**：`/tmp/opencode-spike/spawn-test.mjs`——`spawn(BIN, ["serve","--hostname","127.0.0.1","--port=0"])`，stdout 正则取 URL，连起两个实例，SIGTERM 后 `pgrep -P` 递归查子进程。

**关键输出**：

```text
S1_BANNER>>> "Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\nopencode server listening on http://127.0.0.1:4096"
S1_URL http://127.0.0.1:4096   S2_URL http://127.0.0.1:56017   PORTS_DISTINCT true
S1/S2 health 200 {"healthy":true,"version":"1.18.4"}
S1_CHILD_PIDS_BEFORE_KILL []   S1_EXIT null SIGTERM   S1_DESCENDANTS_STILL_ALIVE []
```

另：`serve --help` 实测 `--port` **default: 0**、`--hostname` default `127.0.0.1`、另有 `--print-logs/--log-level/--pure/--mdns/--cors`。

**结论**：

- `--port=0` **不是纯随机**：首选 4096，被占则自动挑空闲端口（第二实例落到 56017）→ 双 OpenCode 参会者同会端口不撞，实测通过。
- banner 在 **stdout**，格式 `opencode server listening on http://<host>:<port>`（单行）；未设密码时**前面多一行 warning** → banner 解析用正则 `/https?:\/\/[^\s]+/` 全文扫，不要取首行/末行。
- 无子进程（serve 不起子进程），SIGTERM 即退、无孤儿 → "进程树 kill" 在 macOS 上实测简单；Windows/linux 待 Phase 1 复验（本次未测）。
- 健康探针：`GET /global/health` → `{"healthy":true,"version":"1.18.4"}`，可作 liveness 与 adopt-or-kill 探测依据。

**对方案的影响**：自写 spawn（估 ~120 行）确认可行，banner 解析 + port=0 + exit 监听全部按原设计成立；注意事项只有"banner 前可能有 warning 行"。

## 3. 鉴权实测

**方法**：server A 无密码、server B/C 设 `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`，curl 打头。

**① SSE 端点 CORS 头**（`GET /event`、`GET /global/event`，带与不带 Origin）：

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Vary: Origin            ← 有 Vary，但无 Access-Control-Allow-Origin
```

默认**不放行任何跨源读**（无 `ACAO`）；`--cors <origin>` flag 存在（默认 `[]`），CORS 是 opt-in。

**② 带浏览器 Origin 写**：

```text
POST /session  Origin: https://evil.example  →  HTTP/1.1 200 OK  {"id":"ses_07c1b5980…",…}   ← 写被执行
OPTIONS /session（preflight）→ 204，有 Access-Control-Allow-Methods，但无 ACAO
```

服务端**不校验 Origin**（写照执行）；浏览器侧因 preflight 响应无 ACAO，非简单请求（JSON POST）会被 CORS 拦，但 `text/plain` 简单请求可"盲写"（CSRF 面残留）。

**③ Host 校验**：`Host: evil.example`、`Host: 192.168.1.1:4096` → 均 `200 {"healthy":true,…}`。**完全不校验 Host** → 不防 DNS rebinding；仅靠绑 127.0.0.1 收敛。

**④ 鉴权能力**（本项最大发现，推翻"无鉴权"前提）：

```text
OPENCODE_SERVER_PASSWORD=secret123 OPENCODE_SERVER_USERNAME=aha：
  无凭证            → 401  www-authenticate: Basic realm="Secure Area"
  错误密码          → 401
  aha:secret123     → 200（/global/health 与 SSE /event 均通）
仅 OPENCODE_SERVER_PASSWORD=pwonly：
  opencode:pwonly   → 200   ← username 默认 "opencode"
  :pwonly / 其他用户 → 401
```

官方文档佐证：[opencode.ai/docs/cli](https://opencode.ai/docs/cli/)——"Set `OPENCODE_SERVER_PASSWORD` to enable HTTP basic auth (username defaults to `opencode`)"，[server 文档](https://open-code.ai/en/docs/server)同。auth 只由**环境变量**提供；`OPENCODE_CONFIG_CONTENT` 存在（二进制 strings 可见）但文档只记载 env var 方式，config 文件不承担 server 鉴权。

**结论与设计影响**：

- 方案 §2.2 规则 4「无鉴权 server 缓解组合」前提**部分过时**：1.18.x 有原生 Basic auth，且覆盖全部端点含 SSE。
- 缓解组合更新为五条：**仅绑 127.0.0.1 + 随机高端口 + 每次启动生成随机 `OPENCODE_SERVER_PASSWORD`（env 注入，main 持有，renderer 永不可见）+ 全代理（main 转发时注入 `Authorization: Basic`）+ 钉死 config**。密码把②的盲写 CSRF 与③的 rebinding 残余风险基本归零（浏览器跨源带不了凭证）；loopback+随机端口仍是必要纵深。
- 注意副作用：SDK `createOpencodeClient` 需配 `headers: { Authorization }`（或 main 代理统一注入）；`opencode serve` 启动 banner 不再打印 warning 即表示密码已生效，可作启动自检。

## 4. file API 隔离强度

**方法**：server cwd=`/tmp/opencode-spike`，造 `root/inside.txt` 与 `outside.txt`，`GET /file/content`、`GET /file` 各路径尝试（server 开 `--print-logs --log-level ERROR` 看内部错误）。

**关键输出**：

```text
path=/private/tmp/opencode-spike/root/inside.txt   → 200 {"type":"text","content":"INSIDE_ROOT"}
path=/private/tmp/opencode-spike/outside.txt       → 200（在 server 根内，预期可读）
path=../../etc/hosts                               → 500  error="Error: Path escapes the location"
path=/etc/hosts                                    → 500  Path escapes the location
path=$HOME/.zshrc                                  → 500  Path escapes the location
directory=/etc&path=hosts                          → 200  ← 读到 /etc/hosts 全文
directory=/&path=etc/passwd                        → 200  ← 读到 /etc/passwd
directory=/&path=etc（/file list）                  → 200  ← 列根目录任意子树
```

**结论**：

- 默认 confinement **真实存在**：相对逃逸与根外绝对路径都被拒（500 + 日志 "Path escapes the location"）。
- **但 `directory` query 参数把 confinement 根换成调用者给的任意绝对路径，无任何校验** → 任意文件读。SDK 类型里 `directory?: string` 挂在 file.list/read/status、session、pty 等大量端点上（`directory` 实际是"选 instance/项目"的参数）。
- 附带发现：`POST /session` body 里的 `directory` 未生效（返回的 session 仍绑 server cwd `/private/tmp/opencode-spike`）——session 的 directory 语义与预期不同，Phase 2 接会话时需再确认多 directory 支持路径。

**对方案的影响**：**server 侧隔离不可依赖，main 侧 path confinement 必须做**——具体落点：main 代理 file/pty/session 类请求时**剥掉或白名单化 `directory` 参数**（只允许等于该 server registry 登记的 cwd），`path` 参数解析后必须落在 cwd 内。§2.2 规则 6 从"未验证"改为"已验证：默认有 confinement 但被 directory 参数绕过"。

## 5. SSE 断线续传

**脚本**：`sse-test.mjs` / `sse-test2.mjs`——连接 `/event`，连接中/断线后制造 session.created 事件，带 `Last-Event-ID` 重连观察补发。

**关键输出**：

```text
连接中实时事件（正常推送）：
  data: {"id":"evt_f83ea0528001…","type":"server.connected","properties":{}}
  data: {"id":"evt_f83ea0536002…","type":"session.created","properties":{…}}
  ← 全程无 SSE "id:" 行（wire 上只有 data: 行；evt_ id 在 JSON 里）
断线期创建 session 后，Last-Event-ID=evt_f83ea0528001 重连 → 只有新的 server.connected，gap 事件不补发
Last-Event-ID=garbage                              → 同上，服务端不报错也不补发
/global/event                                      → data: {"payload":{"id":"evt_…","type":"server.connected",…}}（同事件多包一层 payload）
```

SDK 客户端源码（`gen/core/serverSentEvents.gen.js`）确有"见过 `id:` 行就存、重连带 `Last-Event-ID`"逻辑，但**服务端从不发 `id:` 行** → 该逻辑实际永不触发，属死代码。

**结论**：1.18.4 **无断点续传**——无 `id:` 行、`Last-Event-ID` 被忽略、断线窗口事件丢失。端点差异：`/event` = per-instance（本 server directory），`/global/event` = 全局总线且事件包在 `{"payload": …}` 里。

**对方案的影响**：

- §3.1 G3 的 **checkpoint-resync 带去重方案保留**（不能改断点续传）；重连后必须全量拉 `session.messages/todo/diff` 补缺口。
- SSE 端点选 **per-instance `/event`**：一 `(meetingId, cwd)` 一 server 的架构下 global 流没有收益，反而多跨 directory 泄漏面 + 多一层 payload 解包；与 §2.3 归因表一致。

## 6. PTY 协议

**脚本**：`pty-test.mjs` / `pty-test2.mjs`（node v25.9.0 全局 WebSocket，支持自定义 header）。

**关键输出**：

```text
POST /pty {command:"bash",args:["--norc","-i"],title:"spike-pty"}
  → 200 {"id":"pty_f83eb4d3…","status":"running","pid":74306,"cwd":"/private/tmp/opencode-spike",
         "args":["--norc","-i","-l"]}        ← 服务端自动追加 "-l"（login shell）
WS ws://127.0.0.1:4096/pty/<id>/connect（Authorization header）→ OPEN
  首帧 text 299B：shell banner + 提示符     ← 连接后有初始缓冲输出
  下行帧 text 与 binary(Blob) 混合
上行 text "echo PTY_ROUNDTRIP_$((6*7))\n"   → 收到 "PTY_ROUNDTRIP_42" ✓
上行 binary 帧                              → "BIN_OK_12" ✓（两种都收）
WS 发 {"type":"resize",…}                   → 被当作终端键盘输入（无 WS 控制通道）
PUT /pty/<id> {size:{rows:43,cols:132}}     → stty size 实测 24 80 → 43 132 ✓
PUT /pty/<id> {title:"renamed"}             → 生效
DELETE /pty/<id>                            → 200，进程清理
```

**结论**：

- 协议形态：REST 管理面（`POST/GET/PUT/DELETE /pty[/{id}]`）+ WS 数据面（`/pty/{id}/connect`）。**输入输出即原始终端字节流**，text/binary 帧双向都接受；下行两态混合，xterm.js `write()` 对 string/Uint8Array 都兼容，无需区分。
- **resize 走 REST `PUT /pty/{id}` `{size:{rows,cols}}`**，无 WS 控制消息；renderer 侧 fit addon 尺寸变化 → IPC → main PUT。
- 连接即得初始缓冲（含提示符）→ 晚连接的 UI 不会黑屏。
- Basic auth 下 WS 握手也要带 `Authorization`（node 全局 WebSocket 用 `{headers}` 可带；浏览器 WebSocket **不能自定义 header** → main 做 WS 代理是硬需求，与 §2.1 设计一致）。
- PTY 创建可加 `env`，`cwd` 默认 server 项目目录；`directory` query 参数同样存在于 pty 端点（同 §4 风险，main 代理时剥除）。

**对方案的影响**：§3.1 G4 设计（xterm + main WS 代理）成立；新增两条落地细节——resize 走 REST PUT 而非 WS 控制帧；main 代理 WS 时注入 Authorization（浏览器端无法带 header，再次印证"renderer 永不持有凭证"）。

## 7. 权限生命周期（条件项，未实测）

`env | grep -oE '^(ANTHROPIC|OPENAI|MOONSHOT|KIMI)[A-Z_]*'` → **空**（无任何可用 provider key 环境变量；按纪律未读取 `~/.local/share/opencode` 等任何密钥存储）。

**结论**：未能实测，列入 **Phase 2 首周**。待验清单（有 key 后执行）：

1. config `permission=ask` 下发一个触发工具调用的 prompt，观察 `permission.updated` 事件时序（vs subscribe-before-create）。
2. 答 `once` 后同类请求是否再发 `permission.updated`（预期：发）。
3. 答 `always` 后同类请求是否还发 `permission.updated`（若不发，PermissionBroker 对该类工具永久失明，需设计补偿）。
4. server 端 permission 请求有无自身超时（与 broker 120s 超时对齐）。
5. SDK 已确认答复端点存在：`POST /session/{id}/permissions/{permissionID}`。

---

## 附：实验产物

- 全部脚本在 `/tmp/opencode-spike/`（`spawn-test.mjs`、`auth-test.sh`、`sse-test.mjs`、`sse-test2.mjs`、`pty-test.mjs`、`pty-test2.mjs`），为一次性 spike 产物，不入库。
- 进程卫生：每次实验后 `pgrep -fl opencode` 确认为空。
