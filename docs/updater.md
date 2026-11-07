# 自动更新说明（NovaRec）

主进程模块：`src/main/updater.js`；渲染层入口：设置页「版本更新」区块；IPC 契约见 [ipc-contract.md](./ipc-contract.md)。

## 1. 工作方式

1. 启动 10 秒后静默检查一次（受 `settings.autoCheckUpdates` 控制，默认开启）；24 小时内不重复检查，结果写入 `userData/updates/state.json`。
2. 检查按以下渠道依次降级，每个渠道 8 秒超时，失败自动尝试下一个：

   | # | 渠道 | 地址 |
   | --- | --- | --- |
   | 1 | GitHub Release API 直连 | `https://api.github.com/repos/UesugiEri-1/NovaRec/releases/latest` |
   | 2 | gh-proxy 镜像 API | `https://gh-proxy.com/https://api.github.com/repos/UesugiEri-1/NovaRec/releases/latest` |
   | 3 | 仓库 version.json | `https://raw.githubusercontent.com/UesugiEri-1/NovaRec/main/version.json` |
   | 4 | gh-proxy 镜像 version.json | `https://gh-proxy.com/https://raw.githubusercontent.com/UesugiEri-1/NovaRec/main/version.json` |
   | 5 | jsDelivr CDN | `https://cdn.jsdelivr.net/gh/UesugiEri-1/NovaRec@main/version.json` |

3. 用 `app.getVersion()` 与远端版本做语义化比较（支持 `v1.2.3`、`1.2.3-beta.1`），只有远端更高才提示更新。
4. 下载优先选择 Release assets 中匹配 `/NovaRec-Setup-.*x64\.exe$/i` 的安装包；`github.com` 直连失败时自动改写为 `https://gh-proxy.com/https://github.com/...` 重试。下载文件保存到 `userData/updates/`。
5. 下载完成后由用户点击「安装并重启」→ 原生确认框 → `shell.openPath(安装包)` → 应用退出，安装包覆盖安装。

## 2. 发布新版本（仓库维护者）

### 方式 A：GitHub Release（推荐，无需 version.json）

1. 修改 `package.json` 的 `version`（与安装包版本一致）。
2. 打包安装包：`npm run build:installer`，产物为 `artifacts/installer/NovaRec-Setup-<version>-x64.exe`。
3. 在 GitHub 仓库创建 Release，tag 形如 `v1.2.0`（`v` 可省略），**上传安装包并把资产名保持 `NovaRec-Setup-<version>-x64.exe`**（更新器正则依赖该命名）。
4. Release 说明（body）会作为更新说明展示在设置页。

### 方式 B：仓库根目录 version.json（无需 Release）

在仓库默认分支根目录放置 `version.json`：

```json
{
  "version": "1.2.0",
  "notes": "修复若干问题；新增 xx 功能。",
  "url": "https://github.com/UesugiEri-1/NovaRec/releases",
  "assets": [
    {
      "name": "NovaRec-Setup-1.2.0-x64.exe",
      "browser_download_url": "https://github.com/UesugiEri-1/NovaRec/releases/download/v1.2.0/NovaRec-Setup-1.2.0-x64.exe"
    }
  ]
}
```

说明：

- `assets` 可省略；若省略且 `url` 直接指向 `.exe`，会把 `url` 当作安装包下载地址。
- 资产名同样要匹配 `NovaRec-Setup-*-x64.exe`，否则会回退选择第一个 `.exe`。
- jsDelivr 有缓存（通常数小时），刚推送 version.json 时可能仍读到旧版本；GitHub raw 渠道不受影响。

> 注意：`version.json` 是**远端仓库**的文件，本地工程根目录不需要放置；如果放，也请勿把它打进安装包。

## 3. 手动验证

### 3.1 设置页手动检查

打开「设置 → 版本更新」，点击「检查更新」：

- 检查中：状态显示「正在检查更新…」；
- 已是最新：显示「已是最新版本 vX.Y.Z」；
- 发现新版本：展开更新说明，提供「下载并安装」「查看发布页」「跳过此版本」；
- 下载中：显示百分比进度；
- 失败：显示中文错误（见第 6 节）。

### 3.2 开发者控制台

```js
// 检查（不弹 UI，直接返回结果）
await window.nova.updates.check();
// 下载（先 check 且 hasUpdate 才允许）
await window.nova.updates.download();
// 安装（会弹原生确认框）
await window.nova.updates.install();
// 当前版本
await window.nova.updates.getCurrentVersion();
```

### 3.3 模拟「有新版本」而不发 Release

1. 关闭应用，编辑 `userData/settings.json`：`"autoCheckUpdates": false`（避免后台干扰）。
2. 在仓库根目录临时新建 `version.json`（内容同上，版本号高于当前），提交并推到 `main`（本工程开发时可用任意 HTTPS 静态地址替代，但渠道地址是写死的，需改代码或用测试脚本注入 fetch）。
3. 重新打开应用 → 设置页 → 检查更新。

> 纯逻辑验证推荐直接跑 `node scripts/test-updater.mjs`（注入 fetch，不联网）。

## 4. 测试

```bash
# 纯 Node 单元测试（33 项，全部通过才 exit 0）
node scripts/test-updater.mjs

# 加载冒烟：确认模块在无 Electron 环境下也能 require（electron 惰性加载）
node -e "require('./src/main/updater.js'); console.log('load ok')"
```

测试覆盖：语义化版本比较/预发布、5 个渠道的地址与降级顺序、渠道超时、version.json 解析、资产选择优先级、URL 白名单、镜像改写、下载进度、Content-Length 校验、非 .exe / 非白名单拒绝、安装取消与异常。

## 5. 安全策略

- 所有请求仅允许 `https:`。
- 下载域名白名单：`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`github-releases.githubusercontent.com`、`codeload.github.com`、`raw.githubusercontent.com`、`gh-proxy.com`、`cdn.jsdelivr.net`。
- 安装包文件名必须以 `.exe` 结尾；写入 `.part` 临时文件，校验通过后才改名。
- 校验 `Content-Length`（或资产声明大小）与实际字节数一致；拒绝 `text/html` 等明显非安装包响应。
- 不会静默安装：必须用户确认后才 `shell.openPath` 并退出。

## 6. 常见错误与排查

| 提示 | 原因 | 处理 |
| --- | --- | --- |
| 未找到发布版本信息：GitHub 仓库还没有 Release，也没有 version.json | 5 个渠道都返回 404（仓库没发版/没 version.json） | 按第 2 节发布 Release 或 version.json |
| 检查更新失败：更新服务器返回异常（已尝试 GitHub 直连、镜像与备用源） | 渠道返回非 200/404（限流、5xx 等） | 稍后重试；查看 `dev.log` 中每个渠道的 `errorDetails` |
| 检查更新失败：无法连接更新服务器，请检查网络后重试 | 网络不通/DNS/证书问题 | 检查网络与代理 |
| 下载失败：不安全的下载地址 | URL host 不在白名单 | 确保资产地址来自 GitHub/镜像 |
| 下载不完整（X / Y 字节） | 网络中断或 Content-Length 不符 | 重试下载 |

自动检查失败只写 `userData/dev.log`（形如 `updater check failed: ...`），不会打扰用户。

## 7. 已知限制

- 安装包**未代码签名**（发布流程如需签名见 `docs/publish.md` 与 `scripts/create-cert.ps1`），Windows SmartScreen 可能提示未知发布者。
- `gh-proxy.com`、`cdn.jsdelivr.net` 均为第三方镜像/CDN，会看到请求的仓库路径；介意隐私可只发 Release 并依赖直连。
- 应用退出后再由安装包覆盖安装；若安装包需要管理员权限，会弹 UAC。
- 自动更新不会强制安装，也不支持增量更新/静默更新，只做「提示 + 手动确认」。
- 若上游仓库改名/迁移，需要同步修改 `src/main/updater.js` 里的 `REPO` 常量与渠道地址。
- Electron 主进程 `fetch` 受系统代理影响；本机若设置了系统代理，请求会走代理。
