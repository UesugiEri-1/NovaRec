# 发布 v1.1.0（让自动更新可用）

自动更新器读取的是 **GitHub 上的上游仓库**（`UesugiEri-1/NovaRec`），与本地代码是否推送无关。
只要满足下面任一情况，客户端「检查更新」就能工作。

## 当前上游仓库状态（已核实）

- `https://github.com/UesugiEri-1/NovaRec` 的 `main` 分支已有内容（通过网页上传的 1.0.0 源码，含
  `novarec-1.0.0/` 与 `novarec-1.0.0-source.zip`），与本地 git 历史无关（两条独立历史）。
- 仓库 **尚无 Release**，因此更新器目前会返回中文提示「未找到发布版本信息」。
- 本机 `git` 已配置 remote `origin`，但未登录 GitHub（`gh auth status` 未登录），所以本会话无法代为推送/发版。

## 方式 A：创建 Release（推荐，两步完成，无需 Git 登录）

1. 打开 `https://github.com/UesugiEri-1/NovaRec/releases/new`
2. Tag 填 `v1.1.0`（新建 tag），标题填 `NovaRec v1.1.0`
3. 说明直接复制 `artifacts/release-v1.1.0/release-notes-v1.1.0.md` 的内容
4. 上传附件 `artifacts/release-v1.1.0/NovaRec-Setup-1.1.0-x64.exe`
   （**资产名必须保持这个名字**，更新器用 `/NovaRec-Setup-.*x64\.exe$/i` 匹配下载地址）
5. 发布。至此客户端检查更新 → 下载 → 立即安装 全链路可用。

> 如需同时提供便携版，可再上传 zip 与 Portable.exe；更新器优先选安装包。

## 方式 B：更新仓库根目录 version.json（无 Release 时的回退渠道）

把 `artifacts/release-v1.1.0/version.json` 上传/覆盖到仓库 `main` 分支根目录（网页 Edit 即可）。
更新器在 Release API 失败后会依次尝试 raw.githubusercontent.com → gh-proxy 镜像 → jsDelivr。

注意：jsDelivr 有缓存（通常数小时）；GitHub raw 渠道不受影响。

## 方式 C：推送源码（可选）

本地提交为 `66e1547`（tag `v1.1.0`），与上游是两段独立历史，直接 `git push origin main` 会被拒绝。
两种安全做法：

```bash
# 推到一个新分支，保留上游 main 不动
git push origin refs/heads/main:refs/heads/v1.1.0-source

# 或用本地历史覆盖上游 main（会改写上游历史，谨慎）
git push --force-with-lease origin main
```

需要先完成 GitHub 认证（`gh auth login` 或用 Git Credential Manager 登录一次）。

## 校验

```
SHA256(NovaRec-Setup-1.1.0-x64.exe) = c27146b77526f0fd4f6e05afc006b5548f455709b0f314e7e1d3575fcfc29191
SHA256(version.json)               = 497999fd4a9c042a9075d89e99248b16c8d28d6f9028d17ad9ea9354ce257e86
```
