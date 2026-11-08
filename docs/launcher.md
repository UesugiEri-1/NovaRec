# 启动器架构（v1.1.1 起）

> 适用版本：1.1.1 及以上。相关源码：`scripts/launcher/NovaRecLauncher.cs`、`scripts/build-launcher.mjs`、`scripts/package.mjs`。

## 一、为什么需要启动器

在部分 Windows 机器上，标准 Electron 应用启动时 Chromium 沙箱初始化失败，进程会**立即退出**：没有任何窗口、没有错误弹窗，退出码是 `0x80000003`（STATUS_BREAKPOINT，十进制 2147483651）。这不是 NovaRec 的业务代码问题，用官方 electron.exe 跑一个只加载 `about:blank` 的最小主进程同样复现。

关键难点在于**崩溃发生在主进程 JS 执行之前**：

- `app.commandLine.appendSwitch("no-sandbox")` 写在 main.js 第一行也来不及生效（实测在崩溃前根本不会执行到）；
- `--enable-logging` / `--log-file` 也不会产生任何日志；
- 结论：必须由**进程外部**在命令行上带 `--no-sandbox`，应用自己救不了自己。

因此发布产物改成一个极小的原生启动器，由它负责带参数拉起真正的应用。

## 二、产物结构

```
NovaRec-win32-x64/
├─ NovaRec.exe          ← 启动器（C#，约 115 KB，用户双击的就是它）
├─ NovaRecApp.exe       ← 真正的 Electron 应用（约 238 MB）
├─ resources/app.asar   ← 应用代码
├─ locales/             ← 只保留 zh-CN / en-US
└─ 使用说明.md
```

- **安装包**（NSIS）与**单文件便携版**都是把整个目录打包，其快捷方式/启动项指向目录内的 `NovaRec.exe`，也就是启动器，因此用户装的、双击的永远是启动器；
- 启动器用 `--no-sandbox` 启动同目录的 `NovaRecApp.exe`，把用户传入的参数原样转发，然后**等待子进程退出并返回它的退出码**（单文件便携版的自解压清理依赖这一点）；
- 数据目录逻辑不变：`NovaRecApp.exe` 把 userData 放在产物目录下的 `NovaRecData`（便携式布局），升级时覆盖程序文件即可，数据保留。

## 三、启动器源码要点

`scripts/launcher/NovaRecLauncher.cs`（完整的 C# 程序，约 60 行）：

1. 取自身可执行文件所在目录，拼出 `NovaRecApp.exe` 路径；不存在则写 `launcher-error.log` 并返回 2；
2. 组装参数：固定前置 `--no-sandbox` 与 `--disable-gpu-sandbox`，再拼接用户传入的原始参数（含空格的参数按 Windows 规则加引号）；
3. `ProcessStartInfo { UseShellExecute = false, WorkingDirectory = 自身目录 }` 启动子进程；
4. `WaitForExit()` 后返回子进程的退出码；异常写 `launcher-error.log` 并返回 1。

设置 `UseShellExecute = false` 是为了让参数按原样传递、不经过 shell 解析；工作目录固定为启动器所在目录，保证 Electron 能找到 resources 与 locales。

## 四、构建流程

```bash
npm run build:launcher      # 只编译启动器到 assets/NovaRecLauncher.exe
npm run build               # 打包：自动先编译启动器，再安装进产物目录
```

- `scripts/build-launcher.mjs`：读 `package.json` 的 version，把 `AssemblyVersion` / `AssemblyFileVersion` 注入 C# 源码的临时副本（`artifacts/.launcher/`），用 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译（`/target:winexe /optimize+ /win32icon:assets/icon.ico`），输出到 `assets/NovaRecLauncher.exe`；
  - 只用系统自带的 .NET Framework 4 编译器，不引入任何新依赖；
  - 产物约 115 KB，远小于 Electron 本体；
- `scripts/package.mjs`：`@electron/packager` 打包完成后，把产物里的 `NovaRec.exe` 改名为 `NovaRecApp.exe`，再把启动器复制为 `NovaRec.exe`；打包检查会校验两者都存在、启动器字节数 < 4 MB、应用本体 > 50 MB；
- 安装包与便携版构建配置加了 `signAndEditExecutable: false`，避免 electron-builder 用 rcedit 改写启动器 exe（图标与版本信息已经由 csc 写进去了）。

## 五、安全影响

- `--no-sandbox` 关闭的是 Chromium 的进程沙箱。NovaRec 是**纯本地、离线**应用：界面只加载打包进 asar 的本地页面，不加载任何远程内容，也不执行第三方网页代码，因此关闭沙箱的实际风险很低；
- 应用仍是单实例、只监听本地回环端口（无网络监听），录制数据只写入用户选择的目录；
- 启动器本身只做「拼参数 + 启动 + 等待」，不访问网络、不写注册表。

## 六、排障

| 现象 | 排查 |
| --- | --- |
| 双击没反应 | 看安装目录是否生成 `launcher-error.log`（启动器自身异常，如找不到 NovaRecApp.exe）、`NovaRecData\dev.log`（应用启动日志） |
| 提示「找不到 NovaRecApp.exe」 | 杀毒软件隔离了应用本体；把安装目录加入信任或重新安装 |
| 便携版退出后临时目录残留 | 启动器必须等待子进程退出才返回；若残留请反馈，并附上 launcher-error.log |
| 想确认启动器是否生效 | 任务管理器中应看到 `NovaRec.exe`（启动器）与若干 `NovaRecApp.exe`（主进程 + Chromium 子进程） |

## 七、验证记录（本机，2026-11-08）

- 干净环境（不传任何参数）直接 spawn 产物中的 `NovaRec.exe`：进程正常存活，`NovaRecData\dev.log` 记录 bootstrap / window_shown / renderer_loaded，界面正常显示；
- `scripts/verify-packaged-record.mjs --exe artifacts/dist-v9/NovaRec-win32-x64/NovaRec.exe`：整屏 / 区域 / 窗口三种模式录制全部 PASS，MP4（H.264 + AAC）流信息正常，退出码 0；
- 安装包静默安装后从安装目录启动、单文件便携 exe 首次启动均通过；
- 对照实验：把启动器换回原版 `NovaRec.exe`（Electron 本体）后双击必现 0x80000003，确认是启动器解决了问题。
