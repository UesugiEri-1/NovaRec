"use strict";
// 录制编排：状态机 + 隐藏采集窗口 + 窗口采集失败降级 + ffmpeg 收尾入库。
const { BrowserWindow, ipcMain, powerSaveBlocker } = require("electron");
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const sourcesApi = require("./sources");
const winbounds = require("./winbounds");
const ffmpeg = require("./ffmpeg");
const mediafix = require("./mediafix");
const perfMod = require("./perf");

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function fileStamp(d) {
  d = d || new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function readDataUrl(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return "data:image/jpeg;base64," + fs.readFileSync(file).toString("base64");
  } catch (e) { return null; }
}
function clamp(n, min, max) { n = Number(n); if (!isFinite(n)) n = min; return Math.max(min, Math.min(max, n)); }
function intersectRegion(r, bounds) {
  const x1 = Math.max(r.x, bounds.x);
  const y1 = Math.max(r.y, bounds.y);
  const x2 = Math.min(r.x + r.width, bounds.x + bounds.width);
  const y2 = Math.min(r.y + r.height, bounds.y + bounds.height);
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(Math.max(0, x2 - x1)), height: Math.round(Math.max(0, y2 - y1)) };
}

class Recorder extends EventEmitter {
  constructor(opts) {
    super();
    opts = opts || {};
    this.userDataPath = opts.userDataPath;
    // 保存目录的兜底：设置里的目录在录制过程中变得不可写（权限/安全软件拦截）时，
    // 收尾阶段自动改存到这个目录，避免用户白录一次。由主进程传入 userData/recordings。
    this.fallbackOutputDir = opts.fallbackOutputDir || path.join(opts.userDataPath || ".", "recordings");
    this.getSettings = opts.getSettings || function () { return {}; };
    this.getMainWindow = opts.getMainWindow || function () { return null; };
    this.library = opts.library;
    this.phase = "idle";
    this.countdownLeft = 0;
    this.info = null;
    this.cfg = null;
    this.target = null;
    this.sessionId = null;
    this.fallbackUsed = false;
    this.captureWin = null;
    this.captureReady = false;
    this._readyWaiters = [];
    this._startWaiter = null;
    this._stopWaiter = null;
    this._prepareWaiter = null;
    this._ticker = null;
    this._baseElapsed = 0;
    this._runStart = 0;
    this._paused = false;
    this._countdownAbort = false;
    this._mainHidden = false;
    this._lastError = null;
    this._lastProgress = null;
    this._ffmpegOk = null;
    this._perf = null;
    this._powerSaverId = null;
    this._captureIdleTimer = null;
    this.tempDir = path.join(this.userDataPath, "temp");
    this._channels = {
      "capture:ready": true,
      "capture:prepared": true,
      "capture:started": true,
      "capture:stopped": true,
      "capture:error": true,
      "capture:progress": true,
      "capture:paused": true,
      "capture:resumed": true,
      "capture:cancelled": true,
      "capture:log": true
    };
    this._bindIpc();
  }

  _bindIpc() {
    const self = this;
    Object.keys(this._channels).forEach(function (ch) {
      ipcMain.on(ch, function (event, payload) { self._handleCapture(ch, payload || {}); });
    });
  }

  _handleCapture(channel, payload) {
    if (channel === "capture:ready") {
      this.captureReady = true;
      this._readyWaiters.slice().forEach(function (w) { try { w.resolve(); } catch (e) {} });
      this._readyWaiters = [];
      return;
    }
    if (channel === "capture:prepared") {
      if (this._prepareWaiter) { const w = this._prepareWaiter; this._prepareWaiter = null; w({ type: "prepared", info: payload }); }
      return;
    }
    if (channel === "capture:log") {
      console.log("[capture] " + (payload && payload.message));
      return;
    }
    if (channel === "capture:started") {
      if (this._startWaiter) { const w = this._startWaiter; this._startWaiter = null; w({ type: "started", info: payload }); }
      return;
    }
    if (channel === "capture:stopped") {
      if (this._stopWaiter) { const w = this._stopWaiter; this._stopWaiter = null; w({ type: "stopped", info: payload }); }
      return;
    }
    if (channel === "capture:error") {
      if (this._startWaiter) { const w = this._startWaiter; this._startWaiter = null; w({ type: "error", message: payload.message, code: payload.code }); return; }
      if (this._stopWaiter) { const w = this._stopWaiter; this._stopWaiter = null; w({ type: "error", message: payload.message, code: payload.code }); return; }
      if (this.phase === "recording" || this.phase === "paused") {
        this._lastError = payload.message || "采集出错";
        this.emit("toast", { type: "error", message: "采集中断：" + this._lastError });
        this.stop({ graceMs: 6000, interrupted: true });
      }
      return;
    }
    if (channel === "capture:progress") {
      this._lastProgress = payload;
      return;
    }
    if (channel === "capture:paused") {
      if (Number(payload.elapsedMs) >= 0) this._baseElapsed = Number(payload.elapsedMs);
      this._paused = true;
      if (this.phase === "recording") this.phase = "paused";
      this.emitState();
      return;
    }
    if (channel === "capture:resumed") {
      if (Number(payload.elapsedMs) >= 0) this._baseElapsed = Number(payload.elapsedMs);
      this._runStart = Date.now();
      this._paused = false;
      if (this.phase === "paused") this.phase = "recording";
      this.emitState();
      return;
    }
  }

  // 预热点：鼠标移到「开始录制」上时提前建好隐藏采集窗并加载 capture.html。
  // 建窗 + 页面加载约 150~200ms，提前做掉后倒计时为 0 或很短时也能明显更快出画。
  // 只建窗不取流：不占桌面/音频设备，空闲 25 秒后仍会自动销毁。
  async prewarm() {
    if (this.phase !== "idle") return { ok: false, busy: true };
    try {
      await this.ensureCaptureWindow();
      this._scheduleCaptureIdleClose();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "预热失败" };
    }
  }

  async ensureCaptureWindow() {
    const self = this;
    this._clearCaptureIdleTimer();
    if (this.captureWin && !this.captureWin.isDestroyed() && !this.captureWin.webContents.isCrashed()) {
      if (this.captureReady) return this.captureWin;
      await this._waitReady(15000);
      return this.captureWin;
    }
    this.captureReady = false;
    const win = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      frame: false,
      skipTaskbar: true,
      backgroundColor: "#000000",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false
      }
    });
    win.setMenuBarVisibility(false);
    this.captureWin = win;
    win.webContents.on("render-process-gone", function (ev, details) {
      console.error("[recorder] capture renderer gone", details && details.reason);
      // 渲染进程死了但 BrowserWindow 对象还活着：如果继续复用它，下一次录制会把 IPC 发进
      // 已销毁的渲染帧（"Render frame was disposed"），然后一直等不到 capture:started 直到超时。
      // 这里把窗口引用清空并销毁，下次录制会重新建一个干净的隐藏采集窗。
      self.captureReady = false;
      self._readyWaiters.forEach(function (w) { try { w.reject(new Error("采集进程异常退出")); } catch (e) {} });
      self._readyWaiters = [];
      if (self.captureWin === win) self.captureWin = null;
      try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
      const err = { type: "error", message: "采集进程异常退出", code: "renderer_gone" };
      if (self._startWaiter) { const w = self._startWaiter; self._startWaiter = null; w(err); }
      if (self._stopWaiter) { const w = self._stopWaiter; self._stopWaiter = null; w(err); }
      if (self.phase === "recording" || self.phase === "paused" || self.phase === "starting") {
        self._lastError = "采集进程异常退出";
        self.emit("toast", { type: "error", message: "采集进程异常退出，本次录制已中断" });
        self._stopTicker();
        self.phase = "idle";
        self.info = null;
        self._showMain();
        self._cleanupCapture();
        self._cleanupTemp();
        self.emitState();
        self.emit("error", { message: "采集进程异常退出" });
      }
    });
    await new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error("采集窗口加载超时"));
      }, 20000);
      win.webContents.once("did-finish-load", function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
      win.loadFile(path.join(__dirname, "..", "capture", "capture.html")).catch(function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
    await this._waitReady(15000);
    return win;
  }

  _waitReady(timeoutMs) {
    const self = this;
    if (this.captureReady) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      const waiter = { resolve: resolve, reject: reject };
      self._readyWaiters.push(waiter);
      setTimeout(function () {
        const idx = self._readyWaiters.indexOf(waiter);
        if (idx >= 0) { self._readyWaiters.splice(idx, 1); reject(new Error("采集器未就绪")); }
      }, timeoutMs || 15000);
    });
  }

  _sendToCapture(channel, payload) {
    if (!this.captureWin || this.captureWin.isDestroyed()) return false;
    try { this.captureWin.webContents.send(channel, payload); return true; } catch (e) { console.error("[recorder] send fail", e.message); return false; }
  }

  _waitStart(timeoutMs) {
    const self = this;
    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        self._startWaiter = null;
        resolve({ type: "timeout", message: "启动录制超时" });
      }, timeoutMs || 30000);
      self._startWaiter = function (msg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  _waitPrepared(timeoutMs) {
    const self = this;
    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        self._prepareWaiter = null;
        resolve({ type: "timeout", message: "准备采集超时" });
      }, timeoutMs || 20000);
      self._prepareWaiter = function (msg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  _waitStop(timeoutMs) {
    const self = this;
    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        self._stopWaiter = null;
        resolve({ type: "timeout", message: "停止录制超时" });
      }, timeoutMs || 30000);
      self._stopWaiter = function (msg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  _buildConfig(settings, req) {
    const mode = req.mode || "screen";
    if (["screen", "region", "window"].indexOf(mode) < 0) return { ok: false, error: "未知录制模式" };
    const cfg = {
      mode: mode,
      sourceId: req.sourceId || settings.lastSourceId || "",
      region: req.region || null,
      format: req.format || settings.format || "mp4",
      fps: clamp(req.fps || settings.fps || 30, 10, 60),
      quality: req.quality || settings.quality || "high",
      systemAudio: req.systemAudio !== undefined ? !!req.systemAudio : settings.systemAudio !== false,
      microphone: req.microphone !== undefined ? !!req.microphone : !!settings.microphone,
      micDeviceId: settings.micDeviceId || "default",
      countdown: clamp(req.countdown !== undefined ? req.countdown : (settings.countdown !== undefined ? settings.countdown : 3), 0, 10),
      hideMainWindow: typeof req.hideMainWindow === "boolean" ? req.hideMainWindow : settings.hideMainWindow !== false
    };
    if (cfg.format !== "webm") cfg.format = "mp4";
    if (["low", "medium", "standard", "high", "ultra"].indexOf(cfg.quality) < 0) cfg.quality = "high";
    return { ok: true, cfg: cfg };
  }

  async _resolveTarget(cfg) {
    const data = await sourcesApi.listSources();
    const displayInfo = sourcesApi.getDisplayInfo();
    const displays = displayInfo.displays || [];
    if (!displays.length) throw new Error("未检测到显示器");
    if (cfg.mode === "region") {
      const r = cfg.region;
      if (!r || !(Number(r.width) > 0) || !(Number(r.height) > 0)) throw new Error("请先框选录制区域");
      const centerX = Number(r.x) + Number(r.width) / 2;
      const centerY = Number(r.y) + Number(r.height) / 2;
      let display = sourcesApi.displayForPoint(displays, centerX, centerY);
      if (!display) display = displays.find(function (d) { return d.primary; }) || displays[0];
      const region = intersectRegion({ x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) }, display.bounds);
      if (region.width < 16 || region.height < 16) throw new Error("选区太小或超出屏幕范围");
      const screen = sourcesApi.screenForDisplay(data.screens, displays, display);
      if (!screen) throw new Error("未找到对应屏幕的采集源");
      return { sourceId: screen.id, sourceName: "区域 " + region.width + "×" + region.height, display: display, region: region, screenId: screen.id };
    }
    if (cfg.mode === "window") {
      const win = (data.windows || []).find(function (w) { return w.id === cfg.sourceId; });
      if (!win) throw new Error("所选窗口已关闭，请重新选择");
      const primary = displays.find(function (d) { return d.primary; }) || displays[0];
      const screen = sourcesApi.screenForDisplay(data.screens, displays, primary);
      return { sourceId: win.id, sourceName: win.name, display: primary, region: null, screenId: screen ? screen.id : "" };
    }
    const screen = (data.screens || []).find(function (s) { return s.id === cfg.sourceId; }) || (data.screens || [])[0];
    if (!screen) throw new Error("未找到可用屏幕");
    const display = displays.find(function (d) { return d.id === screen.displayId; }) || displays.find(function (d) { return d.primary; }) || displays[0];
    return { sourceId: screen.id, sourceName: screen.name, display: display, region: null, screenId: screen.id };
  }

  _capturePayload(cfg, target, modeOverride, sessionId) {
    const outBasePath = path.join(this.tempDir, sessionId);
    try { fs.mkdirSync(this.tempDir, { recursive: true }); } catch (e) {}
    return {
      sessionId: sessionId,
      mode: modeOverride || cfg.mode,
      sourceId: target.sourceId,
      screenId: target.screenId || target.sourceId,
      format: cfg.format,
      fps: cfg.fps,
      quality: cfg.quality,
      systemAudio: cfg.systemAudio,
      microphone: cfg.microphone,
      micDeviceId: cfg.micDeviceId,
      region: target.region,
      displayBounds: target.display ? target.display.bounds : { x: 0, y: 0, width: 0, height: 0 },
      perf: perfMod.toCaptureOptions(this._perf || perfMod.resolve({})),
      outBasePath: outBasePath
    };
  }

  // 倒计时期间预取采集流（两段式启动的第一段），start 时只差一个 MediaRecorder。
  async _prepareCapture(cfg, target, sessionId) {
    await this.ensureCaptureWindow();
    const payload = this._capturePayload(cfg, target, null, sessionId);
    const waiter = this._waitPrepared(20000);
    if (!this._sendToCapture("capture:prepare", payload)) return { type: "error", message: "采集窗口不可用" };
    const msg = await waiter;
    console.log("[recorder] prepare " + (msg.type === "prepared" ? "ok " + (msg.info.width || 0) + "x" + (msg.info.height || 0) + " mime=" + (msg.info.mime || "") : msg.type + " " + (msg.message || "")));
    return msg;
  }

  async _attemptStart(cfg, target, modeOverride) {
    await this.ensureCaptureWindow();
    const sessionId = this.sessionId || ("rec_" + Date.now() + "_" + Math.floor(Math.random() * 10000));
    this.sessionId = sessionId;
    const payload = this._capturePayload(cfg, target, modeOverride, sessionId);
    console.log("[recorder] start capture " + JSON.stringify({ mode: payload.mode, sourceId: payload.sourceId, format: payload.format, region: payload.region, sys: payload.systemAudio, mic: payload.microphone }));
    const waiter = this._waitStart(30000);
    if (!this._sendToCapture("capture:start", payload)) return { type: "error", message: "采集窗口不可用" };
    return await waiter;
  }

  async _windowFallback(cfg, target) {
    const hwnd = winbounds.hwndFromSourceId(target.sourceId);
    if (!hwnd) return { type: "error", message: "无法获取窗口句柄" };
    let winInfo = null;
    try { winInfo = await winbounds.getWindowInfo(hwnd, true); } catch (e) {
      return { type: "error", message: "无法获取窗口位置：" + e.message };
    }
    await sleep(500);
    const rect = winInfo.visibleRect;
    if (!rect || rect.width < 40 || rect.height < 40) return { type: "error", message: "窗口已最小化或不可见，无法录制" };
    const data = await sourcesApi.listSources();
    const displays = sourcesApi.getDisplayInfo().displays || [];
    const primary = displays.find(function (d) { return d.primary; }) || displays[0];
    const scale = (primary && primary.scaleFactor) || 1;
    const probe = { x: Math.round(rect.x / scale), y: Math.round(rect.y / scale), width: Math.round(rect.width / scale), height: Math.round(rect.height / scale) };
    const display = sourcesApi.displayForPoint(displays, probe.x + probe.width / 2, probe.y + probe.height / 2) || primary;
    const region = intersectRegion(probe, display.bounds);
    if (region.width < 40 || region.height < 40) return { type: "error", message: "窗口位置在屏幕之外，无法录制" };
    const screen = sourcesApi.screenForDisplay(data.screens, displays, display);
    if (!screen) return { type: "error", message: "未找到对应屏幕的采集源" };
    this.fallbackUsed = true;
    console.log("[recorder] window fallback region " + JSON.stringify(region));
    return await this._attemptStart(cfg, { sourceId: screen.id, sourceName: target.sourceName, display: display, region: region, screenId: screen.id }, "region");
  }

  async start(req) {
    if (this.phase !== "idle") return { ok: false, error: "当前正在录制中，请先停止" };
    const settings = this.getSettings() || {};
    const built = this._buildConfig(settings, req || {});
    if (!built.ok) return { ok: false, error: built.error };
    const cfg = built.cfg;
    // 性能剖面：按设置 + 硬件自动判定；只做「向下封顶」，永不把用户选的画质/帧率抬高
    this._perf = perfMod.resolve(settings);
    cfg.fps = perfMod.capFps(this._perf, cfg.fps);
    cfg.quality = perfMod.capQuality(this._perf, cfg.quality);
    console.log("[recorder] perf " + JSON.stringify({ enabled: this._perf.enabled, mode: this._perf.mode, fps: cfg.fps, quality: cfg.quality, label: this._perf.label }));
    this.cfg = cfg;
    this.fallbackUsed = false;
    this._lastError = null;
    this._lastProgress = null;
    // 起录准备并行化（两段式启动）：
    //   a. 枚举采集源（desktopCapturer ~0.1-0.4s）与预热隐藏采集窗（建窗+加载 ~0.3-0.6s）并行；
    //   b. 有倒计时时，采集窗就绪后立刻在最前面预取采集流（capture:prepare），
    //      倒计时结束只差一个 MediaRecorder，起录延迟从 ~350ms 降到 ~50ms。
    const self = this;
    this.sessionId = "rec_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    const sessionId = this.sessionId;
    const prep = { target: null, error: null, prepared: false };
    const winReady = this.ensureCaptureWindow().catch(function () { return null; });
    const targetReady = this._resolveTarget(cfg).then(function (t) { prep.target = t; }, function (e) { prep.error = (e && e.message) || "采集源不可用"; });
    const prepReady = (async function () {
      await targetReady;
      if (prep.error || !prep.target) return;
      // 没有倒计时就没有「免费」的准备窗口，直接走一次性启动，少一次 IPC 往返
      if (cfg.countdown <= 0) return;
      await winReady;
      if (prep.error || !prep.target) return;
      const msg = await self._prepareCapture(cfg, prep.target, sessionId);
      if (msg.type === "prepared") { prep.prepared = true; return; }
      // 窗口采集失败要留到 start 失败后走「按窗口位置裁剪屏幕」的降级路径
      if (msg.type === "error" && msg.code === "window_capture_failed" && cfg.mode === "window") return;
      prep.error = msg.message || "启动录制失败";
    })();
    this.info = {
      mode: cfg.mode,
      sourceName: cfg.mode === "region" ? "屏幕区域" : (cfg.mode === "window" ? "应用窗口" : "整个屏幕"),
      startedAt: 0, width: 0, height: 0, hasAudio: false
    };
    if (cfg.countdown > 0) {
      this._countdownAbort = false;
      this.phase = "countdown";
      for (let i = cfg.countdown; i >= 1; i--) {
        if (this._countdownAbort) {
          this.phase = "idle";
          this.countdownLeft = 0;
          this.info = null;
          // 取消时可能正有一个 capture:prepare 在取流：abort 让它作废并释放已拿到的流
          this._sendToCapture("capture:abort", {});
          this._scheduleCaptureIdleClose();
          this.emitState();
          return { ok: false, cancelled: true };
        }
        this.countdownLeft = i;
        this.emitState();
        await sleep(1000);
        // 准备阶段已经失败（例如选中的窗口被关掉）就别干等剩下的秒数
        if (prep.error) break;
      }
      this.countdownLeft = 0;
    }
    await prepReady;
    if (prep.error || !prep.target) {
      const msg = prep.error || "采集源不可用";
      this.phase = "idle";
      this._showMain();
      this.info = null;
      this.emitState();
      this.emit("error", { message: msg });
      return { ok: false, error: msg };
    }
    const target = prep.target;
    this.target = target;
    this.info = { mode: cfg.mode, sourceName: target.sourceName, startedAt: 0, width: 0, height: 0, hasAudio: false };
    this.phase = "starting";
    this.emitState();
    if (cfg.hideMainWindow) this._hideMain();
    let startMsg = null;
    try {
      startMsg = await this._attemptStart(cfg, target);
    } catch (e) {
      startMsg = { type: "error", message: e.message || "启动录制失败" };
    }
    if (startMsg.type === "error" && startMsg.code === "window_capture_failed" && cfg.mode === "window") {
      this.emit("toast", { type: "info", message: "窗口采集不可用，已切换为屏幕裁剪方式录制该窗口" });
      try {
        startMsg = await this._windowFallback(cfg, target);
      } catch (e) {
        startMsg = { type: "error", message: e.message || "窗口录制失败" };
      }
    }
    if (startMsg.type !== "started") {
      this.phase = "idle";
      this._sendToCapture("capture:abort", {});
      this._showMain();
      this.info = null;
      this._cleanupTemp();
      this._scheduleCaptureIdleClose();
      this.emitState();
      const message = startMsg.message || (startMsg.type === "timeout" ? "启动录制超时，请重试" : "启动录制失败");
      this.emit("error", { message: message });
      return { ok: false, error: message };
    }
    const si = startMsg.info || {};
    this.info = {
      mode: cfg.mode,
      sourceName: target.sourceName,
      startedAt: Date.now(),
      width: si.width || 0,
      height: si.height || 0,
      hasAudio: !!si.hasAudio,
      hasMic: !!si.hasMic,
      mime: si.mime || "",
      tempPath: si.tempPath || ""
    };
    this.phase = "recording";
    this._paused = false;
    this._baseElapsed = 0;
    this._runStart = Date.now();
    this._startPowerSave();
    this._startTicker();
    this.emitState();
    return { ok: true };
  }

  async stop(opts) {
    opts = opts || {};
    if (this.phase === "countdown") {
      this._countdownAbort = true;
      this.phase = "idle";
      this.countdownLeft = 0;
      this.info = null;
      this._showMain();
      this.emitState();
      return { ok: false, cancelled: true };
    }
    if (this.phase === "idle") return { ok: false, error: "当前没有在录制" };
    if (this.phase === "stopping" || this.phase === "processing") return { ok: false, error: "正在处理中，请稍候" };
    if (this.phase === "starting") {
      this._sendToCapture("capture:abort", {});
      this.phase = "idle";
      this.info = null;
      this._showMain();
      this.emitState();
      return { ok: false, error: "录制尚未开始" };
    }
    this.phase = "stopping";
    this.emitState();
    this._stopTicker();
    const graceMs = opts.graceMs || 30000;
    const waiter = this._waitStop(graceMs);
    this._sendToCapture("capture:stop", {});
    const stopped = await waiter;
    if (stopped.type !== "stopped") {
      this.phase = "idle";
      this._stopPowerSave();
      this._showMain();
      this._cleanupCapture();
      this._cleanupTemp();
      this.info = null;
      this.emitState();
      const message = stopped.message || (stopped.type === "timeout" ? "停止录制超时" : "录制结束异常");
      this.emit("error", { message: message });
      return { ok: false, error: message };
    }
    this.phase = "processing";
    this._stopPowerSave();
    this.emitState();
    const tFinalize = Date.now();
    const item = await this._finalize(stopped.info || {});
    console.log("[recorder] finalize " + (Date.now() - tFinalize) + "ms");
    this.phase = "idle";
    this.info = null;
    this._showMain();
    this._scheduleCaptureIdleClose();
    this.emitState();
    if (!item) return { ok: false, error: this._lastError || "保存录像失败" };
    return { ok: true, item: item };
  }

  async _finalize(stopped) {
    const settings = this.getSettings() || {};
    let outDir = settings.outputDir;
    if (!outDir) { this._lastError = "未设置保存目录"; this.emit("error", { message: this._lastError }); this._cleanupTemp(); return null; }
    // 目录可写性探测：本机安全策略可能让「视频\NovaRec」这类 C 盘目录对未签名程序不可写，
    // 此时收尾直接改存到 fallbackOutputDir（userData/recordings，通常与程序同盘），不丢录像。
    const probeDir = function (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const t = path.join(dir, ".novarec-probe");
        fs.writeFileSync(t, "x");
        fs.unlinkSync(t);
        return true;
      } catch (e) { return false; }
    };
    let usedFallbackDir = false;
    if (!probeDir(outDir) && this.fallbackOutputDir && this.fallbackOutputDir !== outDir && probeDir(this.fallbackOutputDir)) {
      usedFallbackDir = true;
      console.warn("[recorder] output dir not writable, fallback -> " + this.fallbackOutputDir);
      outDir = this.fallbackOutputDir;
    }
    const tempPath = stopped.tempPath || (this.info && this.info.tempPath) || "";
    if (!tempPath || !fs.existsSync(tempPath) || fs.statSync(tempPath).size < 512) {
      this._lastError = "没有录到有效视频数据";
      this.emit("error", { message: this._lastError });
      this._cleanupTemp();
      return null;
    }
    // 容器以采集器实际写出的文件头为准（mime 可能因兼容性回退），扩展名必须与真实容器一致。
    let finalFormat = mediafix.sniff(tempPath) || (path.extname(tempPath).toLowerCase() === ".mp4" ? "mp4" : "webm");
    let outPath = path.join(outDir, "NovaRec_" + fileStamp() + "." + finalFormat);
    let mode = "remux";
    let fixRes = null;
    try { fixRes = await mediafix.finalize({ tempPath: tempPath, outPath: outPath, kind: finalFormat }); } catch (e) { fixRes = { ok: false, error: e.message }; }
    if (fixRes.ok) {
      console.log("[recorder] remux " + finalFormat + " " + (fixRes.ms || 0) + "ms");
    } else {
      // 纯 JS 重封装失败（极罕见的异常结构）才回落到 ffmpeg 转码/重封装；开发环境装了 ffmpeg 可用它兜底。
      console.warn("[recorder] remux failed: " + (fixRes.error || "unknown"));
      if (this._ffmpegOk === null) { try { this._ffmpegOk = await ffmpeg.isAvailable(); } catch (e) { this._ffmpegOk = false; } }
      if (this._ffmpegOk) {
        const res = await ffmpeg.finalize({ tempPath: tempPath, format: finalFormat, outPath: outPath });
        if (res.ok) { mode = res.mode; fixRes = { ok: true }; }
      }
      if (!fixRes.ok) {
        const recExt = (path.extname(tempPath) || ".webm").toLowerCase();
        finalFormat = recExt.slice(1);
        outPath = path.join(outDir, "NovaRec_" + fileStamp() + recExt);
        try { fs.renameSync(tempPath, outPath); } catch (e) {
          this._lastError = "保存文件失败：" + e.message;
          this.emit("error", { message: this._lastError });
          this._cleanupTemp();
          return null;
        }
        mode = "copy";
      }
    }
    // 封面直接用采集窗口停止前抓的那一帧（避免为了一张图再起一次 ffmpeg 子进程）。
    let posterPath = null;
    const posterDataUrl = stopped.posterDataUrl || "";
    const posterOut = outPath.replace(/\.(mp4|webm)$/i, "") + ".jpg";
    if (posterDataUrl.indexOf("data:image/jpeg;base64,") === 0) {
      try {
        fs.writeFileSync(posterOut, Buffer.from(posterDataUrl.slice(posterDataUrl.indexOf(",") + 1), "base64"));
        if (fs.statSync(posterOut).size > 200) posterPath = posterOut;
      } catch (e) { posterPath = null; }
    }
    if (!posterPath && this._ffmpegOk) {
      try { posterPath = await ffmpeg.makePoster(outPath, posterOut); } catch (e) { posterPath = null; }
    }
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(outPath).size; } catch (e) {}
    const item = {
      id: this.sessionId || "rec_" + Date.now(),
      filePath: outPath,
      fileName: path.basename(outPath),
      format: finalFormat,
      mode: (this.info && this.info.mode) || this.cfg.mode,
      width: (this.info && this.info.width) || 0,
      height: (this.info && this.info.height) || 0,
      fps: this.cfg.fps,
      durationMs: Math.round(stopped.durationMs || this.elapsedMs() || 0),
      sizeBytes: sizeBytes,
      hasAudio: !!(this.info && this.info.hasAudio),
      hasMic: !!(this.info && this.info.hasMic),
      createdAt: Date.now(),
      posterPath: posterPath,
      sourceName: (this.info && this.info.sourceName) || "",
      fallback: this.fallbackUsed,
      transcode: mode
    };
    try { if (this.library) this.library.add(item); } catch (e) { console.error("[recorder] library add failed", e.message); }
    const withPoster = Object.assign({}, item, { posterDataUrl: readDataUrl(posterPath) });
    this.emit("saved", withPoster);
    this.emit("toast", { type: "success", message: "录制完成：" + item.fileName });
    if (usedFallbackDir) this.emit("toast", { type: "info", message: "原保存目录不可写，录像已保存到备用目录：" + outDir });
    this._cleanupTemp();
    return withPoster;
  }

  async togglePause() {
    if (this.phase === "recording") {
      this._sendToCapture("capture:pause", {});
      this._baseElapsed = this.elapsedMs();
      this._paused = true;
      this.phase = "paused";
      this.emitState();
      return { ok: true, paused: true };
    }
    if (this.phase === "paused") {
      this._sendToCapture("capture:resume", {});
      this._paused = false;
      this._runStart = Date.now();
      this.phase = "recording";
      this.emitState();
      return { ok: true, paused: false };
    }
    return { ok: false, error: "当前不能暂停" };
  }

  elapsedMs() {
    if (this.phase === "idle" || this.phase === "countdown") return 0;
    if (this._paused) return this._baseElapsed;
    if (!this._runStart) return this._baseElapsed;
    return this._baseElapsed + Math.max(0, Date.now() - this._runStart);
  }

  getState() {
    let state = "idle";
    if (this.phase === "countdown") state = "countdown";
    else if (this.phase === "recording") state = "recording";
    else if (this.phase === "paused") state = "paused";
    else if (this.phase !== "idle") state = "processing";
    return {
      state: state,
      mode: (this.info && this.info.mode) || (this.cfg && this.cfg.mode) || null,
      sourceName: (this.info && this.info.sourceName) || "",
      startedAt: (this.info && this.info.startedAt) || 0,
      elapsedMs: Math.round(this.elapsedMs()),
      countdownLeft: this.countdownLeft || 0,
      paused: this._paused === true,
      width: (this.info && this.info.width) || 0,
      height: (this.info && this.info.height) || 0,
      fps: (this.cfg && this.cfg.fps) || 0,
      perf: this._perf ? { enabled: this._perf.enabled === true, label: this._perf.label, mode: this._perf.mode } : null
    };
  }

  emitState() { this.emit("state", this.getState()); }

  _startTicker() {
    const self = this;
    this._stopTicker();
    // 每 500ms 轮询但只在「整秒变化」或阶段变化时推送：录制界面计时本来只显示到秒，
    // 减少一半无意义 IPC + 渲染，老设备上更省电更稳。
    let lastSec = -1;
    let lastPhase = "";
    this._ticker = setInterval(function () {
      if (self.phase !== "recording" && self.phase !== "paused") return;
      const sec = Math.floor(self.elapsedMs() / 1000);
      if (sec === lastSec && self.phase === lastPhase) return;
      lastSec = sec;
      lastPhase = self.phase;
      self.emitState();
    }, 500);
  }

  _stopTicker() { if (this._ticker) { clearInterval(this._ticker); this._ticker = null; } }

  _startPowerSave() {
    if (this._powerSaverId !== null) return;
    try {
      // 录制期间阻止屏幕休眠/锁屏：老设备默认 5 分钟息屏会把整个录制截断
      this._powerSaverId = powerSaveBlocker.start("prevent-display-sleep");
    } catch (e) { this._powerSaverId = null; }
  }

  _stopPowerSave() {
    if (this._powerSaverId === null) return;
    try { powerSaveBlocker.stop(this._powerSaverId); } catch (e) {}
    this._powerSaverId = null;
  }

  _scheduleCaptureIdleClose() {
    const self = this;
    this._clearCaptureIdleTimer();
    this._captureIdleTimer = setTimeout(function () {
      self._captureIdleTimer = null;
      if (self.phase === "idle") self._cleanupCapture();
    }, 25000);
    if (this._captureIdleTimer.unref) this._captureIdleTimer.unref();
  }

  _clearCaptureIdleTimer() {
    if (!this._captureIdleTimer) return;
    clearTimeout(this._captureIdleTimer);
    this._captureIdleTimer = null;
  }

  _hideMain() {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed() && win.isVisible()) {
      this._mainHidden = true;
      win.hide();
    }
  }

  _showMain() {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (this._mainHidden || !win.isVisible()) {
      this._mainHidden = false;
      try { win.show(); win.focus(); } catch (e) {}
    }
  }

  _cleanupCapture() {
    this.captureReady = false;
    if (this.captureWin && !this.captureWin.isDestroyed()) {
      try { this.captureWin.destroy(); } catch (e) {}
    }
    this.captureWin = null;
  }

  _cleanupTemp() {
    if (process.env.NOVAREC_KEEP_TEMP === "1") return; // 调试：保留临时文件供排查
    const self = this;
    try {
      if (!fs.existsSync(this.tempDir)) return;
      const files = fs.readdirSync(this.tempDir);
      files.forEach(function (f) {
        try { fs.unlinkSync(path.join(self.tempDir, f)); } catch (e) {}
      });
    } catch (e) {}
  }

  async abortForQuit() {
    try { this._countdownAbort = true; } catch (e) {}
    this._stopPowerSave();
    this._clearCaptureIdleTimer();
    if (this.captureWin && !this.captureWin.isDestroyed()) this._sendToCapture("capture:abort", {});
    this._stopTicker();
    this.phase = "idle";
    this.info = null;
    this.captureReady = false;
    this._cleanupCapture();
    this._cleanupTemp();
    this.emitState();
  }

  dispose() {
    this._stopTicker();
    this._stopPowerSave();
    this._clearCaptureIdleTimer();
    if (this._channels) {
      Object.keys(this._channels).forEach(function (ch) {
        try { ipcMain.removeAllListeners(ch); } catch (e) {}
      });
    }
    this._cleanupCapture();
    this._cleanupTemp();
  }
}

module.exports = { Recorder, readDataUrl };
