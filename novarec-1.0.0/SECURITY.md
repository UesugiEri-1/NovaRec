# 安全说明

## 报告漏洞

请不要在公开 Issue 中披露未修复的安全问题。请通过仓库的 **Security → Report a vulnerability**（GitHub Security Advisories）私下报告，并附上：

- 受影响的版本 / 提交
- 复现步骤与影响范围
- 如果可能，给出修复建议

我们会在 7 天内确认收到，并在修复后公开致谢（如果你愿意署名）。

## 安全设计说明

- 应用默认保持 Chromium 沙箱开启；仅在用户显式传 `--no-sandbox` 或设置 `NOVAREC_NO_SANDBOX=1` 时关闭
- 渲染进程禁用 `nodeIntegration`，全部能力经 `contextBridge` 白名单暴露
- 录制文件只写入用户指定的输出目录；不联网、无遥测、无账号体系
