# NovaRec 性能基线报告（v1.1.0）

- 版本：NovaRec 1.1.0（Electron 45.2.1 / Chromium 与 Node 版本见 result 文件）
- 机器：Windows 10 19045 / AMD Ryzen 3 3300U（4 核 4 线程，Vega 6 核显）/ 13.9 GB 内存
- 显示：物理 1920x1080，系统缩放 125%（DIP 1536x864）
- 测量脚本：`scripts/perfbench.mjs`（Electron 内直接驱动 `src/main/recorder.js`，与正式应用同一套采集/编码/收尾代码）
- 原始数据：`artifacts/perfbench/result-v4.json`、`artifacts/perfbench-v4.log`；启动 artifacts/startup/startup.json（artifacts/startup-v7.log）；预热对照 result-pwoff.json / result-pwon.json
- 生成时间：2026-11-07

## 方法

- 8 个用例，每例录 10 秒、倒计时 3 秒；每 300–500ms 采样 `app.getAppMetrics()`（CPU 为「单核百分比」= 1 核满载 100），
  另用 `monitorEventLoopDelay` 与 100ms 定时器抖动测主线程卡顿。
- 分进程统计 Browser / GPU / Utility / Tab（渲染进程）CPU 与工作集内存。
- 录制产物用 ffmpeg（仅测量用途，不随产品分发）解码计数真实帧数，计算掉帧率与码率。
- **测试保真度关键点**：早期版本把「动画演示窗」同时当作主窗传给 Recorder，录全屏/区域前主窗被隐藏 →
  桌面静止 → DXGI 桌面复制不再产生新帧 → 采集掉到 3–30 帧/10s，属测试环境假故障。
  现版本拆成「动画源窗（始终可见、置顶、60fps）」+「占位主窗（会被隐藏）」两个窗口，
  每例记录 demoFps=59.9~60.0，证明录制期间桌面确实持续更新。对比：桌面静止假故障下 screen 用例仅 2.4fps。

## 结果（10 秒录制，倒计时 3 秒）

| 用例 | 起录 startMs | 倒计时后延迟 | 实测帧率 | 掉帧 | 码率 | 单核 CPU 均值(峰值) | 其中 GPU 进程 | 其中渲染器 Tab | 内存峰值 | JS 重封装 | 停止→入库 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| screen-mp4-high30-native | 3138 | 7ms | 28.83fps | 5.0% | 8.94Mbps | 28.3% (32.7) | 14.2% | 7.6% | 736MB | 28ms | 275ms |
| screen-webm-high30-native | 3153 | 15ms | 28.6fps(286帧) | 4.7% | 5.37Mbps | **56.3% (62.0)** | 4.6% | **45.2%** | 914MB | 64ms | 188ms |
| screen-mp4-high60-native | 3082 | 5ms | 36.12fps | 40.5% | 17.77Mbps | 37.7% (43.9) | 18.0% | 9.7% | 781MB | 44ms | 257ms |
| screen-mp4-low30-native | 3141 | 10ms | 28.78fps | 4.3% | 2.78Mbps | 28.7% (33.7) | 14.1% | 7.5% | 752MB | 14ms | 132ms |
| region-mp4-high30-native | 3088 | 13ms | 28.86fps | 4.3% | 6.26Mbps | 32.1% (36.0) | 16.7% | 7.7% | 775MB | 19ms | 204ms |
| window-mp4-high30-native | 3137 | 8ms | 30.01fps | **0%** | 3.45Mbps | 22.2% (25.1) | 13.0% | 5.5% | 752MB | 14ms | 160ms |
| screen-mp4-high30-auto(720p) | 3085 | 9ms | 28.87fps | 4.0% | 2.18Mbps | 26.0% (27.7) | 11.7% | 5.8% | 758MB | 13ms | 102ms |
| screen-webm-high30-auto(vp8 720p) | 3139 | 16ms | 20.6fps(206帧) | 31.3% | 1.16Mbps | 31.1% (36.9) | 5.0% | 18.0% | 778MB | 34ms | 77ms |

主线程卡顿（所有用例）：事件循环延迟 mean 1.54–1.65ms、p95 ≤ 2.6ms、最大瞬时 76–140ms（启动/收尾瞬间）；
100ms 定时器最大偏差 2–6ms → 录制期间界面基本不卡。

## 阶段对比（两段式启动）

| 实现 | 倒计时结束 → 真正开录 | 说明 |
|---|---|---|
| v1.0（单段 start） | 256–284ms | 倒计时结束后才开始 getUserMedia 建立流、等首帧、建 MediaRecorder |
| v1.1（prepare/start 两段式） | **5–16ms** | 倒计时期间并行完成建窗 + 加载采集页 + getUserMedia + 画布/混音准备，倒计时一结束只建 MediaRecorder 并开录 |

`startMs` 仍为 3.1s 左右是因为含 3 秒倒计时（3000 + 5~16ms + 主进程调度），倒计时设 0 时 warm 起录约 0.44–0.62s。

## 补充用例（60fps、区域/窗口、WebM 性能模式）

| 用例 | 时长 | 实测帧率 | 掉帧 | 单核 CPU | 结论 |
|---|---|---|---|---|---|
| window-mp4-high60-native | 8s | **59.13fps** | 1.7% | 30.9% | 窗口录制可跑满 60fps |
| region-mp4-high60-small（800×450 DIP） | 8s | 53.77fps | 9.8% | 30.6% | 小区域 60fps 接近满帧 |
| screen-mp4-high60-native | 10s | 36.12fps | 40.5% | 37.7% | 全屏 1080p60 受像素吞吐限制，达不到 |
| screen-webm-high30-auto（VP8 720p 性能模式） | 8s | 26.3fps | 12.4% | 31.0% | 与 MP4 同档差距 <10%，可接受 |
| screen-mp4-high30-auto（720p） | 10s | 28.87fps | 4.0% | 26.0% | MP4 性能模式正常 |

WebM 性能模式三组 A/B（8 秒，formal bench，本机 lowEnd 自动启用性能模式）：

| 变体 | 实测帧率 | 掉帧 | 单核 CPU | 内存峰值 | 码率 | 结论 |
|---|---|---|---|---|---|---|
| A：VP8 720p（现状，偏好 VP8） | 26.3fps | 12.4% | 31.0% | 704MB | 1.58Mbps | 基准 |
| B：VP9 720p（NOVAREC_PERF_VP8=0） | 27.6fps | 7.9% | 35.1% | 772MB | 2.09Mbps | 帧率略高但 CPU/内存更贵，不采纳 |
| C：只压码率不缩放（1080p VP8） | 27.8fps | 7.1% | 39.1% | 746MB | 4.15Mbps | 码率/CPU 明显更高，不采纳 |

三组都落在 26–28fps，与 MP4 同档 28.87fps 差距 <10%，不存在配置级修复空间；
早期一次测得的 20.6fps/31% 掉帧为测量方差（窗口遮挡/负载波动）。结论：关闭该排查项，默认格式仍推荐 MP4，
WebM+性能模式作为可用但较费的选项保留。

- 区域模式已改为 canvas.captureStream(0) + 每帧 requestFrame()（无 requestFrame 时自动回退），
  1080p 区域无变化（28.71fps / 4.6%），小区域 60fps 由 53.19→53.77fps 微升。
- 尝试「全屏/窗口不播放隐藏 video、改用 ImageCapture.grabFrame 抓封面」：CPU 仅 -0.4pp、内存 -3MB、帧率反降，
  已完整回滚（A/B：不播放 26.82fps/27.62% vs 播放 26.53fps/28.01%）。
- WebM 性能模式（约束 720p 或只压码率）稳定在 ~25fps，MP4 同档 28.9fps；已记录为已知限制，默认仍推荐 MP4。

## 结论与取舍

1. **MP4/H.264 是低端机的正确默认**：1080p30 单核 28%（整机 ≈7%）、掉帧 5%、内存 736MB（含基准的 2 个窗口）。
   WebM/VP9 1080p30 虽然也能 28.6fps，但单核 56%（渲染器 45%）、内存 +178MB，在 4 核机器上明显更贵 → 默认格式保持 MP4，WebM 作为备选。
2. **60fps 视源而定**：全屏 1080p60 实测 36fps（掉帧 40.5%，像素吞吐受限）；窗口 1080p60 可达 59fps、小区域 60fps 也可用。默认 30fps 是稳妥选择，需要高帧率时选窗口/区域。
3. **区域录制开销略高于全屏**：canvas 逐帧裁剪 + 二次推流，单核 +3.7%，掉帧 4.3%，仍可用。
4. **窗口录制最省**：直接采集窗口源，0% 掉帧、单核 22%。
5. **性能模式 auto（本机 lowEnd 判定为真）** 输出 720p、单核 26%，是推荐给 4 核/8GB 以下机器的一档。
6. **收尾已无 ffmpeg 依赖**：MP4/WebM 重封装由纯 JS 完成，实测 10–64ms（finalize 37–104ms），
   相比 v1.0 的 3 次 ffmpeg 子进程（1–3s）是数量级提升，且移除了 61.5MB 的 ffmpeg 二进制。

## 说明与限制

- 内存绝对值包含基准脚本自身的「动画源窗 + 占位主窗」两个额外渲染进程（约 250–300MB），
  正式应用空闲时只有主窗 + 采集窗（采集窗空闲 25 秒后自动销毁），数值会更低。
- idle 段（采集窗自动关闭后 6 次采样）为 555MB / 单核 8.5%，但演示动画窗仍在 60fps 绘制，不等于真实空闲。
- 60fps 掉帧高不代表录制失败：MediaRecorder 会按实际产出帧率落盘，时间戳正确、可正常播放。
- 本报告只覆盖录制期指标；启动耗时与打包体积见下两节。

## 启动耗时（dist-v7，scripts/measure-startup.mjs）

| 阶段 | dist-v5（优化前） | dist-v7（本轮） |
|---|---|---|
| 主进程 when_ready | 641ms | 347ms |
| 主窗 created / ready | 796ms | 446ms |
| 首帧 deferred 装配完成 | — | 471ms |
| ready-to-show | — | 1185ms |
| 窗口 shown | 1871ms（冷） | 1197ms |
| renderer_loaded（冷） | 1857ms | 1460ms |
| apiReady（冷 / 热） | 1.14–1.24s / — | 962–1287ms / 924–1446ms |

dist-v8 起窗口不再等 ready-to-show（见「感知启动」优化）：`window_shown` 从 1197ms（冷）/1316ms（热）
提前到 **319.7ms / 388.9ms**（setOpacity(0) → show → 180ms 淡入；ready-to-show 只留 perfMark 记录）。
真实 UI 可交互时间不变（apiReady 冷 801–1016ms、热 801–1446ms），用户感知的「黑屏等待」消失。

本轮启动优化：
1. IPC 提前注册，托盘/录制器/快捷键/更新器（913 行 require）移出首帧关键路径（setImmediate 装配）。
2. 采集源列表两档：首屏只取 id/name（thumbnailSize 0、不取窗口图标，几 ms），首帧空闲后再补缩略图。
3. 麦克风设备列表惰性化（不再启动时 getUserMedia 取 label）。
4. 关闭无关 Chromium 特性（Translate/MediaRouter/GlobalMediaControls/Autofill/OptimizationHints/InterestFeed 等）。

剩余瓶颈：DOMContentLoaded → ready-to-show 约 740ms，为 Chromium 建窗与首帧合成开销；
渲染层 JS 仅 8–18ms（Performance: ScriptDuration / Layout 103–130ms / TaskDuration 169–174ms），不是 JS 慢。

## 采集窗预热对照（COUNTDOWN=0，3 秒/例）

| 用例 | 禁用预热 startMs | 启用预热 startMs | 说明 |
|---|---|---|---|
| screen（冷启动首条） | 980 | **412** | 提前建窗+加载采集页，省约 570ms |
| region | 575 | 435 | 波动大 |
| window | 511 | 556 | 波动大 |

正式应用在鼠标悬停「开始录制」时预热（只建隐藏采集窗、不取流，空闲 25 秒自动销毁）；
有倒计时（默认 3 秒）时，建窗与取流已在倒计时期间完成，预热主要改善倒计时=0 的场景。

## 体积与分发（v1.1.0 最终产物）

| 产物 | 体积 |
|---|---|
| 解压目录 dist-v7/NovaRec-win32-x64 | 299,022,094 B（285.1 MiB，19 个文件） |
| 便携 zip | 135,971,874 B（129.7 MiB） |
| NSIS 安装包 | 约 94 MB（LZMA maximum，未签名） |
| 单文件便携 exe | 约 96 MB（7z 自解压，electron-builder portable） |

相对 v1.0（目录 450MB / zip 181MB / 安装包 128MB）减少约 34%：删除内置 ffmpeg.exe 61.5MB、dxcompiler.dll 24.6MB、
53 个 locales pak 47.7MB、未使用图标母版 1.2MB，并将 asar 由 unpacked 改为纯 asar。
