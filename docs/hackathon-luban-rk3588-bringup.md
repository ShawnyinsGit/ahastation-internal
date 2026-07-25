# 黑客松作战包：LubanCat RK3588 点亮 + 冒烟验证 + 分工

> **历史归档，禁止作为当前部署手册执行。** OpenCode ARM64、静态
> whisper.cpp、四 Worker 契约和 Debian 11 发布门现已实现；当前唯一
> 权威手册是 [`RK3588_DEPLOYMENT.md`](./RK3588_DEPLOYMENT.md)。尤其不要
> 使用本文旧版的 `--no-sandbox` 或“仅 Kimi”降级步骤。

> 版本 v1　日期 2026-07-21　目标：**今晚在野火 LubanCat RK3588 真机上跑通 AhaMeet 会议**
> 团队 4 人。总原则：**阶梯验收，逐级通过即停，不恋战**。

---

## 〇、今晚的现实约束（先看这个）

1. **opencode 后端在 linux-arm64 上今晚不可用**：`package.json` 的 optionalDeps 目前只有 `opencode-darwin-arm64`，linux-arm64 的二进制解析还留着 TODO。**不要在现场折腾它**。
2. **今晚的开会路径 = 原生 Kimi 后端**（app 一等公民适配器，ACP 传输，ARM64 无平台障碍）+ 你的 Kimi API key。这是零额外工作的路径。
3. **语音（whisper）是冲击目标不是必达**：ARM64 无官方预编译，需现场 cmake 自编译（15–30 分钟编译期）。今晚先打字，语音编过就用、编不过就跳。
4. macOS 侧今天就能全功能跑（`npm run dev`），黑客松演示素材可以先在 Mac 上录一份兜底。

---

## 一、30 分钟点亮路径（LubanCat RK3588）

| # | 步骤 | 时间 | 要点 |
|---|---|---|---|
| 1 | 下载镜像 | 5' | 野火资料站下 LubanCat RK3588 的 **Ubuntu 桌面版**镜像（不要 server 版——Electron 需要显示环境；野火通常提供百度网盘链接，提前下好） |
| 2 | 烧录 SD 卡 | 10' | Balena Etcher → microSD（≥32GB，好卡）。**用 SD 启动**：BootROM 默认 SD 优先，不动 eMMC，砖不了 |
| 3 | 首启 | 5' | 插卡上电，接 HDMI + 键鼠；默认账户以镜像说明为准（野火常见 `cat` / `temppwd`）；起不来就接串口（115200 8N1）看日志 |
| 4 | 网络 | 5' | **插网线最稳**；WiFi 用 `nmtui` 连 |
| 5 | SSH + 记录 IP | 5' | `sudo systemctl enable --now ssh`（没有就 `apt install openssh-server`）；`ip a` 记 IP，后续全在笔记本上 SSH 操作 |

点亮即完成（屏幕进桌面 + 网络通），进入环境阶段。

## 二、环境与构建（60–90 分钟，可与点亮并行）

```bash
# 1. 换国内源（清华/阿里），然后
sudo apt update && sudo apt install -y git curl build-essential cmake pkg-config python3

# 2. Node 22 arm64 官方 tarball
curl -fsSL https://nodejs.org/dist/v22.17.0/node-v22.17.0-linux-arm64.tar.xz | sudo tar -xJ -C /usr/local --strip-components=1
node --version  # 验证

# 3. 克隆私有仓（先在建好 GitHub PAT: Settings→Developer settings→Tokens, 勾 repo 权限）
git clone https://<PAT>@github.com/ShawnyinsGit/AhaStation.git && cd AhaStation

# 4. npm ci（Electron 走国内镜像，否则 110MB 下载卡死）
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm ci

# 5. 构建
npm run build
```

关键坑：
- Electron 沙箱在部分 BSP 内核上起不来 → 启动加 `--no-sandbox`。
- GPU：BSP 内核 Mali blob 与 Electron 不对付时 → `--disable-gpu` 或 `--use-gl=swiftshader`（软渲染，慢但能演示）。
- 桌面会话里跑：`npm run dev`（vite + electron 一起起）；若 vite 起不来，`npm run build && npx electron . --no-sandbox`。
- eMMC/SD 随机读写慢，`npm ci` 耐心等；别中途 Ctrl+C。

## 三、冒烟验证阶梯（S0–S5，逐级通过即停）

| 级 | 内容 | 通过标准 | 失败兜底 |
|---|---|---|---|
| **S0** | 点亮 | 桌面 + 网络 + SSH 通 | 串口看日志；换 SD 卡重烧 |
| **S1** | 应用起 | `npm run dev` 出会议 UI（flags 见上） | 换 `--disable-gpu`；再不行在 Mac 上演示、板子跑后端对比 |
| **S2** | 文本会议 | 设置 → 后端管理 → Kimi tab 配 key → 开会 → 邀请 Kimi 员工 → 发文字 → 有回复 | key 拼写/额度；网络出口；降级：`AHAMEET_E2E_API_KEY=... AHAMEET_E2E_PROVIDER=kimi node scripts/e2e-opencode-smoke.mjs` 在 Mac 上先验证 key 本身可用（今晚前在 Mac 跑通这步最稳） |
| **S3** | 员工编辑器 | 磁贴「打开编辑器」→ 文件树展开、Diff/Todo/活动面板显示 | 面板空=事件流问题，查 devtools console |
| **S4** | 语音（冲击） | whisper 现场编译过（`scripts/fetch-whisper.mjs` 的 arm64 自编译路径）→ mic 说话出转写 | 不过就跳过，演示打字；**绝不超过 40 分钟** |
| **S5** | 双员工 | 有第二把 key 时 Kimi+Claude 同会 | 单员工也够演示 |

**今晚达标线 = S3；冲击线 = S4。**

## 四、4 人分工

| 人 | 职责 | 具体 |
|---|---|---|
| **A 硬件点亮** | S0 | 镜像下载/烧录/首启/网络/SSH/串口调试；管板子电源与散热（连续满载注意温度） |
| **B 系统环境** | 第二节全部 | 换源/Node/依赖/PAT clone/npm ci/Electron 镜像；目标 A 点亮后 60 分钟内交付可构建环境 |
| **C 应用调试** | S1–S3 | 构建、Electron 启动 flags、Kimi key 配置、会议与编辑器排障；S2 不过时的降级决策人 |
| **D 演示与记录** | 贯穿 | demo 剧本（3 分钟版：开会→邀请员工→对话→打开编辑器→权限审批原生框）；验收勾选（本文档第三节）；录屏/日志收集；whisper 编译尝试（S4）；Mac 兜底素材录制 |

时间盒：点亮 30' + 环境 90' + 冒烟 30' ≈ **2.5 小时到 S3**。A/B 并行，C 在环境好之前先用 Mac 走通 S2 流程背熟路径，D 全程记录。

## 五、Key 与仓库纪律（重要）

1. **Kimi key 只进两处**：app 设置页（safeStorage 加密存储）或 smoke 脚本的 env 变量。**不写进任何文件、不进 commit、不发群聊截图**。
2. key 已在本项目的 AI 会话记录中出现过——**黑客松结束后建议去 Moonshot 后台轮换一把**。
3. PAT 同理：用完吊销或设短期；板上 `git clone` 后 `git config --unset credential.helper` 或用完即删。
4. 私有仓内容（规划/BOM/ODM 文档）**不投屏展示**——demo 时只展示应用界面。

## 六、Mac 侧即时验证（今晚出发前 10 分钟）

```bash
cd /Users/heartline/Documents/Claude/AhaStation
export AHAMEET_E2E_API_KEY=<你的kimi key> AHAMEET_E2E_PROVIDER=kimi
npm run build:electron && node scripts/e2e-opencode-smoke.mjs   # 无 UI 是无头设计，看 PASS/FAIL 行
npm run dev   # 要看界面走这个
```

smoke 脚本支持 kimi provider（**Kimi Code** OpenAI 兼容端点 `https://api.kimi.com/coding/v1`，模型 `k3`，可用 `AHAMEET_E2E_MODEL` 覆盖）。注意：**smoke 是无头脚本，不弹任何窗口**，UI 验证用 `npm run dev`。
