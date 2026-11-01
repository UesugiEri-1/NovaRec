# NovaRec IPC 契约（前端 / 主进程）

前端通过 preload 暴露的全局对象 `window.novarec` 调用主进程。
所有方法返回 Promise；失败时 reject（Error.message 为中文提示）。

## 数据模型

```ts
type Settings = {
  outputDir: string;          // 录制文件保存目录（绝对路径）
  format: 'mp4' | 'webm';     // 保存格式，默认 mp4
  fps: 30 | 60;               // 帧率，默认 30
  quality: 'standard' | 'high' | 'ultra'; // 画质，默认 high
  systemAudio: boolean;       // 录制系统声音，默认 true
  microphone: boolean;        // 录制麦克风，默认 false
  micDeviceId: string;        // 'default' 或设备 deviceId
  countdown: 0 | 3 | 5;       // 开始前倒计时秒数，默认 3
  hideMainWindow: boolean;    // 屏幕/区域录制时隐藏主窗口，默认 true
  showCursor: boolean;        // 预留，默认 true
};

type CaptureSource = {
  id: string;                 // Electron desktopCapturer source id，如 'screen:0:0' / 'window:123:0'
  name: string;               // 屏幕名或窗口标题
  displayId?: string;         // 屏幕的 display_id
  thumbnailDataUrl?: string;  // data:image/png;base64,...（缩略图）
  appIconDataUrl?: string;    // 窗口应用图标
  appName?: string;           // 窗口所属应用名（粗略解析）
  isScreen: boolean;
};

type Region = { x: number; y: number; width: number; height: number; displayId?: string }; // DIP 坐标

type Mode = 'screen' | 'region' | 'window';

type RecordingItem = {
  id: string;
  filePath: string;
  fileName: string;
  format: 'mp4' | 'webm';
  mode: Mode;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  sizeBytes: number;
  hasAudio: boolean;          // 是否包含系统声音/麦克风
  hasMic: boolean;
  createdAt: number;          // epoch ms
  posterDataUrl?: string;     // 首帧缩略图（可能有）
};

type RecordingState = {
  state: 'idle' | 'countdown' | 'recording' | 'paused' | 'processing';
  mode?: Mode;
  sourceName?: string;
  startedAt?: number;
  elapsedMs: number;          // 已录制时长（暂停不计）
  countdownLeft?: number;     // countdown 时剩余秒数
};

type StartRequest = {
  mode: Mode;
  sourceId?: string;          // screen/window 模式必填
  region?: Region;            // region 模式必填
  fps?: number;
  quality?: Settings['quality'];
  format?: Settings['format'];
  systemAudio?: boolean;
  microphone?: boolean;
  micDeviceId?: string;
  countdown?: number;
  hideMainWindow?: boolean;
};
```

## API

### 设置
- `getSettings(): Promise<Settings>`
- `setSettings(patch: Partial<Settings>): Promise<Settings>` — 合并保存，主进程广播 `settings:changed`
- `onSettingsChanged(cb: (s: Settings) => void): () => void` — 返回取消订阅函数
- `chooseOutputDir(): Promise<Settings | null>` — 打开目录选择框，null 表示取消
- `openOutputDir(): Promise<void>`
- `getAppInfo(): Promise<{ name: string; version: string; electron: string; ffmpeg: boolean }>`

### 采集源
- `listSources(): Promise<{ screens: CaptureSource[]; windows: CaptureSource[] }>` — 缩略图为 480x270
- `getDisplayInfo(): Promise<{ displays: Array<{ id: number; bounds: Region; scaleFactor: number; primary: boolean }>; virtualBounds: Region }>`

### 区域选择
- `selectRegion(): Promise<Region | null>` — 弹出全屏框选层，返回 DIP 区域；用户取消返回 null
- `hasRegion(): boolean`（同步，可能为 undefined，前端自行兼容）

### 录制控制
- `startRecording(req: StartRequest): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>`
- `stopRecording(): Promise<void>`
- `togglePause(): Promise<{ paused: boolean }>`
- `getRecordingState(): Promise<RecordingState>`
- `onRecordingState(cb: (s: RecordingState) => void): () => void` — 状态/计时推送（录制中约每 500ms 一次）
- `onRecordingSaved(cb: (item: RecordingItem) => void): () => void` — 录制完成并保存后
- `onRecordingError(cb: (msg: string) => void): () => void`
- `onToast(cb: (t: { type: 'info' | 'success' | 'warning' | 'error'; message: string }) => void): () => void`

### 素材库
- `listRecordings(): Promise<RecordingItem[]>`（按时间倒序）
- `deleteRecording(id: string): Promise<boolean>`
- `revealRecording(id: string): Promise<void>` — 在资源管理器中定位
- `openRecording(id: string): Promise<void>` — 用系统默认播放器打开

### 窗口
- `window.minimize(): Promise<void>`
- `window.toggleMaximize(): Promise<boolean>` — 返回最大化后的状态
- `window.close(): Promise<void>`
- `window.isMaximized(): Promise<boolean>`
- `window.onMaximizedChange(cb: (maximized: boolean) => void): () => void`

## 行为约定
1. 录制流程：`startRecording` 成功后主进程先倒计时（countdown），再隐藏主窗口（屏幕/区域模式且 hideMainWindow=true），随后开始采集；`onRecordingState` 会推 countdown → recording → processing → idle。
2. 录制中主窗口可能被隐藏；素材/状态以 tray 与快捷键控制（F9 停止 / F10 暂停）。前端无需额外实现。
3. 录制完成后主进程自动显示主窗口并广播 `recording:saved`，前端应刷新素材库并提示成功。
4. 录制失败（如系统声音不可用）通过 `onToast` 警告，录制可继续（无声音）。
5. 前缀 `window.novarec` 可能不存在（浏览器预览）；前端必须提供 mock 实现以便无 Electron 环境预览 UI。
6. 不要引入任何外部 CDN / 网络字体；全部离线可用。图标使用内联 SVG。
