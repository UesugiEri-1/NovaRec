NovaRec · 免费开源的 Windows 录屏软件
全屏录制、截选区域、选择窗口，可同时录制系统声音与麦克风。无广告、无捆绑、无需注册。

Windows 10 / 11 · x64 ｜ Electron 45 + Chromium 桌面采集 + ffmpeg ｜ MIT License ｜ v1.0.0

录制页

目录
功能
截图
下载与安装
从源码运行
打包与签名
项目结构
工作原理
已知限制
文档
许可证与第三方组件
功能
三种录制模式：整屏 / 矩形框选区域 / 指定应用窗口
声音：系统声音（默认播放设备 loopback）与麦克风可分别开关，支持混音；也可纯静音录制
输出格式：MP4（H.264 + AAC，兼容性最好）或 WebM（VP9 + Opus），支持帧率 / 画质档位
录制控制：倒计时（关闭 / 3 秒 / 5 秒）、暂停与继续（暂停不计入时长）、F9 停止、F10 暂停/继续
不打扰：开始录制后主窗口自动隐藏，托盘图标 + 托盘菜单控制；单实例运行
素材库：缩略图预览、播放、定位文件、删除（进回收站），录制完成自动入库
性能模式：低配机器自动降到 720p · 30fps 并精简界面动画，录制期间阻止息屏
中文界面：浅色 + 单一绿色强调色（#17A24B），无边框自绘标题栏
截图
录制页	素材库
录制页	素材库
设置	选择窗口
设置	选择窗口
倒计时	录制中
倒计时	录制中
下载与安装
发布版提供两种形式（见仓库 Releases 页面）：

安装包：NovaRec-Setup-1.0.0-x64.exe，NSIS 安装向导，可自选安装目录，自带卸载程序
便携版：NovaRec-1.0.0-win32-x64.zip，解压即用，不写注册表
系统要求：Windows 10 1809 及以上 / Windows 11，x64；录制系统声音需要有可用的播放设备。

便携版与安装包默认未做商业代码签名（自签名证书不被系统信任），首次运行可能出现 SmartScreen「未知发布者」提示，选择「更多信息 → 仍要运行」即可。自行构建并签名的方法见 docs/build.md。

从源码运行
需要 Node.js 20+（本项目在 Node 24 上开发验证）与 Windows 10/11。

git clone https://github.com/<your-org>/novarec.git
cd novarec
npm ci
npm ci 之后如果 node_modules/electron/dist 为空（npm 12 会阻止第三方 postinstall 脚本），手动补一次 Electron 二进制：

node node_modules/electron/install.js
# 国内网络可先设镜像：
# set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
启动：

npm start
# 若所在环境因 Chromium 沙箱导致进程直接退出（rc=3），改用：
npm run start:nosandbox
# 或 set NOVAREC_NO_SANDBOX=1
数据目录优先级：NOVAREC_DATA_DIR 环境变量 → 开发态 <repo>/.data（已在 .gitignore 中）→ 打包态 exe 同级 NovaRecData（便携，解压即用）→ 不可写时退回 %APPDATA%\NovaRec。

打包与签名
npm run build            # @electron/packager 生成 artifacts/dist/NovaRec-win32-x64 并打 zip
npm run build:installer  # 基于上面的产物生成 NSIS 安装包 artifacts/installer/NovaRec-Setup-<ver>-x64.exe
npm run cert             # 创建自签名代码签名证书（仅开发/内部测试）
npm run verify           # 校验打包产物是否完整可启动
签名、镜像加速、CI 与常见打包问题见 docs/build.md。

项目结构
.
├─ src/
│  ├─ main/            # 主进程：窗口、托盘、快捷键、IPC、录制编排
│  │  ├─ main.js       #   应用入口、窗口与托盘、IPC 注册
│  │  ├─ sources.js    #   desktopCapturer 源枚举 / 图标 / 窗口 bounds
│  │  ├─ recorder.js   #   录制状态机：倒计时 → 采集 → 收尾入库
│  │  ├─ ffmpeg.js     #   ffmpeg 定位、探测、转封装
│  │  ├─ store.js      #   settings.json / library.json 持久化
│  │  ├─ winbounds.js  #   窗口坐标、DPI、临时目录
│  │  └─ perf.js       #   性能模式判定
│  ├─ preload/         # contextBridge 暴露的 window.api
│  ├─ renderer/        # 主界面（index.html / styles.css / app.js）
│  ├─ capture/         # 隐藏的采集页面：desktopCapturer + MediaRecorder
│  └─ overlay/         # 区域框选覆盖层
├─ assets/             # 应用图标、托盘图标
├─ docs/               # 使用说明、架构、构建文档、截图
├─ scripts/            # 打包 / 签名 / 自测 / 截图脚本
└─ .github/workflows/  # Windows 构建 CI
主进程与渲染进程之间的 IPC 契约见 docs/ipc-contract.md，整体数据流见 docs/architecture.md。

工作原理
取画面：主进程用 desktopCapturer 枚举屏幕 / 窗口源，把 chromeMediaSourceId 交给隐藏的采集窗口。
采集：采集窗口调用 getUserMedia，video 用 chromeMediaSource: 'desktop'，audio 同样走 desktop 通道拿到系统声音（loopback）。
区域录制：仍采集整屏，再用 canvas 按物理像素裁剪后 canvas.captureStream()，因此框选区域不受 DPI 缩放影响。
窗口录制：优先直接用窗口源；部分系统/应用不允许时，回退为整屏采集后按窗口 bounds 裁剪。
编码与落盘：MediaRecorder 每秒产出数据块，经 IPC 交给主进程顺序写入临时文件；停止后用 ffmpeg 做无损转封装（不重新编码），再写入素材库。
已知限制
仅支持 Windows；整屏录制当前针对主显示器（多屏录制未实现）
无摄像头画中画、无剪辑 / 拼接 / 字幕功能
窗口录制在部分 UWP / 受保护内容窗口上可能失败，此时自动回退为整屏裁剪
系统声音依赖播放设备 loopback：没有活动输出设备时只能录到静音
打包产物内附带的 ffmpeg 为第三方二进制，其许可证约束见下一节
文档
docs/使用说明.md：面向用户的完整手册（三种模式、设置项、常见问题）
docs/architecture.md：进程模型、录制数据流、模块职责
docs/build.md：构建、打包、安装包、代码签名与 CI
docs/verification.md：1.0.0 的端到端验证记录与性能基准
docs/publish.md：把仓库发布到 GitHub、打 Release 的流程
docs/ipc-contract.md：主进程 ↔ 渲染进程 IPC 契约
CONTRIBUTING.md：参与开发的方式与规范
许可证与第三方组件
本项目源码以 MIT License 发布，见 LICENSE。

打包产物另含以下第三方组件，分发时请一并遵守其许可证：

组件	用途	许可证
Electron / Chromium	运行时	MIT / BSD 系
ffmpeg（@ffmpeg-installer 提供的二进制）	转封装与探测	该二进制由第三方构建，通常含 libx264（GPL），分发前请自行确认并遵守
图标与界面素材	本项目原创	随 MIT 发布
如果要把构建产物公开分发，建议先确认 ffmpeg 二进制对应的许可证义务（或替换为 LGPL 构建 / 系统 ffmpeg）。
