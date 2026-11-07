# scripts 目录说明

| 脚本 | 作用 | 用法 |
| --- | --- | --- |
| `package.mjs` | 用 @electron/packager 打便携版目录，可选打 zip | `npm run build`（= `--zip`）|
| `make-installer.mjs` | 用 electron-builder 把便携版目录打成 NSIS 安装包 | `npm run build:installer` |
| `make-portable.mjs` | 用 electron-builder 打成单文件便携 exe（7z 自解压） | `npm run build:portable-exe` |
| `make-icons-v2.mjs` | 用 Electron 渲染 SVG 生成多尺寸 PNG / ICO 图标 | `npm run icons` |
| `selftest.mjs` | 三种模式端到端录制自测，校验视频与音轨 | `npm run selftest` |
| `verify-packaged-record.mjs` | 启动打包产物，经 CDP 驱动三模式真实录制并校验 | `node scripts/verify-packaged-record.mjs --exe <exe>` |
| `perfbench.mjs` | 录制性能基准（8 场景 × 时长，CPU/帧率/掉帧/主线程延迟） | `npm run perfbench` |
| `measure-startup.mjs` | 启动耗时打点（冷/热各多次，输出 JSON） | `npm run measure-startup` |
| `test-updater.mjs` | 自动更新器离线单测（版本比较、渠道降级、节流、校验） | `node scripts/test-updater.mjs` |
| `audio-state.ps1` | 供 selftest 检测系统音频端点（是否静音） | 由 selftest 内部调用 |
| `screenshot.mjs` | 离屏渲染各页面并导出 UI 截图到 `artifacts/ui` | `npm run screenshot` |
| `create-cert.ps1` | 创建自签名代码签名证书并导出公钥 | `powershell -File scripts/create-cert.ps1` |
| `sign-release.ps1` | 对 exe 签名（SHA256 + 时间戳） | `powershell -File scripts/sign-release.ps1 -Paths <exe>` |
| `verify-sign.ps1` | 校验签名状态与签名者 | `powershell -File scripts/verify-sign.ps1 -Paths <exe>` |
| `verify-packaged.ps1` | 校验打包产物关键文件是否齐全 | `npm run verify` |
| `trust-cert.ps1` / `untrust-cert.ps1` | 本机信任 / 取消信任自签名证书（仅内部测试） | `powershell -File ...` |

约定：所有脚本都从仓库根目录解析路径，产物统一写入 `artifacts/`（已在 .gitignore 中）。
