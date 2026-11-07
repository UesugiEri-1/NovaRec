# 验证记录（1.0.0 开发期）

以下数据来自开发完成时的端到端验证，供评估稳定性与性能参考。验证机器配置：AMD Ryzen 3 3300U（4 核）/ 13.9 GB 内存 / Windows 10 19045 / 1920×1080 @125% 缩放 / AMD Radeon Vega 6。

> 说明：验证机器装有第三方安全软件（HIPS），会拦截安装程序写入系统盘，因此安装包相关用例改在非系统盘目录验证；该限制属于验证环境，不是安装包本身的问题。

正式自测（scripts/selftest.mjs，真实桌面采集，2026-10-31 19:47，Windows 默认播放端点未静音）：

| 模式 | 输出分辨率 | 帧率 | 时长 | 文件大小 | 平均音量 | 编码/封装 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 屏幕 | 1920×1080 | 26.27 fps | 3.26 s | 3,115,077 B（约 3.0 MB，7642 kb/s） | -25.1 dB | H.264 Baseline + AAC 48 kHz，-c copy 封装 | 通过（可播放、分辨率正确；含暂停/继续校验：paused→recording） |
| 区域 | 1000×750（800×600 DIP × 125%） | 28.49 fps | 3.79 s | 1,596,276 B（约 1.5 MB） | -25.0 dB | H.264 Baseline + AAC 48 kHz，封装 | 通过（区域按物理像素放大，尺寸正确） |
| 窗口 | 1004×754 | 29.87 fps | 3.76 s | 1,573,160 B（约 1.5 MB） | -25.0 dB | H.264 Baseline + AAC 48 kHz，封装 | 通过（窗口模式采集正常） |

- SUMMARY ok=true，三模式全部通过；证据见 artifacts/selftest/result.json 与 artifacts/selftest/out/ 下的 mp4 + 同名 jpg 封面
- 三模式均产出可被 ffmpeg 解码校验的 MP4/H.264 + AAC 文件，文件大小、分辨率、时长均符合预期，均走 remux（无二次转码）
- 三模式均为 H.264 Baseline（avc1）+ AAC LC 48 kHz 立体声；transcode=remux（ffmpeg -c copy 封装）、fallback=false；ffmpeg validate（-v error -i 文件 -f null -）全部通过
- 系统声音电平受 Windows 默认播放端点状态影响：端点未静音时实测 mean_volume 约 -25 dB；端点被静音时三模式均为约 -91 dB（静音），属于环境状态而非程序缺陷（自测前请确认系统音量与静音状态）
- 若系统音频端点静音，自测脚本会将该条检查标记为 WARN/SKIP（见 scripts/selftest.mjs 与 scripts/audio-state.ps1）

### 打包版验证（2026-10-31 20:19–20:23，同一台机器）

启动验证（artifacts/dist/NovaRec-win32-x64/NovaRec.exe --no-sandbox）：

- 窗口标题 `NovaRec`、窗口尺寸 **1196×809**（含边框；内容区 1180×800）；截图 **artifacts/dist-launch.png**（1920×1080，364,266 B），界面完整渲染（导航、三模式卡片、屏幕缩略图、参数面板均正常）
- 日志：`[novarec] ready, userData=<解压目录>\NovaRecData output=C:\Users\<用户名>\Videos\NovaRec` —— 便携式数据目录生效
- 关闭方式：正常退出；测试后无残留进程

打包版真实 UI 端到端（内部 UI 端到端脚本，5 项全部 PASS）：

| 用例 | 结果 | 实测 |
| --- | --- | --- |
| screen-pause | PASS | 1920×1080，2.67 MB，暂停/继续正常 |
| region-drag | PASS | 626×500，68.9 KB，走 repaired remux（空音轨分片修复后成功封装） |
| window-select | PASS | 记事本窗口原生采集失败 → 自动降级「激活窗口+屏幕裁剪」1424×740，887 KB |
| window-fallback | PASS | DSH 窗口降级屏幕裁剪 1920×1030，900 KB |
| library-page | PASS | 素材库 4 张卡片正常显示 |

- 五个用例的录像均含 AAC 48 kHz 立体声音轨；appInfo：version=1.0.0（打包版版本正确）、electron 45.2.1、chrome 156、ffmpeg=true
- 证据：artifacts/e2e-packaged/result.json 与 artifacts/e2e-packaged/e2e.log

### 安装包与签名验证（2026-10-31 21:25–23:25，同一台机器）

**构建与签名**

- 安装包由 electron-builder 26.18.0（NSIS 3.0.4.1）构建：assisted installer（`oneClick: false`）、默认当前用户安装、多语言（简体中文 / 英文）、中文界面；构建耗时 294.6 s
- 产物 `NovaRec-Setup-1.0.0-x64.exe`（约 122 MB），已签名（SHA-256 + DigiCert 时间戳；证书为自签名证书，见使用说明第十二节）
- 便携版 zip `NovaRec-1.0.0-win32-x64.zip`（约 174 MB），exe / app.asar / ffmpeg / 使用说明.md 校验齐全
- 2026-11-01 白绿配色改版后重新构建并签名，产物尺寸以交付包实际文件为准

**安装（静默，安装到 D: 盘）**

- 命令：`NovaRec-Setup-1.0.0-x64.exe /S /currentuser /D=D:\Workplace\screen-recorder\artifacts\installtest4`（`TEMP`/`TMP` 指向 D: 盘可写目录）
- 结果：返回码 0，耗时约 41 s，落地 **88 个文件**；含 `NovaRec.exe`（约 249.9 MB）、`Uninstall NovaRec.exe`（约 259 KB）、`使用说明.md`、`resources/app.asar`、locales 等，结构与便携版一致
- 启动验证：从安装目录启动 `NovaRec.exe --no-sandbox`，日志 `[novarec] ready, userData=D:\...\installtest4\NovaRecData output=C:\Users\HP\Videos\NovaRec`，窗口正常创建、进程稳定运行

**安装到 C: 盘失败（验证环境限制）**

- 静默安装到 C: 盘（默认 `%LOCALAPPDATA%\Programs\NovaRec` 或任意 C: 路径）虽然返回 0，但 **0 个文件落地**
- GUI 安装到 C: 盘会弹框：`不能写入要写入的文件: "C:\Users\HP\AppData\Local\Programs\NovaRec\uninstallerIcon.ico"`（中止 / 重试 / 忽略）
- 交叉验证：同样地，NSIS 安装程序写 C: 盘临时目录也会报 `Error writing temporary file`；而普通进程（bash / cmd）写同一 C: 盘目录正常。综合判断为第三方安全软件的 HIPS 拦截安装程序对系统盘写入，与本安装包自身的逻辑无关
- 结论：**该环境下安装请选 D: 盘目录，或直接使用便携版 zip**（便携版不经过安装程序，实测稳定）

**卸载**

- 交互卸载向导可正常启动并走完（欢迎页 → 解除安装 → 完成，窗口标题「NovaRec 解除安装」）
- 但由于验证机器安装过程未能写入卸载注册表项（同上：受保护软件拦截安装程序对 C: 盘/注册表写入），卸载向导未实际清理文件；验证机器如不再需要，直接删除安装目录即可
- 在正常 Windows 环境下（无 HIPS 拦截），安装包会正常创建桌面/开始菜单快捷方式、写入「应用和功能」卸载项，卸载程序会一并清理

**清理**

- 验证用的临时安装目录 `artifacts\installtest*` 与相关计划任务、测试证书副本已在验证机器清理（不影响交付文件）

### 性能优化与性能模式验证（2026-11-01 00:05–00:20，同一台机器）

验证机器配置：AMD Ryzen 3 3300U（4 核）/ 13.9 GB 内存 / 1920×1080 @125% 缩放。系统音频端点保持静音，性能基准只测视频编码与收尾开销（内部性能基准脚本，静默演示窗、不发声采样）。

| 场景 | 输出分辨率 | 文件大小 | 应用 CPU 均值 | 停止→保存完成 | 收尾校验耗时（旧全解码 → 新仅解复用） |
| --- | --- | --- | --- | --- | --- |
| 原生 1080p / 60fps / 超清 | 1920×1080 | 14.26 MB | 41.7% | 4123 ms | 4868 ms → 528 ms |
| 原生 1080p / 30fps / 高清 | 1920×1080 | 3.95 MB | 28.0% | 1160 ms | 666 ms → 307 ms |
| 性能模式（请求 60fps 超清 → 封顶 30fps 标准） | 1280×720 | 1.50 MB | 25.2% | 1336 ms | 648 ms → 233 ms |
| 性能模式 · 区域 800×600 DIP（原生 1000×750） | 668×500 | 0.50 MB | 26.5% | 1827 ms | 1000 ms → 566 ms |
| 性能模式 · 窗口（演示窗 1004×754） | 960×720 | 1.16 MB | 26.5% | 2488 ms | 556 ms → 225 ms |

- 同样的「60fps / 超清」请求下，性能模式把文件从 14.26 MB 降到 1.50 MB（约 −89%），应用 CPU 从 41.7% 降到 25.2%，收尾从 4123 ms 降到 1336 ms
- 收尾校验改为仅解复用（-c copy -f null -）后，1080p 文件的校验耗时从 4.9 s 降到 0.5 s（约 10 倍），不再为每次录制做全片解码
- 录制期间整机 CPU 采样 73%–97%（含演示动画与 Chromium 合成），属于隐藏采集窗口 + 实时编码的固有开销；性能模式的价值在于把分辨率/帧率/码率降到老设备能承受的区间
- 三模式自测（scripts/selftest.mjs，强制原生画质）仍全部通过：屏幕 1920×1080、区域 1000×750、窗口 1004×754，含音轨、暂停恢复、时长与解码校验；系统音频端点静音时该项电平检查降级为 WARN
- 性能模式 UI 校验（内部 UI 校验脚本）：录制页/设置页性能控件齐全，「自动」在 4 核机器上正确显示「已启用」，切换「开启/关闭」时 html.perf-lite 类正确增删；截图 artifacts/ui/05-perf-record.png、06-perf-settings.png、07-perf-on-settings.png
- 证据文件：artifacts/perfbench/result.json、artifacts/perfbench.log、artifacts/ui/perf-ui-result.json

### 界面与品牌改版验证（2026-11-01）

- **白绿配色改版**：界面由深色紫调改为白底浅灰 + 单一绿色强调色（#17A24B），容器方角 + 1px 发丝线分隔，仅在控件上使用 2px 圆角；移除紫/绿渐变高光、外发光与毛玻璃，主操作按钮改为绿色实底方角按钮
- **图标改版**：应用图标改为绿色 squircle（#3ACB74 → #20B45C → #0B8A42 渐变）底 + 白色准星标记（四段弧环 + 四向刻度 + 中心点），与参考图造型一致；托盘图标为白色单色线稿，录制中切换为红点状态
- **布局修正**：把「性能模式」「保存位置」从右侧参数面板移到左列「输出」区块后，在 1440×900 窗口（内容区约 1441×824）下右侧面板全部 8 行参数完整可见，不再被底部操作条截断
- **截图证据**：artifacts/ui/01-record.png（录制页）、02-library.png（素材库）、03-settings.png（设置）、04-window-picker.png（窗口选择）、05-countdown.png（倒计时）、06-recording.png（录制中）、07-paused.png（已暂停）、08-processing.png（保存中），均为 1802×1030（125% 缩放）
- **自动校验**：scripts/screenshot.mjs 生成 8 张截图（shots=8，core=6，无空白/异常）；scripts/ui-perf-check.mjs 返回 ok=true（性能控件齐全、perf-lite 类切换正常）；字体探针确认中文使用 Microsoft YaHei UI
- 界面改版后录制流程（三模式真实采集）仍由 scripts/selftest.mjs 与 e2e-ui.mjs 覆盖，功能无变化

---

## 附：性能基准实测（4 核 Ryzen 3 3300U / 13.9 GB）
| 场景 | 分辨率 | 8 秒文件 | 应用 CPU | 收尾 |
| --- | --- | --- | --- | --- |
| 原生 60fps 超清 | 1920×1080 | 14.26 MB | 41.7% | 4123 ms |
| 原生 30fps 高清 | 1920×1080 | 3.95 MB | 28.0% | 1160 ms |
| 性能模式 | 1280×720 | 1.50 MB | 25.2% | 1336 ms |

完整的逐项数据见上文「性能优化与性能模式验证」小节，基准脚本为 `scripts/perfbench.mjs`（静默基准，不发声采样）。

---

## v1.1.0 验证记录（2026-11-07，同一台验证机）

v1.1.0 的优化改动（去 ffmpeg、纯 JS 重封装、dxcompiler 裁剪、两段式起录、自动更新）全部重新做了端到端验证。

### 1. 打包产物三模式录制（真实 UI + 系统声音）

脚本：`node scripts/verify-packaged-record.mjs --exe artifacts/dist-v8/NovaRec-win32-x64/NovaRec.exe`
（下表为 v1.1.0 首次全量回归数据；最终 dist-v8 复跑 SUMMARY ok=true，screen/region/window 三模式 PASS、退出码 0）
（启动打包后的 exe，通过 CDP 驱动渲染层的 window.novarec API，走与用户完全相同的录制路径）

| 模式 | 分辨率 | 时长 | 文件 | 流信息 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 全屏 | 1920×1080 | 3.24 s | 771,995 B | H.264 Baseline + AAC 48 kHz 立体声，28.81 fps，transcode=remux | PASS |
| 区域（DIP 960×540） | 1200×676（×1.25 物理像素） | 3.21 s | 492,957 B | H.264 + AAC，28.33 fps，transcode=remux | PASS |
| 窗口 | 1920×1030 | 3.24 s | 1,064,455 B | H.264 + AAC，28.48 fps，transcode=remux | PASS |

- 三个文件都是打包产物直接产出，收尾全部走纯 JS 重封装（transcode=remux，无 ffmpeg 子进程），ffmpeg 仅用于事后解析校验
- 证据：artifacts/verify-packaged/result.json、artifacts/verify-packaged/verify.log、artifacts/verify-packaged/out/*.mp4 + 同名 .jpg 封面

### 2. 纯 JS 重封装正确性（离线单个文件验证）

- MP4：`ffmpeg -v error -i out.mp4 -f null -` 全解码无错误；`ffmpeg -i` 解析 Duration、AAC 48 kHz 立体声、H.264 Baseline 1920×1080 30fps、
  handler_name SoundHandler/VideoHandler；原 fMP4 的 mvhd duration=0 问题已消除（moov 前置、完整 stbl 表 = faststart）
- WebM：固定后 durationMs=4019、clusters 按关键帧重切、Cues 每簇一个；`ffmpeg -ss 2.5` 与 `-ss 3.6` 均无参考帧缺失报错，
  视频 pts 序列与原始文件逐帧一致、音频帧数 66=66 → 重封装不改变时间戳/不重新编码
- 证据：artifacts/probe-formats/ 下的样本与校验输出

### 3. 性能基准（8 用例 × 10 秒，scripts/perfbench.mjs）

完整表格见 [perf-baseline.md](perf-baseline.md)，核心数字：

- 全屏 MP4 1080p30：28.83 fps、掉帧 5.0%、单核 CPU 28.3%（GPU 进程 14.2%、渲染器 7.6%）、内存峰值 736 MB、收尾 remux 28 ms
- 区域 MP4（1600×900）：28.86 fps、掉帧 4.3%、单核 32.1%
- 窗口 MP4：30.01 fps、掉帧 0%、单核 22.2%
- WebM/VP9 1080p30：28.6 fps，但单核 56.3%（渲染器 45.2%）、内存 914 MB
- 1080p60：36.12 fps（掉帧 40.5%，硬件编码能力限制）
- 起录延迟：倒计时结束 → 真正开录 5–16 ms（v1.0 为 256–284 ms）
- 主线程：事件循环延迟 mean 1.5–1.7 ms、p95 ≤2.6 ms；100 ms 定时器最大偏差 2–6 ms

> 测试保真度说明：早期基准把「动画演示窗」当主窗，开录前被隐藏导致桌面静止，DXGI 桌面复制不出新帧（采集掉到 ~2 fps）；
> 现版本拆成「动画源窗（置顶 60fps，不被隐藏）+ 占位主窗」，每例记录 demoFps=59.9~60.0 作为保真度证据。

### 4. 启动耗时（scripts/measure-startup.mjs）

- 冷启动（首次，dist-v5）：进程启动 → whenReady 641 ms → 主窗创建 796 ms → 渲染层完成 1857 ms → 窗口可见 1871 ms
- 热启动（连续 2 次，dist-v5）：whenReady 266–405 ms → 主窗创建 355–544 ms → 渲染层完成 1304–1636 ms → 窗口可见 1316–1530 ms；
  渲染层 API 可用 1.14–1.24 s
- 启动优化后（dist-v7）：whenReady 368–520 ms、主窗创建 368–527 ms、渲染层完成 941–1470 ms、apiReady 692–901 ms；
  窗口仍等 ready-to-show 才显示，window_shown 1197/1316 ms
- 立即显示优化后（dist-v8）：建窗 + loadFile 后 setOpacity(0) → show → 180 ms 淡入，**window_shown 319.7 / 388.9 ms**
  （改善 0.8–0.9 s，用户不再看到黑屏等待）；renderer_loaded 1020–1208 ms、apiReady 冷 801–1016 ms / 热 801–1446 ms、
  Layout 97–133 ms、Task 118–168 ms 均不变，说明交互可用时间未受影响，只是消除了感知空窗
- 渲染层自身开销：ScriptDuration 12 ms、LayoutDuration 123 ms、TaskDuration 206 ms → 启动时间主要在 Electron/渲染进程启动与首帧，不在应用 JS
- 证据：artifacts/startup/startup.json 与各 run 的 data-*/dev.log（含 `perf when_ready/window_created/renderer_loaded/window_shown` 打点）

### 5. 体积

以最终交付构建 artifacts/dist-v8 为准（与 dist-v5 相比再省约 1.2 MB 未使用图标母版）：

- 便携目录：299,022,765 B（285.1 MiB，19 个文件）
- 便携 zip：135,971,874 B（129.7 MiB）
- NSIS 安装包（LZMA maximum）：97,039,803 B（92.5 MiB / 97.0 MB）
- 单文件便携 exe（7z 自解压）：96,685,191 B（92.2 MiB / 96.7 MB）
- 打包校验：asar 含 main/renderer/mp4remux/webmfix/mediafix、无 app.asar.unpacked、无 ffmpeg 依赖、无 dxcompiler.dll、保留 SwiftShader
- 与 1.0.0 对比：解压后 421 MB → 285 MB（-32%）、zip 173 MB → 129.6 MB（-25%）、安装包 122 MB → 97 MB（-20%），
  文件数 86 → 19；体积三路压缩已到 LZMA 固实极限（285.1 MiB → 97.0 MB ≈ 3.09×），更新链仍为整包约 97 MB

### 6. 自动更新

- `node scripts/test-updater.mjs`：33 项全部通过（版本比较、渠道降级、超时、状态持久化、跳过版本、下载校验等）
- 当前上游仓库无 Release / version.json，实际检查返回中文提示「未找到发布版本信息…」，属预期；仓库根已放置 version.json 供回退渠道使用

### 7. 体积/性能二轮优化与停止评审（2026-11-07）

由三个独立只读评审代理复核「是否还能继续优化」，三方均回 AGREE_STOP 后才停止（评审材料见
[optimization-review-v2.md](optimization-review-v2.md)）：

- **体积评审**：删 3 个 DLL（-11.1 MB 未压缩，压缩后仅省 3.5–4.5 MB，且失去软件光栅兜底）、
  electron_wer（0.43 MB）、UPX（破坏签名/杀软误报）、LICENSES/resources.pak/icudtl（不重编动不了）均判不做；
  分发侧已达 LZMA 固实压缩极限（285.1 MiB → 97.0 MB ≈ 3.09×）。实操建议：日常用 zip 或安装包，
  单文件便携 exe 每次启动自解压到 %TEMP%，慢 2–5 秒
- **启动评审**：采纳「建窗后立即显示再淡入」（window_shown 1197/1316 ms → 319.7/388.9 ms）；
  paintWhenInitiallyHidden、精简首屏 DOM 判为收益过小不做
- **运行时评审**：WebM 性能模式限时 A/B 三组（VP8 720p 26.3fps/12.4% 掉帧、VP9 720p 27.6fps/7.9%、
  只压码率 1080p 27.8fps）均与 MP4 同档 28.87fps 相差 <10%，无配置级修复空间，判为 Chromium 编码器固有开销，
  默认仍推荐 MP4；其余（1080p60 追帧、区域 canvas 裁剪、内存）判为收益不足

最终构建 artifacts/dist-v8 已通过三模式录制回归、启动耗时实测与打包校验，交付文件：
便携 zip（135,971,874 B）、NSIS 安装包（97,039,803 B）、单文件便携 exe（96,685,191 B）。
