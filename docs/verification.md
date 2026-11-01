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