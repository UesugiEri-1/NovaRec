"use strict";
// NovaRec 主进程入口：窗口、托盘、全局快捷键、IPC、区域框选、录制编排。
const electron = require("electron");
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, screen, nativeImage, session } = electron;
const fs = require("fs");
const path = require("path");
const storeMod = require("./store");
const sourcesApi = require("./sources");
const ffmpeg = require("./ffmpeg");
const recorderMod = require("./recorder");
const perfMod = require("./perf");

const APP_ROOT = path.join(__dirname, "..", "..");
const ASSETS = path.join(APP_ROOT, "assets");
const IS_DEV = !app.isPackaged;

// Chromium 沙箱默认保持开启。个别虚拟机 / 旧显卡 / 受限桌面环境里 Electron 可能因沙箱
// 直接退出（rc=3），此时可用 `--no-sandbox` 启动参数或 NOVAREC_NO_SANDBOX=1 显式关闭。
const WANT_NO_SANDBOX = process.env.NOVAREC_NO_SANDBOX === "1" || process.argv.indexOf("--no-sandbox") >= 0;
if (WANT_NO_SANDBOX) {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
}
// 老设备优化：隐藏窗口/最小化时不要把渲染节流到 1fps，也不要让 Chromium 因窗口遮挡关闭渲染
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-features", [
  "CalculateNativeWinOcclusion",   // 遮挡时不节流/不关渲染（录屏采集需要持续出帧）
  "Translate",                     // 不用内置翻译
  "MediaRouter",                   // 不用投屏路由
  "DialMediaRouteProvider",
  "GlobalMediaControls",           // 不用全局媒体控制条
  "HardwareMediaKeyHandling",
  "AutofillServerCommunication",   // 不联网取表单/密码类数据
  "OptimizationHints",             // 不下载优化提示模型
  "InterestFeedContentSuggestions",
  "WebRtcHideLocalIpsWithMdns"     // 桌面采集走 chromeMediaSource，不需要 mDNS 隐藏
].join(","));
// 启动期性能：Chromium 自带的一堆后台网络任务（组件更新、域可靠性上报、同步、pings）在
// 离线/受限网络（GitHub 不通、代理超时）时会拖慢首屏，录屏软件也用不到这些能力，直接关掉。
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("no-pings");
app.setName("NovaRec");
app.setAppUserModelId("com.novarec.app");

// 数据目录（必须在 requestSingleInstanceLock 之前确定并创建）：
//   1) NOVAREC_DATA_DIR 环境变量；
//   2) 开发态 <repo>/.data；
//   3) 打包态优先用 exe 同级的 NovaRecData（便携模式，解压即用、不写系统盘）；
//   4) 便携目录不可写（例如装进 Program Files）时退回 Electron 标准 userData，再退回 %APPDATA%\NovaRec。
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); return true; } catch (e) { return false; }
}
function isWritableDir(p) {
  try {
    if (!ensureDir(p)) return false;
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}
function pickUserDataDir() {
  if (process.env.NOVAREC_DATA_DIR) return path.resolve(process.env.NOVAREC_DATA_DIR);
  if (IS_DEV) return path.join(APP_ROOT, ".data");
  try {
    const portable = path.join(path.dirname(app.getPath("exe")), "NovaRecData");
    if (isWritableDir(portable)) return portable;
  } catch (e) {}
  try {
    const standard = app.getPath("userData");
    if (isWritableDir(standard)) return standard;
  } catch (e) {}
  const fallback = path.join(app.getPath("appData"), "NovaRec");
  ensureDir(fallback);
  return fallback;
}
const USER_DATA_DIR = pickUserDataDir();
try { app.setPath("userData", USER_DATA_DIR); } catch (e) {}
try { app.setPath("sessionData", USER_DATA_DIR); } catch (e) {}

// 保存目录兜底：部分机器（本机实测）有安全策略按「程序是否可信」拦截未签名程序写 C 盘，
// 默认的「视频\NovaRec」目录可能根本创建不了。这里按顺序探测，始终选一个真正可写的目录。
function writeProbe(p) {
  try {
    if (!ensureDir(p)) return false;
    const f = path.join(p, ".novarec-write-probe");
    fs.writeFileSync(f, "ok");
    fs.unlinkSync(f);
    return true;
  } catch (e) { return false; }
}
function pickOutputDir(preferred) {
  const list = [];
  if (preferred) list.push(preferred);
  list.push(path.join(USER_DATA_DIR, "recordings"));
  try { list.push(path.join(path.dirname(app.getPath("exe")), "recordings")); } catch (e) {}
  for (let i = 0; i < list.length; i++) {
    if (list[i] && writeProbe(list[i])) return { dir: list[i], changed: i > 0 };
  }
  return { dir: preferred || list[0], changed: false };
}

const DEV_LOG = path.join(USER_DATA_DIR, "dev.log");
function devLog(msg) {
  try { fs.appendFileSync(DEV_LOG, new Date().toISOString() + " " + msg + "\n"); } catch (e) {}
}
// 启动性能打点：BOOT_CREATION 是进程创建时刻，所有 mark 记「距进程创建多少 ms」
const BOOT_CREATION = (function () { try { return process.getCreationTime() || Date.now(); } catch (e) { return Date.now(); } })();
function perfMark(name) {
  const ms = Date.now() - BOOT_CREATION;
  devLog("perf " + name + "=" + ms + "ms");
  if (process.env.NOVAREC_PERF_LOG === "1") { try { console.log("[perf] " + name + "=" + ms + "ms"); } catch (e) {} }
  return ms;
}
process.on("uncaughtException", function (err) { devLog("uncaughtException: " + (err && err.stack || err)); });
process.on("unhandledRejection", function (err) { devLog("unhandledRejection: " + (err && err.stack || err)); });
devLog("boot userData=" + USER_DATA_DIR);

const GOT_LOCK = app.requestSingleInstanceLock();
if (!GOT_LOCK) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  devLog("bootstrap start");
  const state = {
    mainWindow: null,
    tray: null,
    recorder: null,
    settings: null,
    library: null,
    isQuitting: false,
    trayTip: "",
    trayIconKey: "",
    trayMenuKey: "",
    overlayWin: null,
    shortcutsRegistered: false
  };
  // 主窗口隐藏期间的录制状态广播缓存（重新显示时补发最后一次）
  const pendingBroadcasts = Object.create(null);

  const DEFAULT_SETTINGS = {
    outputDir: "",
    format: "mp4",
    fps: 30,
    quality: "high",
    systemAudio: true,
    microphone: false,
    micDeviceId: "default",
    countdown: 3,
    hideMainWindow: true,
    showCursor: true,
    performanceMode: "auto",
    autoCheckUpdates: true,
    skippedVersion: ""
  };

  function log() {
    const args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ["[novarec]"].concat(args));
  }

  function defaults() {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    out.outputDir = path.join(app.getPath("videos"), "NovaRec");
    return out;
  }

  function sanitize(patch) {
    const cur = state.settings.get();
    const next = Object.assign({}, cur);
    if (!patch || typeof patch !== "object") return next;
    const s = patch;
    if (typeof s.outputDir === "string" && s.outputDir.trim()) next.outputDir = s.outputDir.trim();
    if (s.format === "mp4" || s.format === "webm") next.format = s.format;
    if (s.fps !== undefined) { const n = Math.round(Number(s.fps)); if (isFinite(n)) next.fps = Math.max(10, Math.min(60, n)); }
    if (["low", "medium", "standard", "high", "ultra"].indexOf(s.quality) >= 0) next.quality = s.quality;
    ["systemAudio", "microphone", "hideMainWindow", "showCursor"].forEach(function (k) {
      if (s[k] !== undefined) next[k] = !!s[k];
    });
    if (typeof s.micDeviceId === "string" && s.micDeviceId) next.micDeviceId = s.micDeviceId;
    if (s.performanceMode === "auto" || s.performanceMode === "on" || s.performanceMode === "off") next.performanceMode = s.performanceMode;
    if (s.countdown !== undefined) { const n = Math.round(Number(s.countdown)); if (isFinite(n)) next.countdown = Math.max(0, Math.min(10, n)); }
    if (s.autoCheckUpdates !== undefined) next.autoCheckUpdates = !!s.autoCheckUpdates;
    if (typeof s.skippedVersion === "string") next.skippedVersion = s.skippedVersion.trim();
    return next;
  }

  function broadcast(channel, payload) {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    // 录制时主窗口是隐藏的：录制状态先缓存，等窗口重新显示时补发，避免对着不可见渲染进程白推消息
    if (!win.isVisible() && channel === "recording:state") {
      pendingBroadcasts[channel] = payload;
      return;
    }
    try { win.webContents.send(channel, payload); } catch (e) {}
  }

  function flushPendingBroadcasts() {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    Object.keys(pendingBroadcasts).forEach(function (ch) {
      try { win.webContents.send(ch, pendingBroadcasts[ch]); } catch (e) {}
      delete pendingBroadcasts[ch];
    });
  }

  function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
  }

  function showMainWindow() {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    flushPendingBroadcasts();
  }

  function createMainWindow() {
    const iconPath = path.join(ASSETS, "icon.png");
    const win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 1000,
      minHeight: 660,
      frame: false,
      show: false,
      backgroundColor: "#0e121a",
      title: "NovaRec",
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        webSecurity: true
      }
    });
    state.mainWindow = win;
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    win.webContents.once("did-finish-load", function () { perfMark("renderer_loaded"); });
    // v1.1.0 启动优化：不再等 ready-to-show（Chromium 建窗/首帧合成约 740ms）。
    // 窗口底色与首屏一致（#0e121a），先用底色立即显示再 180ms 淡入，感知启动提前约 600~700ms。
    try {
      win.setOpacity(0);
      win.show();
      perfMark("window_shown");
      let op = 0;
      const fade = setInterval(function () {
        if (!win || win.isDestroyed()) { clearInterval(fade); return; }
        op += 0.2;
        if (op >= 1) { clearInterval(fade); try { win.setOpacity(1); } catch (e) {} return; }
        try { win.setOpacity(op); } catch (e) { clearInterval(fade); }
      }, 30);
    } catch (e) {
      try { win.show(); } catch (e2) {}
    }
    win.once("ready-to-show", function () { perfMark("window_ready_to_show"); });
    win.on("maximize", function () { broadcast("win:maximized", true); });
    win.on("unmaximize", function () { broadcast("win:maximized", false); });
    win.on("close", function (event) {
      if (!state.isQuitting) {
        event.preventDefault();
        win.hide();
      }
    });
    win.webContents.setWindowOpenHandler(function () { return { action: "deny" }; });
    win.webContents.on("will-navigate", function (event) { event.preventDefault(); });
    win.webContents.on("render-process-gone", function (ev, details) {
      log("main renderer gone", details && details.reason);
    });
    return win;
  }

  // 托盘图标只解码一次：原先每次状态刷新都重新读盘 + resize
  const trayImageCache = { normal: null, recording: null };
  function trayImage(recording) {
    const key = recording ? "recording" : "normal";
    if (trayImageCache[key]) return trayImageCache[key];
    const p = path.join(ASSETS, recording ? "tray-recording.png" : "tray.png");
    const img = nativeImage.createFromPath(p);
    trayImageCache[key] = img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
    return trayImageCache[key];
  }

  function fmtClock(ms) {
    const total = Math.floor(Math.max(0, ms) / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function buildTrayMenu(recState) {
    const rec = recState || (state.recorder ? state.recorder.getState() : { state: "idle" });
    const recording = rec.state === "recording" || rec.state === "paused";
    const items = [
      { label: "显示 NovaRec 主界面", click: function () { showMainWindow(); } },
      { type: "separator" }
    ];
    if (recording) {
      items.push({ label: rec.state === "paused" ? "继续录制（F10）" : "暂停录制（F10）", click: function () { state.recorder.togglePause(); } });
      items.push({ label: "停止录制（F9）", click: function () { state.recorder.stop(); } });
    } else if (rec.state === "processing") {
      items.push({ label: "正在处理录像…", enabled: false });
    } else if (rec.state === "countdown") {
      items.push({ label: "开始录制中…", enabled: false });
    } else {
      items.push({ label: "开始录制", click: function () { startFromTray(); } });
    }
    items.push({ type: "separator" });
    items.push({ label: "打开保存目录", click: function () { openOutputDir(); } });
    items.push({ type: "separator" });
    items.push({ label: "退出 NovaRec", click: function () { quitApp(); } });
    return Menu.buildFromTemplate(items);
  }

  function refreshTray(recState) {
    if (!state.tray) return;
    const rec = recState || (state.recorder ? state.recorder.getState() : null);
    if (!rec) return;
    if (state.tray) {
      // 图标/菜单按需更新：状态没变化时不再重建原生菜单（每次重建都有可观的 JS→原生开销）
      const recording = rec.state === "recording" || rec.state === "paused";
      const iconKey = recording ? "rec" : "idle";
      if (state.trayIconKey !== iconKey) {
        state.trayIconKey = iconKey;
        try { state.tray.setImage(trayImage(recording)); } catch (e) {}
      }
      const menuKey = rec.state;
      if (state.trayMenuKey !== menuKey) {
        state.trayMenuKey = menuKey;
        state.tray.setContextMenu(buildTrayMenu(rec));
      }
      let tip = "NovaRec · 就绪";
      if (rec.state === "recording") tip = "NovaRec · 录制中 " + fmtClock(rec.elapsedMs);
      else if (rec.state === "paused") tip = "NovaRec · 已暂停 " + fmtClock(rec.elapsedMs);
      else if (rec.state === "countdown") tip = "NovaRec · 倒计时 " + (rec.countdownLeft || "");
      else if (rec.state === "processing") tip = "NovaRec · 正在保存";
      if (tip !== state.trayTip) {
        state.trayTip = tip;
        try { state.tray.setToolTip(tip); } catch (e) {}
      }
    }
  }

  function createTray() {
    try {
      state.tray = new Tray(trayImage(false));
      state.tray.setToolTip("NovaRec · 就绪");
      state.tray.setContextMenu(buildTrayMenu(null));
      state.tray.on("click", function () { showMainWindow(); });
      state.tray.on("double-click", function () { showMainWindow(); });
    } catch (e) {
      log("tray create failed", e && e.message);
    }
  }

  function syncShortcuts(recState) {
    const rec = recState || (state.recorder ? state.recorder.getState() : { state: "idle" });
    const active = rec.state === "countdown" || rec.state === "recording" || rec.state === "paused";
    if (active && !state.shortcutsRegistered) {
      try {
        globalShortcut.register("F9", function () { if (state.recorder) state.recorder.stop(); });
        globalShortcut.register("F10", function () { if (state.recorder) state.recorder.togglePause(); });
        state.shortcutsRegistered = true;
        log("global shortcuts registered (F9 stop / F10 pause)");
      } catch (e) { log("shortcut register failed", e && e.message); }
    } else if (!active && state.shortcutsRegistered) {
      try { globalShortcut.unregister("F9"); globalShortcut.unregister("F10"); } catch (e) {}
      state.shortcutsRegistered = false;
    }
  }

  async function startFromTray() {
    if (!state.recorder) return;
    const cur = state.recorder.getState();
    if (cur.state !== "idle") { showMainWindow(); return; }
    const settings = state.settings.get();
    const req = { mode: "screen", countdown: settings.countdown, fps: settings.fps, format: settings.format, quality: settings.quality, systemAudio: settings.systemAudio, microphone: settings.microphone, micDeviceId: settings.micDeviceId };
    const res = await state.recorder.start(req);
    if (res && res.ok === false && !res.cancelled) {
      showMainWindow();
      broadcast("toast", { type: "error", message: res.error || "开始录制失败" });
    }
  }

  function openOutputDir() {
    const dir = state.settings.get().outputDir;
    ensureDir(dir);
    shell.openPath(dir);
  }

  function quitApp() {
    state.isQuitting = true;
    app.quit();
  }

  // 封面缩略图缓存：素材库每次翻页/刷新都重复读同一张 jpg 并 base64，缓存后几乎零开销
  const posterCache = new Map();
  function posterDataUrl(item) {
    try {
      const p = item && item.posterPath;
      if (!p || !fs.existsSync(p)) return null;
      let key = p;
      try { const st = fs.statSync(p); key = p + "|" + st.mtimeMs + "|" + st.size; } catch (e) {}
      const hit = posterCache.get(key);
      if (hit) return hit;
      const url = "data:image/jpeg;base64," + fs.readFileSync(p).toString("base64");
      if (posterCache.size > 64) posterCache.clear();
      posterCache.set(key, url);
      return url;
    } catch (e) { return null; }
  }

  function toClientItem(item) {
    const out = Object.assign({}, item, { posterDataUrl: posterDataUrl(item) });
    delete out.posterPath;
    return out;
  }

  function listAudioDevices() {
    return new Promise(function (resolve) {
      let win = null;
      let done = false;
      function finish(list) {
        if (done) return;
        done = true;
        try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
        resolve(list || []);
      }
      try {
        win = new BrowserWindow({ show: false, width: 200, height: 120, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
        win.loadURL("about:blank").then(function () {
          const js = "(async function(){try{var s=null;try{s=await navigator.mediaDevices.getUserMedia({audio:true});}catch(e){}var list=await navigator.mediaDevices.enumerateDevices();if(s){s.getTracks().forEach(function(t){try{t.stop();}catch(e){}});}return list.filter(function(d){return d.kind==='audioinput';}).map(function(d){return {deviceId:d.deviceId,label:d.label,kind:d.kind};});}catch(e){return [];}})()";
          win.webContents.executeJavaScript(js, true).then(function (list) { finish(list); }).catch(function () { finish([]); });
        }).catch(function () { finish([]); });
      } catch (e) { finish([]); }
      setTimeout(function () { finish([]); }, 6000);
    });
  }

  function listDisplaysDip() {
    return screen.getAllDisplays().map(function (d) {
      return { id: String(d.id), bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }, scaleFactor: d.scaleFactor || 1 };
    });
  }

  function displayForDipPoint(list, x, y) {
    for (let i = 0; i < list.length; i++) {
      const b = list[i].bounds;
      if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return list[i];
    }
    return list[0] || null;
  }

  // 区域框选：透明全屏覆盖窗，把页面坐标换算成 DIP 桌面坐标。
  function selectRegion() {
    return new Promise(function (resolve) {
      const displays = listDisplaysDip();
      if (!displays.length) { resolve(null); return; }
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      displays.forEach(function (d) {
        x1 = Math.min(x1, d.bounds.x); y1 = Math.min(y1, d.bounds.y);
        x2 = Math.max(x2, d.bounds.x + d.bounds.width); y2 = Math.max(y2, d.bounds.y + d.bounds.height);
      });
      const virtual = { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
      let win = null;
      let settled = false;
      const timer = setTimeout(function () { finish(null); }, 180000);

      function cleanup() {
        clearTimeout(timer);
        try { ipcMain.removeListener("overlay:ready", onReady); } catch (e) {}
        try { ipcMain.removeListener("overlay:done", onDone); } catch (e) {}
        try { ipcMain.removeListener("overlay:cancelled", onCancel); } catch (e) {}
        state.overlayWin = null;
      }
      function finish(region) {
        if (settled) return;
        settled = true;
        cleanup();
        try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
        resolve(region || null);
      }
      function onReady() {
        try {
          if (!win || win.isDestroyed()) return;
          win.show();
          win.focus();
          win.setAlwaysOnTop(true, "screen-saver");
        } catch (e) {}
      }
      function onDone(payload) {
        try {
          const wb = win && !win.isDestroyed() ? win.getBounds() : virtual;
          const pw = Number(payload && payload.pageWidth) || wb.width;
          const ph = Number(payload && payload.pageHeight) || wb.height;
          const sx = pw > 0 ? wb.width / pw : 1;
          const sy = ph > 0 ? wb.height / ph : 1;
          const region = {
            x: Math.round(wb.x + (Number(payload.x) || 0) * sx),
            y: Math.round(wb.y + (Number(payload.y) || 0) * sy),
            width: Math.round((Number(payload.width) || 0) * sx),
            height: Math.round((Number(payload.height) || 0) * sy)
          };
          if (region.width < 8 || region.height < 8) { finish(null); return; }
          const display = displayForDipPoint(displays, region.x + region.width / 2, region.y + region.height / 2);
          region.displayId = display ? display.id : (displays[0] ? displays[0].id : "");
          log("region selected", JSON.stringify(region));
          finish(region);
        } catch (e) {
          log("region parse failed", e && e.message);
          finish(null);
        }
      }
      function onCancel() { finish(null); }

      try {
        win = new BrowserWindow({
          x: virtual.x,
          y: virtual.y,
          width: virtual.width,
          height: virtual.height,
          frame: false,
          transparent: true,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          hasShadow: false,
          enableLargerThanScreen: true,
          show: false,
          backgroundColor: "#00000000",
          webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false }
        });
        state.overlayWin = win;
        win.setMenuBarVisibility(false);
        win.setAlwaysOnTop(true, "screen-saver");
        win.on("closed", function () { finish(null); });
        ipcMain.on("overlay:ready", onReady);
        ipcMain.on("overlay:done", function (event, payload) { onDone(payload); });
        ipcMain.on("overlay:cancelled", onCancel);
        win.loadFile(path.join(__dirname, "..", "overlay", "overlay.html"));
      } catch (e) {
        log("overlay create failed", e && e.message);
        finish(null);
      }
    });
  }

  // ffmpeg 是否可用：打包版不再内置 ffmpeg（纯 JS remux），开发态兜底才有；探测结果进程内缓存，
  // 避免渲染层每次请求 app:info 都 spawn 一个探测进程。
  let ffmpegAvailCache = null;
  function ffmpegAvail() {
    if (ffmpegAvailCache !== null) return Promise.resolve(ffmpegAvailCache);
    return ffmpeg.isAvailable().catch(function () { return false; }).then(function (v) { ffmpegAvailCache = !!v; return ffmpegAvailCache; });
  }

  function registerIpc() {
    ipcMain.handle("settings:get", function () { return state.settings.get(); });
    ipcMain.handle("settings:set", function (event, patch) {
      const next = sanitize(patch);
      state.settings.data = next;
      state.settings.save();
      broadcast("settings:changed", next);
      return next;
    });
    ipcMain.handle("settings:chooseDir", async function () {
      const cur = state.settings.get();
      const res = await dialog.showOpenDialog(state.mainWindow, {
        title: "选择录像保存目录",
        defaultPath: cur.outputDir,
        properties: ["openDirectory", "createDirectory"]
      });
      if (res.canceled || !res.filePaths || !res.filePaths.length) return state.settings.get();
      const next = Object.assign({}, state.settings.get(), { outputDir: res.filePaths[0] });
      state.settings.data = next;
      state.settings.save();
      broadcast("settings:changed", next);
      return next;
    });
    ipcMain.handle("settings:openDir", function () { openOutputDir(); return true; });
    ipcMain.handle("app:info", async function () {
      const hasFfmpeg = await ffmpegAvail();
      return {
        name: "NovaRec",
        version: app.getVersion(),
        electron: process.versions.electron || "",
        chrome: process.versions.chrome || "",
        node: process.versions.node || "",
        ffmpeg: hasFfmpeg,
        platform: process.platform,
        outputDir: state.settings.get().outputDir,
        userData: app.getPath("userData"),
        hardware: perfMod.getHardware(),
        performance: (function () {
          const p = perfMod.resolve(state.settings.get());
          return { mode: p.mode, enabled: p.enabled, label: p.label, maxHeight: p.maxHeight, fpsCap: p.fpsCap };
        })()
      };
    });
    ipcMain.handle("audio:devices", function () { return listAudioDevices(); });

    // 采集源枚举要调 desktopCapturer：带缩略图/窗口图标时是数十到数百 ms（每个窗口都要
    // 截一张图再同步 PNG 编码），不带图只要几 ms。两档分别缓存，挡住页面来回切换的重复枚举。
    const sourcesCache = { full: null, fullAt: 0, fast: null, fastAt: 0 };
    ipcMain.handle("sources:list", async function (event, opts) {
      const o = opts && typeof opts === "object" ? opts : { force: opts === true };
      const fast = o.fast === true;
      const force = o.force === true;
      const now = Date.now();
      const cached = fast ? sourcesCache.fast : sourcesCache.full;
      const cachedAt = fast ? sourcesCache.fastAt : sourcesCache.fullAt;
      if (!force && cached && now - cachedAt < 800) return cached;
      const list = await sourcesApi.listSources({ thumbnails: !fast, icons: !fast });
      if (fast) { sourcesCache.fast = list; sourcesCache.fastAt = now; }
      else { sourcesCache.full = list; sourcesCache.fullAt = now; }
      return list;
    });
    ipcMain.handle("display:info", function () { return sourcesApi.getDisplayInfo(); });
    ipcMain.handle("region:select", async function () { return await selectRegion(); });

    // 渲染层把鼠标移到开始按钮时预热隐藏采集窗（只建窗/加载页面，不取流）
    ipcMain.handle("capture:prewarm", async function () {
      if (!state.recorder || typeof state.recorder.prewarm !== "function") return { ok: false, pending: true };
      return await state.recorder.prewarm();
    });

    ipcMain.handle("recording:start", async function (event, req) {
      if (!state.recorder) return { ok: false, error: "录制模块未就绪" };
      const settings = state.settings.get();
      const merged = Object.assign({}, req || {});
      if (merged.systemAudio === undefined) merged.systemAudio = settings.systemAudio;
      if (merged.microphone === undefined) merged.microphone = settings.microphone;
      if (merged.fps === undefined) merged.fps = settings.fps;
      if (merged.format === undefined) merged.format = settings.format;
      if (merged.quality === undefined) merged.quality = settings.quality;
      return await state.recorder.start(merged);
    });
    ipcMain.handle("recording:stop", async function () { return state.recorder ? await state.recorder.stop() : { ok: false, error: "录制模块未就绪" }; });
    ipcMain.handle("recording:togglePause", async function () { return state.recorder ? await state.recorder.togglePause() : { ok: false, error: "录制模块未就绪" }; });
    ipcMain.handle("recording:state", function () { return state.recorder ? state.recorder.getState() : { state: "idle", elapsedMs: 0, countdownLeft: 0, paused: false }; });

    ipcMain.handle("library:list", function () {
      return state.library.items().map(toClientItem);
    });
    ipcMain.handle("library:delete", async function (event, id) {
      const item = state.library.get(id);
      if (!item) return { ok: false, error: "录像不存在" };
      state.library.remove(id);
      const files = [item.filePath, item.posterPath].filter(Boolean);
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        try {
          if (fs.existsSync(f)) await shell.trashItem(f);
        } catch (e) {
          try { fs.unlinkSync(f); } catch (e2) {}
        }
      }
      broadcast("toast", { type: "success", message: "已删除：" + (item.fileName || "录像") });
      return { ok: true };
    });
    ipcMain.handle("library:reveal", function (event, id) {
      const item = state.library.get(id);
      if (!item) return { ok: false, error: "录像不存在" };
      if (fs.existsSync(item.filePath)) shell.showItemInFolder(item.filePath);
      else broadcast("toast", { type: "warning", message: "文件已不存在：" + item.fileName });
      return { ok: true };
    });
    ipcMain.handle("library:open", async function (event, id) {
      const item = state.library.get(id);
      if (!item) return { ok: false, error: "录像不存在" };
      if (!fs.existsSync(item.filePath)) return { ok: false, error: "文件已不存在" };
      const err = await shell.openPath(item.filePath);
      if (err) return { ok: false, error: err };
      return { ok: true };
    });

    ipcMain.handle("win:minimize", function () { if (state.mainWindow) state.mainWindow.minimize(); return true; });
    ipcMain.handle("win:toggleMaximize", function () {
      const win = state.mainWindow;
      if (!win) return false;
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
      return win.isMaximized();
    });
    ipcMain.handle("win:close", function () { if (state.mainWindow) state.mainWindow.close(); return true; });
    ipcMain.handle("win:isMaximized", function () { return !!(state.mainWindow && state.mainWindow.isMaximized()); });
  }

  function createRecorder() {
    const rec = new recorderMod.Recorder({
      userDataPath: app.getPath("userData"),
      fallbackOutputDir: path.join(app.getPath("userData"), "recordings"),
      getSettings: function () { return state.settings.get(); },
      getMainWindow: function () { return state.mainWindow; },
      library: state.library
    });
    state.recorder = rec;
    rec.on("state", function (s) { broadcast("recording:state", s); refreshTray(s); syncShortcuts(s); });
    rec.on("saved", function (item) {
      broadcast("recording:saved", item);
      if (!state.mainWindow || !state.mainWindow.isVisible()) showMainWindow();
    });
    rec.on("error", function (payload) { broadcast("recording:error", payload); });
    rec.on("toast", function (payload) { broadcast("toast", payload); });
  }

  app.on("second-instance", function () { showMainWindow(); });

  app.whenReady().then(function () {
    perfMark("when_ready");
    ensureDir(app.getPath("userData"));
    ensureDir(path.join(app.getPath("userData"), "temp"));
    state.settings = new storeMod.JsonFile(path.join(app.getPath("userData"), "settings.json"), defaults());
    state.settings.load();
    if (!state.settings.get().outputDir) { state.settings.data.outputDir = defaults().outputDir; state.settings.save(); }
    // 保存目录可写性校正（默认「视频NovaRec」在本机可能不可写）：不可写就换成探测得到的可写目录并落盘。
    try {
      const want = state.settings.get().outputDir;
      const picked = pickOutputDir(want);
      if (picked.dir !== want) {
        state.settings.data.outputDir = picked.dir;
        state.settings.save();
        log("output dir not writable -> " + picked.dir);
      } else {
        ensureDir(want);
      }
    } catch (e) { log("output dir check failed: " + (e && e.message)); }
    state.library = new storeMod.Library(path.join(app.getPath("userData"), "library.json"));
    perfMark("stores_loaded");

    try {
      session.defaultSession.setPermissionRequestHandler(function (wc, permission, callback) {
        try { callback(true); } catch (e) { callback(false); }
      });
      session.defaultSession.setPermissionCheckHandler(function () { return true; });
    } catch (e) { log("permission handler failed", e && e.message); }
    // 关闭拼写检查下载等网络行为，保持离线可用
    try { session.defaultSession.setSpellCheckerEnabled(false); } catch (e) {}

    createMainWindow();
    perfMark("window_created");
    // IPC 必须最先就绪：渲染层一显示就会调 settings:get / sources:list 等。
    registerIpc();
    perfMark("ready");
    log("ready, userData=" + app.getPath("userData") + " output=" + state.settings.get().outputDir);

    // 托盘（原生菜单构建）、录制器（媒体栈解析）、快捷键、更新器（913 行同步 require）只在
    // 用户第一次交互时才需要，放到首帧之后的下一个 tick 装配：不参与「窗口可见」的关键路径，
    // 省 20~60ms 首屏时间。
    setImmediate(function () {
      try {
        createRecorder();
        createTray();
        syncShortcuts(null);
      } catch (e) {
        log("deferred init failed", e && e.message);
      }
      // 自动更新：主进程负责检查/下载/安装，渲染层只调 IPC；启动 10s 后静默检查一次（24 小时内不重复）
      try {
        state.updater = require("./updater").init({
          app: app,
          ipcMain: ipcMain,
          shell: shell,
          dialog: dialog,
          userDataPath: app.getPath("userData"),
          getSettings: function () { return state.settings.get(); },
          saveSettings: function (patch) {
            const next = Object.assign({}, state.settings.get(), patch || {});
            state.settings.data = next;
            state.settings.save();
            broadcast("settings:changed", next);
            return next;
          },
          getMainWindow: function () { return state.mainWindow; },
          broadcast: broadcast,
          log: devLog
        });
        devLog("updater initialized");
      } catch (e) {
        devLog("updater init failed: " + (e && e.stack || e));
      }
      perfMark("deferred_ready");
    });
  });

  app.on("before-quit", function () {
    state.isQuitting = true;
    try { globalShortcut.unregisterAll(); } catch (e) {}
    try { if (state.recorder) state.recorder.abortForQuit(); } catch (e) {}
    try { if (state.tray) { state.tray.destroy(); state.tray = null; } } catch (e) {}
  });

  app.on("will-quit", function () {
    try { globalShortcut.unregisterAll(); } catch (e) {}
  });

  app.on("window-all-closed", function () {
    // 托盘常驻，不随窗口关闭退出
  });
}
