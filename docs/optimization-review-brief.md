# NovaRec v1.1.0 优化评审任务书（交给三个独立子代理）

> 用途：用户要求「对体积和性能做极致优化，不砍任何功能；当 Lead 认为无法再优化时，把理由交给三个子代理，
> 让他们寻找反对理由与优化路线，只有三个子代理都认同时才能停止优化」。
> 本文档是评审输入，不是结论。请按文末规则输出。

## 一、产品与硬约束

- 产品：NovaRec，Windows 10/11 x64 桌面录屏软件，Electron 45.2.1（Chromium 45 系 / Node 内置），版本 v1.1.0。
- 功能（**一个都不能砍**）：
  1. 全屏录屏（多显示器可选）
  2. 区域录屏（可视化选区，DIP 坐标，按物理像素裁剪）
  3. 窗口录屏（选择具体窗口）
  4. 系统声音（Windows loopback，可开关）+ 麦克风（可选，可混音）
  5. 暂停/继续、倒计时、快捷键 F9 停止 / F10 暂停、托盘
  6. 素材库（列表、封面、打开、删除、定位文件）
  7. 设置（输出目录、格式 MP4/WebM、帧率 30/60、画质 low/medium/high/ultra、性能模式 auto/on/off）
  8. 自动更新（GitHub Release 直连 + 镜像降级 + 仓库 version.json 回退）
  9. 中文 UI、离线可用（无 CDN 依赖）
- 技术约束：
  - 不引入新的运行时依赖（node_modules 保持只能在打包时被裁掉，不能进最终分发）
  - 不引入联网/云端组件（除更新检查）
  - 不降低录制质量档位能力（60fps 选项必须保留，即使低端机达不到）
  - 更新器必须保持「检查→提示→用户确认→下载→安装」流程
- 上游仓库：https://github.com/UesugiEri-1/NovaRec （目前无 Release；无 version.json；本机 gh 未登录、仓库无 remote）

## 二、当前体积事实（实测）

构建命令：`node scripts/package.mjs --out=artifacts/dist-v5 --zip`

- 便携目录 `artifacts/dist-v5/NovaRec-win32-x64`：300,255,588 字节（286.3 MiB），19 个文件
- 便携 zip：`artifacts/NovaRec-1.1.0-win32-x64.zip` 137,141,025 字节（130.8 MiB）
- 构成（字节）：
  - NovaRec.exe 249,862,144（238.3 MiB，Electron 官方 x64 二进制）
  - resources.pak 13,371,551（12.75 MiB）
  - icudtl.dat 10,824,576（10.3 MiB）
  - LICENSES.chromium.html 5,705,935（5.4 MiB）
  - vk_swiftshader.dll 5,453,312（5.2 MiB）+ vulkan-1.dll 957,440
  - d3dcompiler_47.dll 4,753,864（4.5 MiB）
  - ffmpeg.dll 3,097,600（3.0 MiB）
  - resources/app.asar 1,986,793（应用代码+图标）
  - locales/{zh-CN,en-US}.pak 共约 1.2 MiB
  - chrome_200_percent.pak 927,778 / v8_context_snapshot.bin 753,112 / chrome_100_percent.pak 568,439 /
    electron_wer.dll 425,472 / snapshot_blob.bin 374,096 / 使用说明.md 26,802 / LICENSE 1,096 / version 6
- 参照：优化前 v1.0 构建 418.3 MiB（86 文件）。已累计 -132 MiB（-32%）。

## 三、已完成的体积优化（均有产物/脚本证据）

| # | 优化 | 收益 | 位置 |
|---|---|---|---|
| 1 | 移除内置 ffmpeg.exe（61.5MB），MP4/WebM 收尾改为纯 JS 重封装 | -61.5 MiB | `src/main/mp4remux.js` `webmfix.js` `mediafix.js`；`package.json` 删 dependencies |
| 2 | locales 只留 zh-CN/en-US（删 53 个 pak） | -47.7 MiB | `scripts/package.mjs` LOCALES_KEEP |
| 3 | 删除 dxcompiler.dll（WebGPU/DXIL 编译器，应用不用 WebGPU） | -24.6 MiB | `scripts/package.mjs` RUNTIME_PRUNE |
| 4 | asar 打包（不再 unpacked node_modules） | -0.3 MiB + 文件数 86→19 | `scripts/package.mjs` asar:true |
| 5 | NSIS compression: "maximum"（LZMA） | 安装包从 ~180MB 级下降 | `scripts/make-installer.mjs` |
| 6 | 打包时复制中文使用说明、生成 zip | — | `scripts/package.mjs` |

## 四、当前性能事实（实测，机器：Ryzen 3 3300U 4核 / Vega 6 / 13.9GB / Win10 / 1920x1080@125%）

测量脚本 `scripts/perfbench.mjs`（Electron 内直接驱动 Recorder，10 秒录制，倒计时 3 秒，8 用例）；原始数据 `artifacts/perfbench/result-v4.json`、`docs/perf-baseline.md`。

| 用例 | 起录 startMs | 倒计时后延迟 | 实测帧率 | 掉帧 | 单核 CPU 均值 | GPU 进程 CPU | 渲染器 CPU | 内存峰值 |
|---|---|---|---|---|---|---|---|---|
| 全屏 mp4 high 1080p30 | 3138 | 7ms | 28.83fps | 5.0% | 28.3% | 14.2% | 7.6% | 736MB |
| 全屏 webm(VP9) 1080p30 | 3153 | 15ms | 28.6fps | 4.7% | **56.3%** | 4.6% | **45.2%** | 914MB |
| 全屏 mp4 high 1080p60 | 3082 | 5ms | 36.1fps | **40.5%** | 37.7% | 18.0% | 9.7% | 781MB |
| 全屏 mp4 low 1080p30 | 3141 | 10ms | 28.8fps | 4.3% | 28.7% | 14.1% | 7.5% | 752MB |
| 区域 mp4 high（1600x900 物理） | 3088 | 13ms | 28.9fps | 4.3% | 32.1% | 16.7% | 7.7% | 775MB |
| 窗口 mp4 high（1004x754） | 3137 | 8ms | 30.0fps | **0%** | 22.2% | 13.0% | 5.5% | 752MB |
| 全屏 mp4 性能模式 auto（720p） | 3085 | 9ms | 28.9fps | 4.0% | 26.0% | 11.7% | 5.8% | 758MB |
| 全屏 webm auto（vp8 720p） | 3139 | 16ms | 20.6fps | 31.3% | 31.1% | 5.0% | 18.0% | 778MB |

- 主线程卡顿：事件循环延迟 mean 1.54–1.65ms、p95 ≤2.6ms、100ms 定时器最大偏差 2–6ms。
- 收尾（纯 JS remux）：10–64ms；finalize（含校验/入库）37–104ms；stopMs 77–275ms。
- 起录两段式改造：倒计时结束 → 真正开录从 256–284ms 降到 **5–16ms**（倒计时期间并行建采集窗+getUserMedia+准备画布）。
- 内存绝对值含基准自带的 2 个窗口（动画源窗 + 占位主窗）；正式应用空闲时只有主窗，采集窗空闲 25 秒自动销毁。
- 已 A/B 评估并**回滚**的优化：全屏/窗口模式不播放 <video>（省 1 条 1080p 解码）→ 实测 CPU 仅 -0.4pp、内存 -3MB、帧率无改善甚至略降（26.8 vs 28.8fps），判定无收益，已回滚（`src/capture/capture.js`）。
- 60fps：本机 GPU/CPU 编码能力不足（36fps / 40.5% 掉帧），但产品必须保留 60fps 选项。

## 五、启动事实（`scripts/measure-startup.mjs`，产物 `artifacts/startup/`）

- 冷启动：进程启动→whenReady 641ms → 建窗 796ms → 渲染层 loaded 1857ms → 窗口 shown 1871ms。
- 热启动（同机第二次起）：whenReady 266–405ms → 建窗 355–544ms → renderer_loaded 1304–1636ms → shown 1316–1530ms。
- 渲染层内部：navigation responseEnd 37ms、domInteractive 649ms、DCL 816ms；Performance metrics：ScriptDuration 12ms、
  LayoutDuration 123ms、RecalcStyleDuration 8ms、TaskDuration 206ms → 渲染层自身 JS 不是瓶颈，时间主要在 Electron/渲染进程启动与首帧。
- 主进程侧 `src/main/main.js` 启动顺序：settings/store 读取 → 建主窗（show:false，ready-to-show 后 show）→
  updater 初始化（启动 10s 后静默检查，24h 节流）。

## 六、Lead 认为「已接近极限」的理由（请逐条反驳或确认）

### A. 体积（编号 S1–S10）
- S1. NovaRec.exe 238MB 是 Electron 官方预编译二进制，静态包含 Chromium/Node/ICU/V8；官方发布版已 strip，无多余调试符号；
  任何二进制压缩（UPX 等）会破坏 PE 校验/自解压、极大增加杀软误报、拖慢启动，且 Electron 官方明确不支持，判定不可行。
- S2. 不能换运行时（Tauri / WebView2 / .NET）：Windows WebView2 不提供 desktopCapturer 等价的窗口枚举 + 系统声音 loopback 采集，
  换实现等于重写并失去系统声音能力 → 属于砍功能，禁止。
- S3. resources.pak（12.75MB）、icudtl.dat（10.3MB）、v8_context_snapshot.bin、snapshot_blob.bin、ffmpeg.dll（3MB）、
  d3dcompiler_47.dll（4.5MB）都是 Chromium 运行时必需或影响既有功能（Intl/中文、媒体解码、ANGLE D3D11 GPU canvas），
  删除会崩溃或降级功能。
- S4. vk_swiftshader.dll + vulkan-1.dll（6.1MB）是软件光栅/Vulkan 回退，GPU 驱动异常或远程桌面环境需要它才能起界面；
  删除有「部分机器打不开」的功能风险，收益 6MB，不值得。
- S5. LICENSES.chromium.html（5.4MB）是 Electron 分发的 Chromium 许可证合规文本，删除/改写有合规风险，保留。
- S6. locales 已只剩 zh-CN/en-US。
- S7. asar 内 1.99MB = 全部应用代码 + 图标（无 node_modules、无 ffmpeg、无测试脚本），已无可删。
- S8. NSIS 已 maximum LZMA；上层再套 7z/自解压收益很小（NSIS 本就用 LZMA），还会增加安装失败/杀软风险。
- S9. 源码/文档/scripts 未进包；图标已精简（icon.ico + 少量 png）。
- S10. 进一步大减只能靠「换更小的 Electron 定制构建」（自行编译 Electron 裁剪组件），工程量巨大、破坏自动更新
  （官方 Electron 二进制哈希/签名流程），判定不可行。

### B. 录制期性能（编号 P1–P8）
- P1. 全屏 1080p30 H.264 已 28.8fps/5% 掉帧、整机 CPU ≈7%（单核 28%），瓶颈在 GPU 媒体引擎与 4 核 CPU；
  不降分辨率/帧率/画质就无法再降（降了就是砍功能/砍质量）。
- P2. 60fps 实测 36fps（40.5% 掉帧），是硬件编码能力上限，不是代码问题；保留选项即可。
- P3. WebM VP9/VP8 走软件编码（渲染器 CPU 45%/18%），是格式固有成本；产品默认 MP4，文档提示 WebM 在低端机更贵。
- P4. 采集链路已是 DXGI 桌面复制 + 媒体引擎编码；A/B 实测「不播放 video」无收益（见上）。
- P5. 收尾 JS remux 10–64ms，I/O 主导；再优化空间 <10ms。
- P6. 两段式启动后倒计时结束到开录 5–16ms，剩余 startMs 是倒计时本身，不是延迟。
- P7. 录制期内存 ~700MB 中含基准测试的 2 个额外窗口；正式应用主窗+采集窗约 300–450MB，Chromium 基线决定下限。
- P8. 主线程延迟 p95 ≤2.6ms，UI 不卡，无优化必要。

### C. 启动/运行期（编号 T1–T6）
- T1. 热启动 1.3–1.5s 到可见窗口、1.1–1.2s 到 API 可用；其中渲染层自身 JS 仅 12ms，主要是 Electron/渲染进程启动与首帧。
- T2. 再优化需改 Chromium 启动开关（风险：GPU/采集路径回归）或自编译 Electron（工程不可行）。
- T3. 预加载 capture 窗、预热采集流会增加空闲内存，与 P7 冲突；已有倒计时期间预热。
- T4. 渲染层 boot 只做 DOM 缓存+空态渲染+异步加载数据，已无同步重活可拆。
- T5. 自动更新器启动 10 秒后才静默检查，不占启动关键路径；24h 节流。
- T6. 空闲时采集窗 25 秒自动销毁；托盘/全局快捷键常驻成本可忽略。

## 七、评审规则（必须遵守）

1. **只读源码**：不要修改 `src/`、`scripts/`、`package.json`；你的产出只能写你自己那份评审文件（见下）。
2. **不要启动 Electron 应用/采集脚本**（不要跑 `npm start`、`scripts/selftest.mjs`、`perfbench.mjs`、打包后的 exe）：
   桌面采集是独占资源，会互相干扰。允许：读文件、`node --check`、纯 Node 计算脚本（统计体积、解析 asar 列表）、
   查文档、web_search/web_fetch、用 7z/du 等只读工具分析产物（不要删除产物）。
3. 对第六节每条理由给出：**成立 / 不成立 / 部分成立**，并给出证据（代码位置、文档、命令、数字）。
4. 对每个「不成立/部分成立」给出**可执行路线**：具体文件与函数、改动思路、预期收益（MB 或 CPU%/ms）、工程量（小/中/大）、
   风险（功能/稳定性/合规/自动更新）、是否需要联网/新依赖。按「收益/风险」排序，至少 1 条、最多 8 条。
5. 如果你认为某条「成立」，也要说明你为什么没找到更好的替代路线（一句话即可）。
6. 明确区分「本机可验证」与「推测」；对推测标注置信度。
7. 你的最终结论必须是二者之一：
   - `AGREE_STOP`：你认为已到当前约束下的极限，没有值得实现的进一步优化；
   - `DISAGREE`：存在值得实现的优化（列出路线）。
8. 只写中文；不要重复本文档已有内容，聚焦你的判断与新增信息。

## 八、你的产出

- 写入指定文件（见任务分配），结构：`## 逐条判定` → `## 可执行优化路线（按收益排序）` → `## 结论`。
- 同时把 30 行以内的摘要返回给 Lead（含结论词 AGREE_STOP / DISAGREE 与 top3 路线）。
