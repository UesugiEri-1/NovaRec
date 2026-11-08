# 发布指南

本仓库可以直接发布到 GitHub。下面是从本地仓库推到公开 Release 的完整流程。

## 1. 替换仓库地址占位符

仓库里的链接目前用 `<your-org>` 占位。把仓库地址确定后，全局替换一次：

```bash
cd novarec
grep -rl "<your-org>" . --include="*.md" --include="*.yml" | xargs sed -i 's|<your-org>|你的GitHub用户名|g'
```

需要替换的文件：`README.md`、`.github/ISSUE_TEMPLATE/config.yml`。

## 2. 初始化并推送到 GitHub

先在 GitHub 网页上创建一个空仓库（**不要**勾选自动生成 README / .gitignore / License），然后：

```bash
cd novarec
git init -b main
git add -A
git commit -m "feat: NovaRec 1.0.0 初始开源发布"
git remote add origin https://github.com/<your-org>/novarec.git
git push -u origin main
git tag -a v1.0.0 -m "NovaRec 1.0.0"
git push origin v1.0.0
```

## 3. 生成分发包

```bash
npm ci
node node_modules/electron/install.js
npm run build            # 便携版目录 + zip
npm run build:installer  # NSIS 安装包（可选）
```

产物：

- `artifacts/NovaRec-1.0.0-win32-x64.zip`（便携版）
- `artifacts/installer/NovaRec-Setup-1.0.0-x64.exe`（安装包）

> 公开分发前请先给 exe 签名，并确认 ffmpeg 二进制的许可证义务，见 [build.md](build.md) 与 README 的「许可证与第三方组件」。

源码包（供下载后自行构建）：

```bash
git archive --format=zip --prefix=novarec-1.0.0/ -o artifacts/novarec-1.0.0-source.zip HEAD
```

## 4. 创建 Release

在 GitHub 仓库页面：**Releases → Draft a new release**

- Tag：选择已推送的 `v1.0.0`
- 标题：`NovaRec 1.0.0 · 免费开源的 Windows 录屏软件`
- 说明：从 [CHANGELOG.md](../CHANGELOG.md) 复制本版本条目
- 附件：便携版 zip、安装包 exe、源码包 zip
- 勾选 **Set as the latest release** 后发布

## 5. 可选：CI 自动构建

`.github/workflows/build.yml` 已在 push / PR 时构建便携版并上传 artifact。要让它随 tag 自动创建 Release，可在此基础上增加 `softprops/action-gh-release` 步骤，并把签名证书以 Secrets 形式注入（**不要**把证书或私钥提交进仓库）。

## 6. 发布前检查清单

- [ ] `git status` 干净，`node_modules/`、`artifacts/`、`.certs/` 没有被提交
- [ ] 仓库体积合理（源码仓库应在 5 MB 以内；截图约占大部分）
- [ ] README 顶部截图能正常显示
- [ ] LICENSE 年份与版权方正确
- [ ] 构建产物在本机双击可启动、三种模式各录一段通过
- [ ] Release 说明里写清系统要求与已知限制
- [ ] 如需商业分发，已用正规代码签名证书签名
