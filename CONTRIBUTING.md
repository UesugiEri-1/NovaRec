# 参与贡献

感谢你愿意改进 NovaRec。请先读完下面的约定，能让协作顺畅很多。

## 开发环境

- Windows 10 / 11 x64，Node.js 20+
- `npm ci` 后按 README 的说明补装 Electron 二进制
- 调试启动：`npm start`；沙箱受限环境用 `npm run start:nosandbox`

## 代码风格

- 代码注释、界面文案使用**中文**，标识符用英文
- 缩进 2 空格，字符串优先双引号，语句结尾带分号
- 渲染层不引入任何 CDN / 外部网络依赖，图标一律内联 SVG
- 主进程与渲染进程之间只通过 `src/preload/preload.js` 暴露的 `window.api` 通信；新增 IPC 请在 `docs/ipc-contract.md` 同步契约

## 提交前自检

1. `npm start` 能正常启动，三种模式各录一段 3 秒视频能正常出片（开声音时确认音轨存在）
2. `npm run selftest` 通过（自动录制三模式样片并校验音视频流）
3. 涉及界面的改动，跑 `npm run screenshot` 重新生成截图并肉眼确认
4. 不要提交 `node_modules/`、`artifacts/`、`.data*/`、`.certs/` 等目录（.gitignore 已覆盖）

## 提交信息

采用 Conventional Commits 风格，正文可用中文：

```text
feat: 支持区域录制时锁定宽高比
fix: 修复 125% 缩放下选框偏移
docs: 补充安装包签名说明
refactor: 抽离 ffmpeg 探测逻辑
```

## 提交 PR

- 一个 PR 只做一件事，描述里写清「改了什么 / 为什么 / 怎么验证的」
- 行为变化请附截图或录屏；修复类 PR 请写复现步骤
- 大改动请先开 Issue 讨论设计，避免白做

## 行为准则

保持友善、就事论事。技术分歧用数据和复现步骤说话，不针对个人。
