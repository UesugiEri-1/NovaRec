# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.1] - 2026-11-08

兼容性修复版本：解决部分 Windows 机器上双击启动后进程立即退出（无窗口、无提示，退出码 0x80000003 STATUS_BREAKPOINT）的问题。功能、体积与 1.1.0 一致。

### 修复

- **双击启动无反应**：在该类机器上 Chromium 沙箱初始化即崩溃，且崩溃发生在主进程 JS 执行之前（日志与 main.js 内的 appendSwitch("no-sandbox") 都来不及生效）。发布产物改为「启动器 + 应用」双文件结构：`NovaRec.exe` 是 115,712 B 的 C# 启动器（源码 scripts/launcher/NovaRecLauncher.cs，由 scripts/build-launcher.mjs 调用 csc 编译，图标与版本号随 package.json），负责以 --no-sandbox 启动同目录的 `NovaRecApp.exe`、原样转发命令行参数、等待退出并透传退出码；安装包快捷方式、单文件便携 exe 与 zip 解压目录均指向启动器，用户无需任何手工参数
- 打包排除规则：避免仓库调试残留（.tmp-* 用户数据目录、历史发布 zip、package-lock.json、启动器二进制）进入 resources/app.asar（asar 15,964,795 B → 600,427 B）
- 自动更新：安装已下载的安装包后，退出应用前等待 1.5 秒（原 0.4 秒），避免 Electron 子进程未退出时安装程序覆盖文件失败
- 安装包 / 便携版构建改用 signAndEditExecutable: false，不再用 rcedit 改写产物 exe（图标与版本已由 csc 写入启动器）
- **安装包在「未签名程序禁止写 C 盘」的机器上装不上**：NSIS 自定义 .onInit（assets/installer.nsh）先探测默认目录（%LOCALAPPDATA%\Programs\NovaRec）能否真正建目录+写文件，失败则自动把安装位置改为 D:\NovaRec（向导里可见、仍可手改）；修复前静默安装到默认目录直接 exit code 2 且 0 个文件落地
- **单文件便携版在同机器上卡死（NSIS Error: Error writing temporary file）**：打包前修改 electron-builder 的 portable.nsi 模板（scripts/make-portable.mjs 自动打补丁），解压目录从 %TEMP% 改为 portable exe 同目录的 .novarec-portable，不可写时回退 D:\NovaRecPortable-tmp；退出后自动清理
- **默认保存目录不可写导致录制白录**：启动时探测「视频\NovaRec」可写性，不可写自动改用 NovaRecData\recordings 并写入设置；录制收尾时若原目录仍不可写，自动改存备用目录并 toast 提示。实测本机默认目录被安全策略拦截，验证后 outputDir 落盘为 NovaRecData\recordings

### 说明

- 启动器固定附加 --no-sandbox：应用完全离线、不加载远程页面，关闭沙箱不影响使用安全；如需在沙箱可用的机器上对照验证，可用源码 `npm run start`（不带 no-sandbox 参数）
- 体积：解压后 298,984,934 B / 20 个文件（1.1.0：299,022,765 B / 19 个文件）；安装包约 97.1 MB；单文件便携约 96.8 MB；便携 zip 约 129.7 MB
- 从 1.1.0 升级：自动更新会提示下载 1.1.1 安装包；也可以直接覆盖安装，NovaRecData 数据目录保留

## [1.1.0] - 2026-11-07

体积与性能专项版本，功能不减。

### 新增

- 自动更新：设置页「版本更新」卡片，支持检查 / 下载 / 立即安装 / 跳过此版本；
  检查顺序为 GitHub Releases API 直连 → gh-proxy.com 镜像 → 仓库 version.json（raw / gh-proxy / jsDelivr）；
  每个渠道 8 秒超时，启动 10 秒后静默检查、24 小时节流，状态记录在 userData/updates/state.json
- 两段式起录：倒计时期间并行建立采集流/画布，倒计时结束到真正开录从 256–284 ms 降到 5–16 ms
- 性能基准脚本 scripts/perfbench.mjs、启动耗时脚本 scripts/measure-startup.mjs、
  打包产物端到端验证脚本 scripts/verify-packaged-record.mjs

### 体积优化

- 移除内置 ffmpeg.exe（-61.5 MB），MP4/WebM 收尾改为纯 JS 重封装（src/main/mediafix.js + mp4remux.js + webmfix.js）
- 语言包只保留 zh-CN / en-US（删 53 个，-47.7 MB）
- 删除 dxcompiler.dll（WebGPU 着色器编译器，-24.6 MB；已做三模式录制回归验证）
- NSIS 安装包 LZMA 最大压缩；新增单文件便携 exe（electron-builder portable，7z 自解压）
- 打包排除未使用的图标母版 assets/icon-1024/512/128.png（-1.2 MB；运行期只用 icon.png / icon.ico / tray*.png）
- 结果：便携目录 421 MB → 285 MB（299,022,765 B，19 个文件），便携 zip 173 MB → 129.7 MB（135,971,874 B），
  安装包 122 MB → 97.0 MB（97,039,803 B），单文件便携 96.7 MB（96,685,191 B）

### 性能优化

- 收尾（封装/索引/封面）从 ffmpeg 多次子进程（0.5–3 s）改为纯 JS（10–60 ms，整体 37–104 ms），画质无损
- 隐藏采集窗挂载 video 元素时不再额外解码（实测无收益，已回滚，保留稳定帧率路径）
- 崩溃恢复：采集渲染进程崩溃后清理死窗口，避免下次录制 30 秒超时；倒计时期间预热采集窗
- 启动优化：窗口不再等 ready-to-show，先用同色底立即显示再 180 ms 淡入（窗口可见从约 1.2 s 提前到约 0.3–0.4 s）；
  IPC 提前注册、托盘/录制器/更新器移到首帧后装配；采集源列表首屏只取 id/name、首帧空闲再补缩略图；
  麦克风设备列表改为进设置页/开麦克风时再枚举；关闭 10 个无关 Chromium 特性
- 采集窗悬停预热：鼠标移到「开始录制」时提前建隐藏采集窗，冷启动首条录制 startMs 980 ms → 412 ms
- 区域模式改 canvas.captureStream(0) + 每帧 requestFrame（兼容旧 API 自动回退）
- 实测（Ryzen 3 3300U / Vega 6）：全屏 MP4 1080p30 28.8 fps、单核 CPU 28%、主线程 p95 延迟 ≤2.6 ms；
  窗口 1080p60 59.1 fps、区域 800×450@60 53.8 fps；启动冷 apiReady 0.96–1.29 s

### 移除

- 打包产物不再包含 ffmpeg.exe 与任何生产依赖（asar 内只有本项目代码与图标）

### 已知问题

- 全屏 1080p60 在低端机受像素吞吐限制（本机约 36 fps；窗口/小区域 60fps 可用）；WebM/VP9 在低端机 CPU 占用明显高于 MP4
- WebM + 性能模式（720p VP8）在本机约 20–25 fps，低于 MP4 同档 28.9 fps；三组 A/B（VP8 720p / VP9 720p / 只压码率不压分辨率）均约 25 fps，判定为 Chromium 内部行为，默认仍推荐 MP4
- 单文件便携 exe 每次启动会自解压到临时目录（启动慢 2–5 秒）；日常使用建议 zip 版或安装包
- 自动更新下载完整安装包，无增量更新；构建产物未做商业代码签名

## [1.0.0] - 2026-11-01

首个开源版本。

### 新增

- 三种录制模式：整屏 / 矩形框选区域 / 指定窗口
- 系统声音（loopback）与麦克风可分别开关并混音
- MP4（H.264 + AAC）与 WebM（VP9 + Opus）输出，可选帧率与画质档位
- 倒计时、暂停/继续、F9 停止、F10 暂停的全局快捷键
- 录制时自动隐藏主窗口，托盘图标与托盘菜单控制
- 素材库：缩略图、播放、定位文件、删除进回收站
- 性能模式（自动 / 开启 / 关闭），低配机器自动降级
- 区域框选覆盖层、窗口选择器、DPI 感知的坐标换算
- 打包脚本（便携版 zip / NSIS 安装包）、自测脚本、UI 截图脚本
- Windows CI 构建工作流

### 已知问题

- 整屏录制仅主显示器
- 部分受保护窗口无法直接采集，回退为整屏裁剪
