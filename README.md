# NovaRec 1.0.0 — 开源仓库交付

本目录是 NovaRec（Windows 桌面录屏软件）的仓库化交付物，包含**源码包**和**可直接运行的便携版**。

## 交付清单

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `novarec-1.0.0-source.zip` | 约 2.4 MB | 完整开源仓库源码（`git archive` 导出，解压即得干净仓库，不含 node_modules / 构建产物 / 个人数据） |
| `NovaRec-1.0.0-win32-x64-portable.zip` | 约 181 MB | 已构建好的 Windows x64 便携版，解压后双击 `NovaRec.exe` 即可使用，无需安装 |
| `NovaRec-Setup-1.0.0-x64.exe` | 约 128 MB | **Windows 安装包**（NSIS，中文/英文双语向导）。双击安装，可选安装目录、创建桌面/开始菜单快捷方式，带卸载程序 |
| `NovaRec-win32-x64\` | 约 421 MB | 便携版**已解压好的文件夹**，直接双击里面的 `NovaRec.exe` 就能运行（等同于解压上面那个 zip） |

仓库本体（含 git 历史）在 `D:\Workplace\novarec`，已初始化 git（分支 `main`，单条提交 `feat: NovaRec 1.0.0 初始开源发布`），可直接作为远端仓库内容推送。

## 源码包结构

```
novarec-1.0.0/
├── src/
│   ├── main/          # 主进程：窗口/托盘/快捷键/IPC/录制编排/素材库/ffmpeg 封装
│   ├── preload/       # 渲染进程上下文桥
│   ├── renderer/      # 主界面（录制 / 素材库 / 设置）
│   ├── capture/       # 隐藏采集窗口（getUserMedia + MediaRecorder）
│   └── overlay/       # 区域框选覆盖层
├── assets/            # 应用图标（PNG / ICO / 托盘图标）
├── docs/              # 使用说明.md、architecture.md、build.md、publish.md、verification.md、ipc-contract.md、截图
├── scripts/           # 打包、安装包、签名、图标生成、自测、截图脚本
├── .github/           # GitHub Actions 构建工作流 + Issue 模板
├── README.md          # 项目介绍（含截图、运行方式、工作原理、已知限制）
├── CONTRIBUTING.md / CHANGELOG.md / SECURITY.md
└── LICENSE            # MIT
```

## 使用方式

**直接使用便携版**：解压 `NovaRec-1.0.0-win32-x64-portable.zip`，双击 `NovaRec.exe`（本目录里已有解压好的 `NovaRec-win32-x64\` 文件夹，可直接运行）。
数据（设置、素材库、临时文件）保存在 exe 同级的 `NovaRecData` 目录，整个文件夹可随意移动/拷贝；录好的视频默认保存到 `视频\NovaRec`。

**使用安装包**：双击 `NovaRec-Setup-1.0.0-x64.exe`，按向导选择安装目录（默认当前用户目录，无需管理员），可选是否创建桌面/开始菜单快捷方式；卸载用「设置 → 应用 → NovaRec 录屏」或安装目录里的 `Uninstall NovaRec.exe`。
安装包为自签名证书签名，Windows SmartScreen 可能提示「未知发布者」，点「仍要运行」即可；安装包内置的程序为同一套便携布局，安装目录可写时数据保存在安装目录下的 `NovaRecData`，不可写时自动退回 `%APPDATA%\NovaRec`。

**从源码运行**（需要 Node.js ≥ 20）：

```bash
npm ci
node node_modules/electron/install.js   # npm 12 默认拦截 postinstall，需手动执行一次
npm start                               # 若环境因 Chromium 沙箱退出，改用 npm run start:nosandbox
```

**重新打包**：

```bash
npm run build             # 便携版目录 + zip（artifacts/）
npm run build:installer   # NSIS 安装包（artifacts/installer/）
```

详细步骤见 `docs/build.md`；发布到 GitHub 的步骤见 `docs/publish.md`（其中 `<your-org>` 需替换成实际账号/组织名）。

## 本轮验证记录

- **构建**：`node scripts/package.mjs --out=artifacts/dist-v2` 成功，产物 85 个文件 / 约 421 MB，包含 `NovaRec.exe`、`app.asar`、内置 ffmpeg。
- **打包版启动**：便携目录 `NovaRecData` 生效，日志 `[novarec] ready, userData=...\NovaRecData output=C:\Users\<用户>\Videos\NovaRec`，窗口正常创建。
- **录制自测**（`npm run selftest`，三模式端到端，含系统声音）：
  - 全屏：`1920x1080`，3.3s，3.0 MB，音轨 ✓，mp4 remux ✓
  - 区域：`1000x750`，3.8s，1.5 MB，音轨 ✓，mp4 remux ✓
  - 窗口：`1004x754`，3.8s，1.6 MB，音轨 ✓，mp4 remux ✓
  - 结果 `ok: true`，暂停/恢复、倒计时、素材库入库均通过。
- **数据目录兼容性修复**：打包版原先写 `%APPDATA%\NovaRec`，在受安全软件限制的机器上会被拒绝导致启动失败；已改为**便携优先**（exe 同级 `NovaRecData` → 不可写时退回标准 userData → 再退回 `%APPDATA%\NovaRec`），并在 README / docs/build.md / docs/architecture.md 同步说明。

## 发布到 GitHub

```bash
cd D:\Workplace\novarec
# 1) 把 README.md / docs/publish.md 里的 <your-org> 替换为真实账号
git remote add origin https://github.com/<your-org>/novarec.git
git push -u origin main
git tag v1.0.0 && git push origin v1.0.0
# 2) 在 GitHub Releases 里上传 NovaRec-1.0.0-win32-x64-portable.zip
```

## 注意

- 内置 ffmpeg 来自 `@ffmpeg-installer/ffmpeg`（GPL 许可），分发给第三方时请随附其许可证并按 GPL 义务处理；仓库 README 的「许可证与第三方组件」一节已注明。
- 便携版未做商业代码签名（仓库提供自签名脚本 `npm run cert` 与 `scripts/sign-release.ps1` 供内部测试）；Windows SmartScreen 可能提示「未知发布者」，属正常现象。
- 本机验证环境为 Windows 10 19045；Windows 11 未逐项复测，但代码路径一致。
