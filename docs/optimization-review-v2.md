# NovaRec v1.1.0 优化评审材料（第二轮）

> 给三位评审子代理：请只读本文件（必要时可读仓库实现代码），不要修改任何文件。
> 目标：判断「体积 + 性能」是否已到实用极限；如有仍值得做的路线请指出。
> 硬约束：**不得砍功能**；不重新编译 Chromium/Electron；不引入运行时新依赖；离线可用；目标 Windows 10/11 x64。

## 1. 当前体积（artifacts/dist-v7：299,022,094 B = 285.1 MiB，19 个文件）

| 文件 | 字节 | 说明 |
|---|---|---|
| NovaRec.exe | 249,862,144 | Electron 主程序（Chromium+Node 打包进 exe） |
| resources/resources.pak | ~13.4 MB | Chromium UI 资源 |
| icudtl.dat | 10,824,576 | ICU 数据 |
| LICENSES.chromium.html | 5,705,935 | 开源许可证文本（合规要求） |
| vk_swiftshader.dll | 5,453,312 | 软件 Vulkan 光栅回退（无可用 GPU 时用） |
| d3dcompiler_47.dll | 4,753,864 | D3D 着色器编译 |
| ffmpeg.dll | 3,097,600 | Chromium 自带解码器（非 ffmpeg.exe） |
| locales（仅 zh-CN/en-US） | ~1.18 MB | 原先 55 个 pak，已删 53 个（-47.7 MB） |
| resources/app.asar | 753,299 | 应用代码（含 renderer 资源） |
| vk_swiftshader_icd.json / vulkan-1.dll / electron_wer.dll / snapshot_blob.bin 等 | 合计 ~2.0 MB | |
| 已删除项 | — | 内置 ffmpeg.exe -61.5 MB（改纯 JS 重封装）、dxcompiler.dll -24.6 MB（WebGPU 用）、图标母版 -1.2 MB |

发行物体积：便携 zip **135.9 MB**；NSIS 安装包 v5 为 94 MB（v7 正在重建）；单文件便携 exe（7z 自解压）正在构建。

## 2. 启动性能（scripts/measure-startup.mjs，spawn 打包 exe + CDP）

- dist-v5（优化前）：冷启动 renderer_loaded 1857ms → shown 1871ms；热启动 shown 1316–1530ms，apiReady 1.14–1.24s。
- dist-v7（本轮优化后）：冷 firstTarget 544–665ms、domContentLoaded 585–811ms、apiReady 962–1287ms；热 apiReady 924–1446ms（波动大）。
- 主进程 perf mark（冷启动）：when_ready 347ms → stores_loaded 355ms → window_created/ready 446ms → deferred_ready 471ms → window_ready_to_show 1185ms → shown 1197ms → renderer_loaded 1460ms。
- 渲染层 Performance：ScriptDuration 8–18ms、Layout 103–130ms、TaskDuration 169–174ms —— JS 本身不慢，**瓶颈在 DOMContentLoaded→ready-to-show 的 ~740ms**（Chromium 建窗/首帧合成）。

## 3. 本轮已实施（v6/v7）

1. 打包排除未使用的图标母版 icon-1024/512/128.png（-1.24 MB，asar 1.99MB → 0.75MB）。
2. IPC 提前注册，托盘/录制器/快捷键/更新器（913 行 require）移到首帧后的 setImmediate 装配（deferred_ready 471ms，几乎不占关键路径）。
3. 采集源列表两档：首屏 sources:list {fast:true}（thumbnailSize 0、不取窗口图标，几 ms），首帧空闲后再补带缩略图的一轮（原来启动时同步给每个窗口截图 + PNG 编码，150–400ms 主进程阻塞 + 2–4MB IPC）。
4. 麦克风设备列表惰性化：启动不再 getUserMedia({audio:true}) 取设备名（避免首屏打开麦克风/弹权限），改为进设置页或点麦克风开关时再取。
5. 关闭无关 Chromium 特性：Translate/MediaRouter/GlobalMediaControls/Autofill/OptimizationHints/InterestFeed、WebRtcHideLocalIpsWithMdns（桌面采集不用）。保留 vk_swiftshader/vulkan 作 GPU 异常回退。
6. 采集窗预热：鼠标悬停「开始录制」时提前建隐藏采集窗 + 加载 capture.html（只建窗不取流，空闲 25s 自动销毁）。基准对照（销毁采集窗后 prewarm 再 start）：冷启动首条录制 startMs **980ms → 412ms**；倒计时 3s 时该开销已被倒计时覆盖。
7. 两段式 prepare/start（v1.1 早期）：倒计时结束→真正开录 **256–284ms → 5–16ms**。
8. 纯 JS 收尾（无 ffmpeg）：MP4/WebM 重封装 + 校验 10–66ms（每条录像原先 3–4 次 ffmpeg 子进程 1–3s）。
9. asar 开启、无 app.asar.unpacked；locales 只留 zh-CN/en-US；删 dxcompiler.dll。

## 4. 录制性能基线（artifacts/perfbench/result-v4.json，10s/例，倒计时 3s，单核百分比）

| 用例 | 实测 fps | 掉帧 | 码率 | 单核 CPU | GPU 进程 | Tab 渲染 | 内存 |
|---|---|---|---|---|---|---|---|
| screen-mp4-high30 | 28.83 | 5.0% | 8.94Mbps | 28.3% | 14.2% | 7.6% | 736MB |
| screen-webm-high30 | 28.6 | 4.7% | 5.37Mbps | **56.3%** | 4.6% | **45.2%** | 914MB |
| screen-mp4-high60 | 36.12 | 40.5% | 17.77Mbps | 37.7% | 18.0% | 9.7% | 781MB |
| region-mp4-high30 | 28.86 | 4.3% | 6.26Mbps | 32.1% | 16.7% | 7.7% | 775MB |
| window-mp4-high30 | 30.01 | 0% | 3.45Mbps | 22.2% | 13.0% | 5.5% | 752MB |
| screen-mp4-auto(720p) | 28.87 | 4.0% | 2.18Mbps | 26.0% | 11.7% | 5.8% | 758MB |
| screen-webm-auto(vp8 720p) | 20.6 | 31.3% | 1.16Mbps | 31.1% | 5.0% | 18.0% | 778MB |

补充用例（3–8s）：窗口 1080p60 = 59.13fps/1.7% 掉帧/CPU 30.9%；区域 800x450@60 = 53.77fps/9.8%；全屏 1080p60 只有 36fps（掉帧 40%）→ 60fps 取决于像素吞吐而非固定上限。WebM 性能模式（约束到 720p 或只压码率）都稳定在 ~25fps，原因未查明（mp4 auto 720p 28.9fps 正常）。
主线程：事件循环延迟 mean 1.54–1.65ms、p95 ≤2.6ms、100ms 定时器抖动 ≤6ms。

## 5. 尚存的候选路线（请逐条判断「值得做 / 不做及原因」）

- A. 删 vk_swiftshader.dll + vulkan-1.dll + d3dcompiler_47.dll（-11.1 MB）：收益明确，但显卡驱动异常/远程桌面/无 GPU 虚拟机时可能起不来（Electron 需要软件光栅回退）。是否有既保功能又省这 11MB 的办法？
- B. 删 electron_wer.dll（-0.43 MB）：崩溃上报组件，删掉影响？
- C. LICENSES.chromium.html 5.7MB / resources.pak 13.4MB / icudtl.dat 10.8MB / v8 snapshot：不重编 Chromium 是否真的动不了？
- D. NovaRec.exe 249.8MB：Electron 主程序，有无安全压缩/裁剪手段（UPX 对 Electron 通常不可用）？
- E. 分发压缩：zip 135.9MB（tar deflate）；单文件便携 7z 自解压预计 ~96MB；还有更优的分发压缩方案吗（在 Windows 原生可用、不增加使用步骤的前提下）？
- F. 启动 740ms 的 ready-to-show 空档：可试 paintWhenInitiallyHidden:false、窗口先 show 骨架再渲染、精简首屏 DOM/CSS、或不用 ready-to-show 门控。值得做吗？风险？
- G. 渲染层首屏资源：index.html/styles.css/app.js 体积与首屏渲染；可做 critical CSS 内联/延迟渲染素材库页面吗？
- H. 录制侧：1080p60 不足（36fps）但窗口/小区域 60fps 可用；性能模式目前锁 720p30，是否应改为「窗口/区域允许 60fps、全屏仍 30fps」？收益 vs 复杂度？
- I. WebM 性能模式 ~25fps 异常：是否值得继续排查（可能 VP8/VP9 在 720p 约束流下的编码器行为）？
- J. 每条录像收尾仍有同步 CPU（10–66ms），可进一步降到 0 吗（增量写 moov / 边录边写索引）？收益 vs 风险？

## 6. 已确认无法/不适合做的（如不同意请指出）

- 不重编 Chromium/Electron（本机只有打包好的 dist，构建 Chromium 不可行）。
- 不改用系统 ffmpeg.exe 或 WebCodecs 转码（会增加依赖/复杂度，且当前纯 JS 收尾已验证正确）。
- 不砍任何现有功能（区域/窗口/全屏/系统声音/麦克风/暂停/素材库/托盘快捷键/自动更新）。

## 7. 请回复格式（≤20 行）

    VERDICT: AGREE_STOP  或  MORE_ROUTES
    - <路线编号/新增路线>：<收益估计> / <风险> / <是否建议做>
    - ...
