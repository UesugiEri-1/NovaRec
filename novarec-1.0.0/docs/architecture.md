# 架构说明

## 1. 进程模型

```text
┌──────────────────────────── 主进程 (src/main) ────────────────────────────┐
│ main.js        应用生命周期、主窗口、托盘、全局快捷键、IPC 注册           │
│ sources.js     desktopCapturer 源枚举、窗口截图图标、窗口 bounds          │
│ recorder.js    录制状态机、临时文件、分片落盘、收尾入库                   │
│ ffmpeg.js      ffmpeg 定位、流探测、无损转封装                            │
│ store.js       settings.json / library.json 读写                          │
│ winbounds.js   窗口坐标与 DPI 换算、临时目录                              │
│ perf.js        性能模式判定（GPU / 内存）                                 │
└───────────┬─────────────────────────┬──────────────────────┬──────────────┘
            │ IPC (preload 白名单)    │ IPC                  │ IPC
┌───────────▼──────────┐  ┌───────────▼──────────┐  ┌────────▼─────────────┐
│ 渲染进程 UI          │  │ 采集窗口（隐藏）      │  │ 区域框选覆盖层        │
│ src/renderer        │  │ src/capture          │  │ src/overlay           │
│ 页面、状态、素材库   │  │ getUserMedia +       │  │ 全屏透明窗口、拖拽    │
│                     │  │ MediaRecorder        │  │ 选框、确认 / 取消     │
└─────────────────────┘  └──────────────────────┘  └───────────────────────┘
```

- 渲染进程全部关闭 `nodeIntegration`，能力通过 `src/preload/preload.js` 的 `contextBridge` 暴露为 `window.api`。
- 采集窗口是普通的 `BrowserWindow`（`show: false`、`backgroundThrottling: false`），只加载 `capture.html`，用户在界面上看不到它。

## 2. 录制数据流

1. **枚举源**：`desktopCapturer.getSources({ types: ['screen', 'window'] })` 得到 `screen:0:0`、`window:<hwnd>:0` 等 id 与缩略图。
2. **准备采集**：主进程把源 id、录制参数（帧率、码率、音频开关、区域矩形）发给采集窗口。
3. **取流**：采集窗口调用 `getUserMedia`：

```js
navigator.mediaDevices.getUserMedia({
  video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
                        maxWidth, maxHeight, maxFrameRate } },
  audio: wantSystemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false
})
```

   音频必须和 desktop video 在同一次调用中请求才能拿到 loopback 系统声音；单独请求 desktop 音频会让渲染进程崩溃。
4. **区域裁剪**：区域模式下仍然采集整屏，用 `canvas` 按**物理像素**裁剪（DIP 坐标 × scaleFactor），再 `canvas.captureStream(fps)` 作为视频轨。
5. **窗口模式**：优先直接用窗口源；若该系统/窗口不支持（`Could not start video source`），回退为整屏采集 + 按窗口 bounds 裁剪。
6. **混音**：麦克风轨与系统声音轨通过 WebAudio 合成为一条音频轨（都开时混音，单个开时直通）。
7. **编码**：`MediaRecorder` 以 `video/mp4;codecs=avc1,mp4a` 优先、WebM 兜底，`timeslice=1000` 每秒产出数据块。
8. **落盘**：数据块通过 IPC 交给主进程，按顺序追加写入临时文件（不走 Base64，直接传 ArrayBuffer）。
9. **收尾**：停止后主进程用 ffmpeg 做 **无损转封装**（`-c copy`），生成到输出目录，写入 `library.json`，通知界面刷新素材库。

## 3. 状态机

```text
idle ──start──> countdown(0/3/5s) ──> recording ⇄ paused ──stop──> finalizing ──> idle
                                          │
                                          └─ error ──> idle（toast 提示 + 清理临时文件）
```

- 停止快捷键 F9、暂停 F10 在录制期间全局生效（`globalShortcut`），退出录制后注销
- 暂停期间 `MediaRecorder.pause()`，计时器同步暂停，暂停时长不计入视频时长
- 主窗口在 recording 开始时隐藏，结束或出错时恢复

## 4. 文件与目录

数据目录（`<userData>`）按以下顺序确定：`NOVAREC_DATA_DIR` → 开发态 `<repo>/.data` → 打包态 exe 同级 `NovaRecData`（便携）→ 不可写时退回 Electron 标准 `%APPDATA%\NovaRec`。

| 位置 | 内容 |
| --- | --- |
| `<userData>\settings.json` | 用户设置（模式、音频、帧率、画质、格式、倒计时、保存目录） |
| `<userData>\library.json` | 素材库条目（路径、时长、尺寸、大小、缩略图、创建时间） |
| `<userData>\thumbs\` | 素材库缩略图 |
| `<userData>\temp\` | 录制中的临时分片，异常退出后清理 |
| 用户输出目录（默认「视频\NovaRec」） | 最终 mp4 / webm 文件 |

## 5. 关键设计取舍

- **为什么用隐藏窗口采集而不是主进程**：`getUserMedia` / `MediaRecorder` 只在渲染环境可用，主进程没有 Web API。
- **为什么主窗口要隐藏**：整屏录制会录到应用自己；隐藏后用户靠托盘与快捷键控制。
- **为什么用 canvas 做区域裁剪**：系统没有「只采集某矩形」的 API，整屏采集 + 裁剪是唯一稳定方案，也天然支持 DPI 缩放。
- **为什么 ffmpeg 只转封装**：`MediaRecorder` 产出的 MP4 大多可直接播放，转封装只在容器/索引不兼容时修正，避免二次编码损失画质与时间。
- **为什么初始化时放开 `--no-sandbox` 选项**：Chromium 沙箱在某些企业环境/虚拟机下不可用会导致进程静默退出，保留显式开关便于排障，但默认仍然开启沙箱。

IPC 的完整数据结构与调用约定见 [ipc-contract.md](ipc-contract.md)。
