# S1 Bring-up 检查表：CX10A / Firefly ROC-RK3588S-PC 验证机

> 版本 v1.1　日期 2026-07-22　配套：`docs/plan-ahastation-rk3588-overall.md`（v1.3）§6（下称「方案」）
> v1.1 变更：新增 §9「定案参数验收」——同步方案 v1.2/v1.3 定案（前后双摄、10000mAh + 反向 PD 18W 起谈、WiFi 6 红线、eSIM SE 硬件、火山引擎云端语音）。
> 适用范围：S1 阶段（辰想 CX10A + Firefly ROC-RK3588S-PC）。
> **执行顺序强制：§4 散热/性能压测（P0）在 CX10A 到货第一周完成，先于一切功能适配；其结论必须先于 S2 ODM 谈判。**
> 每项含：命令/步骤 + 通过标准 + 结果记录栏位。执行时在「结果」栏填写实测值与日期。

---

## 1. 系统点亮

### 1.1 镜像烧录

- **步骤**：
  - CX10A：向卖家索取 Ubuntu 镜像 + 刷机包（同时确认官方镜像还是厂商自适配——方案 §3.2 待验证项）；用卖家工具或 `rkdeveloptool` 线刷。
  - Firefly：官网下载 ROC-RK3588S-PC Ubuntu/Debian 镜像，按 wiki 用 `rkdeveloptool db/rkXX` + `wlx` 烧录，或 SD 卡镜像 `dd` 写入：
    ```bash
    sudo dd if=ubuntu-22.04-rk3588s.img of=/dev/sdX bs=4M status=progress conv=fsync
    ```
  - 进 maskrom：按住 recovery 键上电，确认 `rkdeveloptool ld` 能列出设备。
- **通过标准**：两板均能从零烧录到开机进桌面/SSH 可用；maskrom 模式可复现进入。
- **结果**：CX10A 镜像来源（官方/自适配）：______；烧录耗时：______；日期：______

### 1.2 SD 卡兜底启动（方案 §3.6）

- **步骤**：SD 卡烧可启动镜像 → 插卡上电，确认 BootROM 优先从 SD 启动；拔卡确认回退 eMMC/UFS 启动。
  ```bash
  # 启动后确认根分区来源
  findmnt / ; lsblk
  ```
- **通过标准**：SD 插入即优先启动、拔出回退，刷砖后可用 SD 卡自救。
- **结果**：______

### 1.3 串口控制台

- **步骤**：UART2 调试口（Firefly 板载排针；CX10A 需拆机或走 USB 串口，待确认）接 USB-TTL 1.5Mbps 8N1：
  ```bash
  sudo screen /dev/ttyUSB0 1500000
  ```
- **通过标准**：U-Boot 与内核日志可见，suspend 挂死时仍有日志输出（§2 排查依赖）。
- **结果**：波特率/引脚定义记录：______

---

## 2. suspend-resume（第一验收项，方案 §2.4）

### 2.1 suspend 循环可靠性

- **步骤**：
  ```bash
  # 安装 rtcwake（util-linux 自带），100 次循环，每次挂起 30s
  for i in $(seq 1 100); do
    echo "=== cycle $i ===" | tee -a suspend.log
    sudo rtcwake -m mem -s 30 | tee -a suspend.log
    sleep 5
  done
  grep -ci "fail\|error\|Call trace" suspend.log
  ```
  先跑 100 次；通过后加跑到 1000 次（方案验收标准）。
- **通过标准**：1000 次循环零失败（无唤醒失败、无内核 oops、唤醒后网络/显示正常）。
- **结果**：循环次数：______；失败次数：______；失败现象/日志：______

### 2.2 待机电流 / 掉电测量

- **步骤**（无库仑计时的替代方法 + 目标方法）：
  1. 软件法（粗测）：`cat /sys/class/power_supply/*/charge_now` 或 `capacity`，suspend 前记录 → 8 小时后唤醒记录差值。
  2. 硬件法（准）：拆电池串恒流源/功耗计（如 Otii/Power Profiler）测 suspend 电流。
  ```bash
  echo mem | sudo tee /sys/power/state   # 或由桌面休眠按钮触发
  ```
- **通过标准**：suspend 待机电流 ≤5mA 级（对应一晚 8h 掉电 ≤5%，方案 §2.4）。CX10A 实测值作为基线标定（方案允许实测后修正目标）。
- **结果**：CX10A suspend 电流：______mA；8h 掉电：______%；Firefly 板：______mA

### 2.3 唤醒延迟

- **步骤**：suspend 状态下按电源键，秒表/高速摄像测「按键 → 屏幕亮」；再测「屏幕亮 → ping 通网关」：
  ```bash
  # 唤醒后立刻计时网络恢复
  time until ping -c1 -W1 192.168.1.1; do sleep 0.2; done
  ```
- **通过标准**：按键→亮屏 ≤2s；按键→网络可用 ≤5s。
- **结果**：亮屏：______s；网络可用：______s

---

## 3. GPU / Panfrost 实测（方案 §3.3、风险 R2）

### 3.1 驱动栈确认

- **步骤**：
  ```bash
  glxinfo -B | grep -E "OpenGL renderer|OpenGL version"   # 期望 Mali-G610 / Panfrost
  vulkaninfo --summary | grep deviceName                  # PanVK（若内核/Mesa 够新）
  ls /dev/dri/                                            # renderD128 存在
  ```
  若 renderer 为 `llvmpipe` 即为软渲染（撞 R2）。
- **通过标准**：OpenGL renderer = Mali-G610（Panfrost）；不行则记录 BSP Mali blob + gbm 路径为 B 方案。
- **结果**：renderer：______；Mesa 版本：______；内核：______

### 3.2 Electron ozone wayland

- **步骤**：
  ```bash
  # AhaMeet 或最小 Electron demo 以 Wayland 原生启动
  ELECTRON_OZONE_PLATFORM_HINT=wayland ./aha-meet --ozone-platform=wayland \
      --enable-features=UseOzonePlatform --enable-gpu-rasterization
  # 检查 GPU 进程状态：浏览器内打开 chrome://gpu
  ```
- **通过标准**：chrome://gpu 显示 Hardware accelerated；窗口合成/滚动流畅；分数缩放与触屏手势可用（沿用 Phase2 文档 §3.5-5 实测矩阵）。
- **结果**：GPU 加速（是/否）：______；chrome://gpu 截图存档路径：______

### 3.3 帧率观测

- **步骤**：
  ```bash
  # 合成器帧率：Weston 用 weston-debug；或 glmark2-es2-wayland 跑分
  glmark2-es2-wayland --fullscreen
  ```
- **通过标准**：UI 场景稳定 60fps（1080p）；glmark2 成绩记录作基线（相对值比绝对值重要——对比后续 ODM 样机）。
- **结果**：glmark2 总分：______；UI 实测帧率：______

---

## 4. 满栈 30 分钟散热压测（P0，方案 §6 / R4）

> **第一周固定执行，先于功能适配。结论必须先于 S2 ODM 谈判。**

### 4.1 负载构造

- **步骤**：满软件栈同时运行 30 分钟：
  1. AhaMeet Electron 会议 UI（开 1 个会议）；
  2. 3 个 agent 会话（OpenCode/Claude Code/Codex 各 1，循环执行真实任务，如让 agent 持续重构一个测试仓库）；
  3. 云端 ASR 流式持续输入（播放预录语音进麦克风，或会议内持续讲话）；
  4. 屏幕最高亮度：
     ```bash
     echo $(cat /sys/class/backlight/*/max_brightness) | sudo tee /sys/class/backlight/*/brightness
     ```
  5. CPU 补载（agent 空闲时保底）：`stress-ng --cpu 8 --timeout 30m &`

### 4.2 温度/频率采集

- **步骤**：压测全程后台记录（1Hz）：
  ```bash
  #!/bin/bash
  # thermal-log.sh —— 每 1s 记录 SoC 温度与大小核频率
  while true; do
    ts=$(date +%H:%M:%S)
    t=$(cat /sys/class/thermal/thermal_zone0/temp)          # SoC 温度，毫摄氏度
    big=$(cat /sys/devices/system/cpu/cpufreq/policy6/scaling_cur_freq)  # A76 大核簇（policy 编号以实际为准，用 cpupower 确认）
    lit=$(cat /sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq)  # A55 小核簇
    echo "$ts,$t,$big,$lit" | tee -a thermal.csv
    sleep 1
  done
  ```
  机身表面温度：红外测温枪每 5 分钟测背板中心 + 握持区，手工记录（或固定热电偶）。
- **通过标准（红线）**：
  - 大核频率 **≥1.8GHz 全程**（允许瞬时下探，但不得低于 1.8GHz 持续 5 分钟）；
  - 机身表面 **≤45°C**。
- **撞线处置**：触发 B 计划——RK3588S / 均热板加厚 / 风扇（方案 §6），并回填方案 R4。
- **结果**：30min 大核最低频率：______kHz；<1.8GHz 持续时长：______；SoC 峰值温度：______°C；表面峰值温度：______°C；结论（过/撞线）：______

---

## 5. 音频链路（PipeWire，方案 §3.4）

- **步骤**：
  ```bash
  pactl info | grep "Server Name"        # 期望 PulseAudio (on PipeWire ...)
  pw-cli list-objects | grep -i node     # 确认 mic/扬声器节点
  # 录音 5s 回放验证 mic
  pw-record --target <mic-node-id> test.wav --rate 16000 --channels 1 & sleep 5; kill %1
  pw-play test.wav
  # 会议链路：AhaMeet 内发起会议，确认云端 ASR 有输入电平、TTS/提示音可闻
  ```
- **通过标准**：mic 录音清晰（双麦阵列两路可辨）、扬声器回放正常、会议内 ASR/TTS 全链路通；suspend/resume 后音频自动恢复（结合 §2.1 循环测试抽查）。
- **结果**：______

---

## 6. 5G 数据链路（RM520N 转接验证，方案 §3.5）

### 6.1 模组识别与拨号

- **步骤**（Firefly 板 + M.2 转接板 + RM520N + 数据 SIM；CX10A 若有 5G 选配同测）：
  ```bash
  mmcli -L                              # 列出 modem
  mmcli -m 0                            # 看状态：期望 enabled；注意 QMI 还是 MBIM（方案待验证项）
  sudo mmcli -m 0 --enable
  sudo mmcli -m 0 --simple-connect="apn=<运营商APN>"
  mmcli -m 0 --bearer 0                 # 确认拿到 IP
  ping -I wwan0 -c3 8.8.8.8
  ```
- **通过标准**：模组被 ModemManager 识别、拨号成功、wwan 接口通网；记录 QMI/MBIM 模式回填方案 §3.5。
- **结果**：接口模式（QMI/MBIM）：______；下行速率（speedtest）：______Mbps

### 6.2 suspend 后重连

- **步骤**：拨号成功后 suspend 30s → 唤醒，计时 wwan 恢复可用：
  ```bash
  sudo rtcwake -m mem -s 30
  time until ping -c1 -W1 -I wwan0 8.8.8.8; do sleep 0.5; done
  ```
- **通过标准**：唤醒后 ≤10s 恢复数据连接（方案 §2.4 验收表）。
- **结果**：恢复耗时：______s

### 6.3 5G/WiFi 自动切换与弱网降级

- **步骤**：NetworkManager 配双连接（WiFi + wwan），设 route metric；拔 WiFi 观察流量切 5G 的耗时；反向插回。弱网用 `tc qdisc` 人为限速/加延迟，观察云端 ASR 降级表现（方案 §3.5 策略）：
  ```bash
  sudo tc qdisc add dev wwan0 root netem delay 500ms rate 200kbit
  sudo tc qdisc del dev wwan0 root
  ```
- **通过标准**：切换期间会议会话不致命中断（ASR 流断线重连成功）；弱网下 UI 出现降级提示。
- **结果**：WiFi→5G 切换中断时长：______s；弱网降级表现：______

---

## 7. Agent CLI aarch64 安装冒烟（方案 §4.2，引 tools-support 报告）

| 工具 | 安装/验证命令 | 通过标准 | 结果 |
|---|---|---|---|
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` 或下载 `opencode-linux-arm64.tar.gz`；`opencode --version` | 打印版本号（glibc 版直接可跑） | ______ |
| Claude Code | `npm i -g @anthropic-ai/claude-code && claude --version` | 自动选 `claude-code-linux-arm64` 二进制，版本号正常 | ______ |
| Codex CLI | `npm i -g @openai/codex`（或 musl tarball 解压）；`codex --version` | musl 静态二进制在 Ubuntu glibc 直接运行 | ______ |
| Grok Build（可选） | `curl -fsSL https://x.ai/cli/install.sh \| bash`；`grok --version` | install.sh 识别 aarch64 拉取成功 | ______ |
| Hermes（可选） | `pip install hermes-agent`（py3-none-any wheel） | import 成功 | ______ |

冒烟最小任务：各 CLI 对同一测试仓库执行「读文件 + 改一行 + git diff 确认」，通过即记 ✅。

---

## 8. whisper.cpp NEON 编译与实时率（方案 §4.3，离线兜底）

- **步骤**：
  ```bash
  sudo apt install build-essential cmake libsdl2-dev
  git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
  cmake -B build -DGGML_NATIVE=ON        # NEON 由 ARM 原生路径启用
  cmake --build build -j8 --config Release
  # 下载 small q5_1 模型
  bash ./models/download-ggml-model.sh small-q5_1
  # 实时率测量：对一段 60s 预录中文语音计时转写
  time ./build/bin/whisper-cli -m models/ggml-small-q5_1.bin -l zh -f sample60s.wav
  ```
- **通过标准**：实时率 RTF ≥1×（60s 音频转写耗时 ≤60s）。记录数值作为方案 §4.3 基线；不达标则离线兜底降级为 tiny/base 模型并回填方案。
- **结果**：模型：______；60s 音频转写耗时：______s；RTF：______

---

## 9. 定案参数验收（方案 v1.2/v1.3 同步项）

> 以下各项对应方案已关闭的 Q 项，验证「定案参数在验证机/工程样机上真实成立」。CX10A/Firefly 为开发验证机，部分项（双摄、eSIM）硬件不具备时记 N/A 并注明「待 S2 工程样机验证」。

### 9.1 WiFi 6 红线确认（Q10，不可妥协：不退 WiFi 5 / AP6256）

- **步骤**：
  ```bash
  # 模组型号
  lspci | grep -i net ; lsusb | grep -i -E "wireless|802"
  # 协商能力：是否支持 HE（WiFi 6 / 802.11ax）
  iw dev wlan0 info ; iw phy | grep -i -A2 "HE " | head -20
  # 关联到 WiFi 6 AP 后看链路
  iw dev wlan0 link | grep -i -E "signal|tx bitrate"
  ```
- **通过标准**：模组为 WiFi 6（802.11ax / HE 能力存在），**不是** AP6256 等 WiFi 5（ac-only）模组；关联 WiFi 6 AP 协商出 HE 速率。
- **结果**：模组型号：______；HE 能力（有/无）：______

### 9.2 前后双摄（Q1，S2 工程样机项）

- **步骤**：
  ```bash
  v4l2-ctl --list-devices
  # 前摄/后摄各抓一帧
  v4l2-ctl -d /dev/video0 --set-fmt-video=width=1280,height=720,pixelformat=MJPG --stream-mmap --stream-count=1 --stream-to=front.jpg
  v4l2-ctl -d /dev/video1 --set-fmt-video=width=1280,height=720,pixelformat=MJPG --stream-mmap --stream-count=1 --stream-to=back.jpg
  ```
  另验证：摄像头工作时**物理指示灯点亮**、系统权限总开关关闭后设备节点不可访问（方案 §3.7-5）。
- **通过标准**：前摄（视频通话/人脸登录）、后摄（扫码/AI 视觉）均可抓帧成像；指示灯硬件联动、总开关生效。CX10A/Firefly 无此硬件 → 记 N/A，S2 工程样机必测。
- **结果**：______

### 9.3 eSIM SE 硬件存在性（Q4 v1.3，S2 工程样机项）

- **步骤**：确认主板上 eSIM SE 芯片已贴片（原理图位号 + 目检/X-ray）；软件侧：
  ```bash
  # LPA 栈（lpac 或 ModemManager 插件）能否枚举到 eSE
  lpac info 2>/dev/null || echo "LPA 栈未部署"
  ```
- **通过标准**：SE 芯片在位、LPA/MEP 协议栈可通信（商用激活不在本项——v1 以实体卡槽为主通道，方案 §10 Q4）。验证机记 N/A，S2 工程样机必测。
- **结果**：______

### 9.4 电池与反向 PD（Q2）

- **步骤**：
  ```bash
  # 电池容量确认
  cat /sys/class/power_supply/*/charge_full_design 2>/dev/null
  upower -i $(upower -e | grep battery) | grep -E "energy-full-design|capacity"
  # 反向 PD（充电宝模式）：C 口接 PD 诱骗器/负载仪，触发 source 角色
  # 量测 9V/12V 档位可持续输出电流
  ```
- **通过标准**：设计容量 10000mAh（工程样机）；反向 PD 输出 **≥18W 稳定 30 分钟**（记录是否达 22.5W 目标档）；source/sink 角色切换不导致系统掉电或重启。CX10A 无反向 PD → 记 N/A 并注明「公模限制，S2 验证」。
- **结果**：容量：______mAh；反向输出稳定功率：______W

### 9.5 云端 ASR/TTS（火山引擎，Q5）连通性冒烟

- **步骤**：用火山引擎控制台签发的测试凭证，跑 provider 抽象层的最小冒烟：
  1. 流式 ASR：推送 §8 同款 60s 预录中文语音，记录首字延迟与转写完成率；
  2. 流式 TTS：合成一段 20 字中文，记录首包延迟并回放确认可懂；
  3. BYOK 路径：填用户自有 key 重复 1/2 各一次；
  4. 弱网重复一次（§6.3 的 `tc netem` 配置），确认降级提示出现。
- **通过标准**：ASR 首字延迟 <500ms（5G/WiFi 正常链路）、TTS 首包 <1s（方案 §4.4 指标）；BYOK 可用；弱网降级不静默失败。
- **结果**：ASR 首字延迟：______ms；TTS 首包：______ms；BYOK（过/不过）：______

---

## 附：执行记录总表

| # | 项目 | 通过标准摘要 | 结果 | 日期 | 执行人 |
|---|---|---|---|---|---|
| 1.1 | 镜像烧录 | 两板从零烧录可开机 | | | |
| 1.2 | SD 兜底启动 | 插卡优先/拔卡回退 | | | |
| 1.3 | 串口控制台 | 日志可见 | | | |
| 2.1 | suspend 循环 | 1000 次零失败 | | | |
| 2.2 | 待机电流 | ≤5mA 级（基线标定） | | | |
| 2.3 | 唤醒延迟 | 亮屏 ≤2s / 网络 ≤5s | | | |
| 3.1 | Panfrost 确认 | renderer = Mali-G610 | | | |
| 3.2 | Electron wayland | 硬件加速开启 | | | |
| 3.3 | 帧率 | UI 60fps 基线 | | | |
| **4** | **散热压测（P0）** | **大核 ≥1.8GHz 全程；表面 ≤45°C** | | | |
| 5 | 音频链路 | 录放 + 会议全链路通 | | | |
| 6.1 | 5G 拨号 | mmcli 拨号通网 | | | |
| 6.2 | 5G suspend 重连 | ≤10s | | | |
| 6.3 | 切换/弱网 | 会话不致命中断 | | | |
| 7 | agent CLI 冒烟 | 各 CLI 最小任务通过 | | | |
| 8 | whisper 实时率 | RTF ≥1× | | | |
| 9.1 | WiFi 6 红线 | 模组为 WiFi 6（HE），非 WiFi 5 | | | |
| 9.2 | 前后双摄 | 双摄抓帧 + 指示灯/总开关（S2 项，可 N/A） | | | |
| 9.3 | eSIM SE | 芯片在位 + LPA 可通信（S2 项，可 N/A） | | | |
| 9.4 | 电池/反向 PD | 10000mAh；反向 ≥18W 稳定 30min（S2 项，可 N/A） | | | |
| 9.5 | 云端语音（火山） | ASR <500ms / TTS <1s / BYOK 可用 | | | |
