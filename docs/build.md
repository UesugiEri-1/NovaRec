# 构建、打包与签名

本文档面向要自己构建 / 分发 NovaRec 的开发者。用户使用手册见 [使用说明.md](使用说明.md)。

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 1809+ / Windows 11，x64 |
| Node.js | 20 及以上（开发时使用 24.21.0 验证） |
| npm | 随 Node 附带即可（npm 12 有 postinstall 限制，见下） |
| 磁盘 | 源码 + 依赖约 600 MB，打包产物约 300 MB（便携目录）/ 94 MB（安装包） |

## 2. 首次准备

```bash
npm ci
node node_modules/electron/install.js
```

说明：

- **npm 12 默认不执行第三方包的 postinstall**，Electron 的二进制下载脚本不会自动跑，所以必须手动执行 `node node_modules/electron/install.js`。执行后 `node_modules/electron/dist/electron.exe` 应存在（约 350 MB）。
- GitHub 直连缓慢时用镜像：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
node node_modules/electron/install.js
```

- 本机若长期设置了 `ELECTRON_RUN_AS_NODE=1`，运行前要清掉，否则 electron.exe 会当 Node 解释器执行（表现为什么都不发生）：

```bash
set ELECTRON_RUN_AS_NODE=
npm start
```

## 3. 开发运行

```bash
npm start              # 正常启动
npm run start:nosandbox  # Chromium 沙箱在部分受限环境会导致 rc=3 直接退出
```

数据目录（优先级从高到低）：

1. `NOVAREC_DATA_DIR` 环境变量（绝对路径）
2. 开发态：`<repo>/.data`（日志 `dev.log`、设置、素材库 JSON、录制临时文件都在这里）
3. 打包态：exe 同级的 `NovaRecData`（便携模式，解压即用、不写系统盘）
4. 便携目录不可写时（例如安装进 `Program Files`）：Electron 标准 `%APPDATA%\NovaRec`，仍不可写则退回 `%APPDATA%\NovaRec`

> 便携优先是刻意的：绿色解压版把数据放在程序旁边，拷贝整个目录就能迁移；受限环境里也能避免个别安全软件拦截进程写系统盘。

## 4. 打便携版

```bash
npm run build          # 打包并生成 zip
npm run build:portable # 只生成目录，不打 zip
```

产物：

- `artifacts/dist/NovaRec-win32-x64/`（可直接运行 `NovaRec.exe`）
- `artifacts/NovaRec-1.1.0-win32-x64.zip`（v1.1.0 实测 135,971,874 B ≈ 129.7 MiB；dist 目录 299,022,765 B ≈ 285.1 MiB、19 个文件）

### 4.1 单文件便携 exe（免安装、双击即用）

```bash
npm run build:portable-exe        # = node scripts/make-portable.mjs
# 指定已有打包目录：
node scripts/make-portable.mjs --dir=artifacts/dist-v8/NovaRec-win32-x64 --out=artifacts/portable-v8
```

产物：`artifacts/portable-v8/NovaRec-Portable-1.1.0-x64.exe`（electron-builder `portable` target，7z 自解压，
v1.1.0 实测 96,685,191 B ≈ 92.2 MiB / 96.7 MB，`compression: "maximum"`）。适合不想安装、直接拷给别人的场景；
首次启动会解压到临时目录，启动略慢于安装版。脚本会把 `%TEMP%` 规范化到 `artifacts/.build-temp-portable`
（本机 `%TEMP%` 不可写时 NSIS 会失败）。

实现要点（`scripts/package.mjs`）：

- 用 `@electron/packager` 打包，`asar` 开启：v1.1.0 起生产依赖为 0（收尾是纯 JS 重封装），不再解包 node_modules、不再内置 ffmpeg.exe
- 打包时排除未使用的图标母版 `assets/icon-1024.png`、`icon-512.png`、`icon-128.png`（仅 `make-icons-v2.mjs` 生成用，asar 里省 1.24 MB）
- 排除 `artifacts/`、`docs/`、`scripts/`、`.data*`、`.certs` 等开发目录
- 打包后自动瘦身：locales 只留 zh-CN/en-US（删 53 个 pak，-47.7 MB）、删 dxcompiler.dll（WebGPU 用，-24.6 MB，已做三模式录制回归）；保留 vk_swiftshader/vulkan（软件光栅回退）与 Chromium 许可证文本
- 校验项同时检查：无 `app.asar.unpacked`、无 ffmpeg 依赖、asar 内含 mp4remux/webmfix/mediafix
- 显式指定 `assets/icon.ico` 作为 exe 图标
- zip 用系统自带 `C:\Windows\System32\tar.exe` 生成（不依赖 7-Zip）
- 首次打包需要 Electron 的 win32-x64 压缩包：优先复用 `.electron-cache/` 或 `%LOCALAPPDATA%\electron\Cache`；都没有时自动下载，直连 GitHub 失败会自动改用 npmmirror 镜像重试一次（也可用 `ELECTRON_MIRROR` 显式指定）

## 5. 打 NSIS 安装包

先确保已有便携版产物（安装包基于它构建，不会重新打包）：

```bash
npm run build
npm run build:installer
```

产物：`artifacts/installer-v8/NovaRec-Setup-1.1.0-x64.exe`（v1.1.0 实测 97,039,803 B ≈ 92.5 MiB / 97.0 MB；`compression: "maximum"` NSIS LZMA）

实现要点（`scripts/make-installer.mjs`）：

- 使用 `electron-builder` 的 build API，`prepackaged` 指向 `artifacts/dist/NovaRec-win32-x64`（本项目实际用 `--dir=artifacts/dist-v8/NovaRec-win32-x64`），不重复打包
- `compression: "maximum"`（NSIS LZMA）：同一份产物，安装包从 122 MB 级降到 94 MB
- NSIS 选项：非一键安装、允许改安装目录、创建桌面与开始菜单快捷方式、中文（zh_CN）+ 英文语言
- 打包工具（NSIS、winCodeSign）从镜像下载，脚本内已设 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- 临时目录被规范化到 `artifacts/.build-temp`：部分环境（含本机）`%TEMP%` 不可写，会导致 NSIS 解压失败

## 6. 代码签名

Windows 未签名 exe 会触发 SmartScreen「未知发布者」。仓库提供自签名流程，**仅适合内部测试**；公开分发请购买 OV/EV 代码签名证书，或使用 Azure Trusted Signing 等云签名服务。

```powershell
# 1) 创建（或复用）自签名证书，公钥导出到 .certs/
npm run cert

# 2) 给可执行文件签名（SHA256 + DigiCert 时间戳）
powershell -ExecutionPolicy Bypass -File scripts/sign-release.ps1 -Paths artifacts/dist/NovaRec-win32-x64/NovaRec.exe

# 3) 校验
powershell -ExecutionPolicy Bypass -File scripts/verify-sign.ps1 -Paths artifacts/dist/NovaRec-win32-x64/NovaRec.exe
```

- 签名必须发生在**打安装包之前**：electron-builder 会把已签名的 exe 装进安装包
- 安装包本身也建议再签一次：`-Paths artifacts/installer-v8/NovaRec-Setup-1.1.0-x64.exe`
- v1.1.0 的构建产物未签名（构建环境未配置证书）；需要时用上面的命令补签
- 自签名证书在别的机器上默认不被信任；测试机可执行 `scripts/trust-cert.ps1` 把它加入「受信任的根证书颁发机构」，验收完用 `scripts/untrust-cert.ps1` 移除
- `.certs/` 已在 .gitignore 中，**绝不要把私钥 / pfx 提交到仓库**

## 7. 校验产物

```bash
npm run verify   # 检查打包目录里的关键文件（main.js、asar、图标等）是否齐全
node scripts/verify-packaged-record.mjs --exe artifacts/dist-v8/NovaRec-win32-x64/NovaRec.exe  # 打包产物三模式录制 + 系统声音端到端验证
node scripts/measure-startup.mjs --exe artifacts/dist-v8/NovaRec-win32-x64/NovaRec.exe --runs 2  # 冷/热启动耗时（CDP）
node scripts/perfbench.mjs  # 录制期性能基准（CPU/内存/掉帧/收尾耗时）→ artifacts/perfbench/
```

手动冒烟测试建议：

1. 双击 `NovaRec.exe`，确认窗口正常出现、无控制台窗口
2. 三种模式各录 3 秒，确认文件在素材库出现且能播放
3. 开系统声音录一段有声音的内容，播放确认有声音
4. 托盘菜单、F9 / F10 快捷键、关闭窗口后的单实例行为
5. 安装包：安装 → 启动 → 卸载，确认无残留进程

## 8. CI

`.github/workflows/build.yml` 在 GitHub Actions 的 `windows-latest` 上执行：安装依赖 → 补装 Electron → `npm run build` → 上传 zip 作为 artifact。安装包与签名需要证书，默认不在 CI 中执行。

## 9. 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| `npm ci` 后 Electron 启动报找不到二进制 | npm 12 阻止 postinstall，手动跑 `node node_modules/electron/install.js` |
| 进程立刻退出、无窗口、无日志 | 环境里有 `ELECTRON_RUN_AS_NODE=1`，先清掉 |
| 退出码 3、没有任何输出 | Chromium 沙箱不可用，用 `--no-sandbox` 或 `NOVAREC_NO_SANDBOX=1` |
| 打包时报 `EBUSY` / 无法写入 app.asar | 有旧进程仍占用产物，结束 `NovaRec.exe` 后重试 |
| 安装包构建失败在 NSIS 下载 | 网络问题，确认能访问 npmmirror；或预置 `ELECTRON_BUILDER_BINARIES_MIRROR` |
| 录制完成后文件为 0 字节 / 收尾失败 | 临时目录或输出目录不可写，或被杀软隔离；检查 `dev.log` 里的 `[recorder] remux` / `finalize` 日志 |
| 杀软报毒 | 未签名 + Electron 常见误报，签名或加白名单 |
