"use strict";
// NovaRec 采集引擎：运行在隐藏窗口里，负责 getUserMedia + MediaRecorder + 直写磁盘。
const { ipcRenderer } = require("electron");
const fs = require("fs");

const video = document.getElementById("preview");
const statusEl = document.getElementById("status");

const S = {
  phase: "idle",
  payload: null,
  recorder: null,
  recordStream: null,
  sourceStreams: [],
  micStream: null,
  writeStream: null,
  tempPath: null,
  writeChain: Promise.resolve(),
  writtenBytes: 0,
  activeStart: 0,
  accumulated: 0,
  progressTimer: null,
  drawTimer: null,
  loopActive: false,
  audioContext: null,
  monitorCtx: null,
  monitorTimer: null,
  finalInfo: null,
  finishing: false,
  prepared: null
};

function send(ch, data) { try { ipcRenderer.send(ch, data); } catch (e) {} }
function log(msg) { send("capture:log", { message: String(msg) }); }
function setStatus(text) { if (statusEl) statusEl.textContent = String(text); }

function elapsedMs() {
  if (S.phase === "paused") return S.accumulated;
  if (!S.activeStart) return S.accumulated;
  return S.accumulated + Math.max(0, Date.now() - S.activeStart);
}

function pickMime(format, hasAudio, preferVp8) {
  // 性能模式下 WebM 优先 VP8：同为软件编码，VP8 比 VP9 轻得多（老 CPU 上差距明显）
  const webm = hasAudio
    ? (preferVp8
      ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
      : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"])
    : (preferVp8
      ? ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]);
  const mp4 = hasAudio
    ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4"]
    : ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"];
  const list = format === "webm" ? webm : mp4;
  for (let i = 0; i < list.length; i++) {
    try { if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
  }
  if (format !== "webm") {
    for (let i = 0; i < webm.length; i++) {
      try { if (MediaRecorder.isTypeSupported(webm[i])) return webm[i]; } catch (e) {}
    }
  }
  return "";
}

function videoBitrate(w, h, fps, quality) {
  let factor = 0.15;
  if (quality === "medium" || quality === "standard") factor = 0.08;
  if (quality === "low") factor = 0.045;
  if (quality === "ultra") factor = 0.25;
  const raw = Math.round((w || 1280) * (h || 720) * (fps || 30) * factor);
  return Math.max(1500000, Math.min(16000000, raw));
}

// 桌面采集的 maxWidth/maxHeight 会真正让 Chromium 在采集端降采样（实测 1280x720 生效），
// 比采集后再用 canvas 缩放省一次全屏拷贝；性能模式下用它把 1080p 屏幕降到 720p。
function videoConstraints(sourceId, fps, perf, aspect) {
  perf = perf || {};
  let maxWidth = 4096;
  let maxHeight = 2304;
  if (perf.maxHeight > 0) {
    maxHeight = perf.maxHeight;
    maxWidth = aspect > 0.2
      ? Math.max(64, Math.min(4096, Math.round(perf.maxHeight * aspect))) // 屏幕/区域：按显示宽高比锁宽，避免左右裁切
      : 4096; // 窗口：宽高比未知，只限高，让采集端等比缩放
  }
  return {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: sourceId,
      maxWidth: maxWidth,
      maxHeight: maxHeight,
      maxFrameRate: fps || 30
    }
  };
}

async function getUserMediaWith(constraints) {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    throw new Error("当前环境不支持屏幕采集接口");
  }
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    const msg = (e && e.message) || "无法启动采集源";
    const err = new Error(msg);
    err.code = (e && e.name) || "getUserMedia_failed";
    throw err;
  }
}

function waitEvent(target, name, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      reject(new Error("等待 " + name + " 超时"));
    }, timeoutMs || 8000);
    const handler = function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    target.addEventListener(name, handler, { once: true });
  });
}

function evenDim(n) { return Math.max(2, Math.round(n / 2) * 2); }

function stopDraw() {
  S.loopActive = false;
  if (S.drawTimer) { clearTimeout(S.drawTimer); S.drawTimer = null; }
}

function stopProgress() {
  if (S.progressTimer) { clearInterval(S.progressTimer); S.progressTimer = null; }
}

// ---- 诊断用：音频轨状态与实时电平（问题定位后可移除） ----
function logAudioTrack(tag, t) {
  try {
    if (!t) { log(tag + " audio: none"); return; }
    let st = {};
    try { st = t.getSettings ? t.getSettings() : {}; } catch (e) {}
    log(tag + " audio: label=" + t.label + " state=" + t.readyState + " muted=" + t.muted + " enabled=" + t.enabled + " settings=" + JSON.stringify(st));
  } catch (e) { log(tag + " audio log failed: " + e.message); }
}

function stopAudioMonitor() {
  if (S.monitorTimer) { clearInterval(S.monitorTimer); S.monitorTimer = null; }
  try { if (S.monitorCtx && S.monitorCtx.state !== "closed") S.monitorCtx.close(); } catch (e) {}
  S.monitorCtx = null;
}

function startAudioMonitor(track) {
  stopAudioMonitor();
  if (!track) { log("audio monitor: no track"); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    S.monitorCtx = ac;
    const src = ac.createMediaStreamSource(new MediaStream([track]));
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    if (ac.state === "suspended" && ac.resume) { ac.resume().catch(function () {}); }
    S.monitorTimer = setInterval(function () {
      try {
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
        log("audio monitor ctx=" + ac.state + " peak=" + peak.toFixed(5));
      } catch (e) {}
    }, 600);
  } catch (e) { log("audio monitor failed: " + e.message); }
}

function cleanup() {
  stopDraw();
  stopProgress();
  stopAudioMonitor();
  try { if (S.recorder && S.recorder.state !== "inactive") S.recorder.stop(); } catch (e) {}
  S.recordStream = null;
  S.sourceStreams.forEach(function (st) {
    try { st.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e) {}
  });
  S.sourceStreams = [];
  try { if (S.micStream) S.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e) {}
  S.micStream = null;
  try { if (video.srcObject) { video.srcObject.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } } catch (e) {}
  try { video.srcObject = null; } catch (e) {}
  try { if (S.audioContext && S.audioContext.state !== "closed") S.audioContext.close(); } catch (e) {}
  S.audioContext = null;
  S.recorder = null;
  S.prepared = null;
  S.writeStream = null;
  S.tempPath = null;
  S.writtenBytes = 0;
  S.activeStart = 0;
  S.accumulated = 0;
  S.phase = "idle";
  S.payload = null;
  S.finishing = false;
}

function discardTemp() {
  const p = S.tempPath;
  setTimeout(function () { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} }, 300);
}

// 停止前抓一帧当封面：直接复用正在运行的 video/canvas，不额外起解码进程。
// 封面只是列表缩略图，480px 宽、JPEG 0.82 已足够，几万字节；失败不影响录制主流程。
function makePoster() {
  try {
    var src = null, sw = 0, sh = 0;
    var crop = document.getElementById("crop");
    if (S.payload && S.payload.mode === "region" && crop && crop.width > 1 && crop.height > 1) {
      src = crop; sw = crop.width; sh = crop.height;
    } else if (video && video.videoWidth > 1 && video.videoHeight > 1) {
      src = video; sw = video.videoWidth; sh = video.videoHeight;
    }
    if (!src) return null;
    var cvs = document.createElement("canvas");
    var scale = Math.min(1, 480 / sw);
    cvs.width = Math.max(2, Math.round(sw * scale));
    cvs.height = Math.max(2, Math.round(sh * scale));
    var ctx = cvs.getContext("2d", { alpha: false });
    ctx.drawImage(src, 0, 0, cvs.width, cvs.height);
    var url = cvs.toDataURL("image/jpeg", 0.82);
    if (!url || url.length > 900000) return null;
    return url;
  } catch (e) {
    log("poster failed: " + e.message);
    return null;
  }
}

async function finish(info) {
  if (S.phase === "idle" || S.finishing) return;
  S.finishing = true;
  const durationMs = elapsedMs();
  S.phase = "stopping";
  var posterDataUrl = makePoster();
  stopDraw();
  stopProgress();
  setStatus("正在写入文件…");
  const tempPath = S.tempPath;
  try { await S.writeChain; } catch (e) { log("flush chain error " + e.message); }
  await new Promise(function (resolve) {
    try {
      if (!S.writeStream) { resolve(); return; }
      S.writeStream.once("finish", resolve);
      S.writeStream.once("error", resolve);
      S.writeStream.end();
    } catch (e) { resolve(); }
  });
  let bytes = 0;
  try { bytes = tempPath && fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0; } catch (e) { bytes = 0; }
  log("finished duration=" + durationMs + "ms bytes=" + bytes + " mime=" + info.mime);
  send("capture:stopped", {
    tempPath: tempPath,
    durationMs: durationMs,
    bytes: bytes,
    mime: info.mime,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    posterDataUrl: posterDataUrl || null
  });
  cleanup();
  setStatus("采集结束");
}

// ---- 两段式启动 ----
// 实测起录延迟 350~600ms，大头是 getUserMedia 建立采集流（~180ms）与视频元数据就绪。
// 默认有 3 秒倒计时，这些准备完全可以在倒计时期间做完：prepare() 只取流/备画布/混音轨，
// start() 只建 MediaRecorder 并开始写盘，倒计时一结束立刻录，感知延迟降到几十毫秒。
// abort() 通过 prepToken 让进行中的 prepare 失效并释放已拿到的流。
var prepToken = 0;

function cancelledError() {
  var e = new Error("采集已取消");
  e.cancelled = true;
  return e;
}

async function acquire(payload) {
  var token = ++prepToken;
  var perf = payload.perf || {};
  var displayAspect = (payload.displayBounds && payload.displayBounds.height > 0) ? (payload.displayBounds.width / payload.displayBounds.height) : (16 / 9);
  function guard() { if (token !== prepToken) throw cancelledError(); }
  if (!payload.sourceId) throw new Error("缺少采集源");
  var wantSys = !!payload.systemAudio;
  var sourceStream = null;
  var systemAudioTrack = null;
  if (payload.mode === "window") {
    sourceStream = await getUserMediaWith({ video: videoConstraints(payload.sourceId, payload.fps, perf, 0), audio: false });
    S.sourceStreams.push(sourceStream);
    guard();
    if (wantSys) {
      var audioStream = await getUserMediaWith({
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: payload.screenId, maxWidth: 320, maxHeight: 180, maxFrameRate: 5 } },
        audio: { mandatory: { chromeMediaSource: "desktop" } }
      });
      S.sourceStreams.push(audioStream);
      guard();
      systemAudioTrack = audioStream.getAudioTracks()[0] || null;
      // 关键：不要 stop 这条 loopback 流里的视频轨。Windows 上桌面采集会话的音频数据
      // 依赖该流保持运行，停掉视频轨后音轨会变成静音（实测 mean_volume -91dB）。
      // 整条流保留在 S.sourceStreams，cleanup() 时统一停止。
      if (!systemAudioTrack) log("warning: loopback audio track missing");
    }
  } else {
    var audioConstraint = wantSys ? { mandatory: { chromeMediaSource: "desktop" } } : false;
    sourceStream = await getUserMediaWith({ video: videoConstraints(payload.sourceId, payload.fps, perf, displayAspect), audio: audioConstraint });
    S.sourceStreams.push(sourceStream);
    guard();
    if (wantSys) {
      systemAudioTrack = sourceStream.getAudioTracks()[0] || null;
      if (!systemAudioTrack) log("warning: system audio track missing");
    }
  }
  logAudioTrack("system", systemAudioTrack);
  var videoTrack = sourceStream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("未获取到画面数据");
  // 所有模式都挂一个静音 video 元素：区域模式用它逐帧裁剪；全屏/窗口模式用它做封面截图，
  // 同时 videoWidth/videoHeight 也是输出尺寸的权威来源。
  video.srcObject = new MediaStream([videoTrack]);
  video.muted = true;
  await waitEvent(video, "loadedmetadata", 8000);
  guard();
  // 必须播放：视频元素作为采集轨的渲染 sink，能让桌面采集按 30fps 稳定出帧（实测不播放时帧率略降），
  // 同时 videoWidth/videoHeight 是输出尺寸的权威来源，区域模式还要用它逐帧裁剪。
  try { await video.play(); } catch (e) { log("video play: " + e.message); }
  var width = video.videoWidth || 0;
  var height = video.videoHeight || 0;
  if (!width || !height) {
    var st = videoTrack.getSettings ? videoTrack.getSettings() : {};
    width = st.width || 1280;
    height = st.height || 720;
  }
  var micStream = null;
  var micTrack = null;
  if (payload.microphone) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      S.micStream = micStream;
      micTrack = micStream.getAudioTracks()[0] || null;
      guard();
    } catch (e) {
      if (e && e.cancelled) throw e;
      log("microphone failed: " + e.message);
    }
  }
  var outVideoTrack = videoTrack;
  var outAudioTrack = null;
  if (payload.mode === "region") {
    var region = payload.region || {};
    var db = payload.displayBounds || { x: 0, y: 0, width: width, height: height };
    var scaleX = width / (db.width || width);
    var scaleY = height / (db.height || height);
    var sx = Math.max(0, Math.round((region.x - db.x) * scaleX));
    var sy = Math.max(0, Math.round((region.y - db.y) * scaleY));
    var sw = Math.min(width - sx, Math.round(region.width * scaleX));
    var sh = Math.min(height - sy, Math.round(region.height * scaleY));
    if (sw < 16 || sh < 16) throw new Error("选区太小或超出屏幕范围");
    var canvas = document.getElementById("crop");
    // 性能模式：选区高度超过上限时在 canvas 内等比缩小（drawImage 目标尺寸同时完成缩放）
    var capH = perf.maxHeight > 0 ? perf.maxHeight : 0;
    var shrink = capH > 0 && sh > capH ? capH / sh : 1;
    var cw = evenDim(sw * shrink);
    var ch = evenDim(sh * shrink);
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext("2d", { alpha: false });
    var draw = function () { try { ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch); } catch (e) {} };
    draw();
    S.loopActive = true;
    // 采集窗口是隐藏窗（show:false），video 元素不参与合成，requestVideoFrameCallback
    // 几乎不触发（实测只有 ~1.3fps），因此这里必须用固定定时器重绘 canvas。
    var frameMs = Math.max(5, Math.round(1000 / (payload.fps || 30)));
    // 双时钟消除：默认 captureStream(fps) 会按固定时钟再采一次 canvas，和这里的重绘时钟错位时
    // 会产出重复帧/漏帧（60fps 区域录制实测只有 53fps）。改成 captureStream(0) + 每次 draw 后
    // requestFrame()，每绘制一帧才交给编码器一帧；不支持 requestFrame 的环境回退到固定帧率。
    var canvasStream = canvas.captureStream(0);
    S.sourceStreams.push(canvasStream);
    outVideoTrack = canvasStream.getVideoTracks()[0];
    var canRequestFrame = !!(outVideoTrack && typeof outVideoTrack.requestFrame === "function");
    if (!canRequestFrame) {
      try { canvasStream.getVideoTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e) {}
      canvasStream = canvas.captureStream(payload.fps || 30);
      S.sourceStreams.push(canvasStream);
      outVideoTrack = canvasStream.getVideoTracks()[0];
    }
    var loop = function () {
      if (!S.loopActive) return;
      draw();
      if (canRequestFrame) { try { outVideoTrack.requestFrame(); } catch (e) {} }
      S.drawTimer = setTimeout(loop, frameMs);
    };
    loop();
    log("region draw timer " + frameMs + "ms requestFrame=" + canRequestFrame);
    width = cw;
    height = ch;
    log("region crop sx=" + sx + " sy=" + sy + " sw=" + sw + " sh=" + sh + " out=" + cw + "x" + ch + " shrink=" + shrink);
  }
  if (systemAudioTrack && micTrack) {
    try {
      var ac = new AudioContext();
      S.audioContext = ac;
      if (ac.state === "suspended") { try { await ac.resume(); } catch (e) {} }
      var dest = ac.createMediaStreamDestination();
      ac.createMediaStreamSource(new MediaStream([systemAudioTrack])).connect(dest);
      ac.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
      outAudioTrack = dest.stream.getAudioTracks()[0];
      log("audio mix state=" + ac.state);
    } catch (e) {
      log("audio mix failed: " + e.message);
      outAudioTrack = systemAudioTrack;
    }
  } else if (systemAudioTrack) {
    outAudioTrack = systemAudioTrack;
  } else if (micTrack) {
    outAudioTrack = micTrack;
  }
  logAudioTrack("out", outAudioTrack);
  var mime = pickMime(payload.format, !!outAudioTrack, perf.preferVp8 === true);
  if (!mime) throw new Error("当前环境不支持录制格式");
  var ext = mime.indexOf("mp4") >= 0 ? ".mp4" : ".webm";
  var rawBitrate = videoBitrate(width, height, payload.fps, payload.quality);
  var bitrate = perf.bitrateCap > 0 ? Math.min(rawBitrate, perf.bitrateCap) : rawBitrate;
  // 采集源中途断开：录制中报错并自动停止（与旧实现一致）
  videoTrack.addEventListener("ended", function () {
    log("video track ended");
    if (S.phase === "recording" || S.phase === "paused") {
      send("capture:error", { message: "采集源已断开", code: "source_ended" });
      stopRecording();
    }
  });
  return {
    token: token,
    payload: payload,
    sessionId: payload.sessionId,
    outVideoTrack: outVideoTrack,
    outAudioTrack: outAudioTrack,
    micTrack: micTrack,
    width: width,
    height: height,
    hasAudio: !!outAudioTrack,
    mime: mime,
    tempPath: payload.outBasePath + ext,
    bitrate: bitrate
  };
}

function beginRecording(prep) {
  var payload = prep.payload;
  var perf = payload.perf || {};
  var mime = prep.mime;
  var width = prep.width;
  var height = prep.height;
  var hasAudio = prep.hasAudio;
  S.tempPath = prep.tempPath;
  try { if (fs.existsSync(S.tempPath)) fs.unlinkSync(S.tempPath); } catch (e) {}
  S.writeStream = fs.createWriteStream(S.tempPath);
  S.writeChain = Promise.resolve();
  S.writtenBytes = 0;
  var recordStream = new MediaStream();
  recordStream.addTrack(prep.outVideoTrack);
  if (prep.outAudioTrack) recordStream.addTrack(prep.outAudioTrack);
  S.recordStream = recordStream;
  var recorder = new MediaRecorder(recordStream, {
    mimeType: mime,
    videoBitsPerSecond: prep.bitrate,
    audioBitsPerSecond: perf.audioBitrate || 128000
  });
  S.recorder = recorder;
  recorder.ondataavailable = function (ev) {
    if (!ev.data || !ev.data.size) return;
    var blob = ev.data;
    S.writeChain = S.writeChain.then(async function () {
      var buf = Buffer.from(await blob.arrayBuffer());
      S.writtenBytes += buf.length;
      if (!S.writeStream) return;
      if (!S.writeStream.write(buf)) {
        await new Promise(function (resolve) { S.writeStream.once("drain", resolve); });
      }
    }).catch(function (e) { log("write error: " + e.message); });
  };
  recorder.onerror = function (ev) {
    var msg = (ev && ev.error && ev.error.message) || "录制器错误";
    log("recorder error " + msg);
    send("capture:error", { message: msg, code: "recorder_error" });
    try { discardTemp(); } catch (e) {}
    cleanup();
  };
  recorder.onstop = function () {
    var info = S.finalInfo || { mime: mime, width: width, height: height, hasAudio: hasAudio };
    finish(info);
  };
  S.finalInfo = { mime: mime, width: width, height: height, hasAudio: hasAudio };
  S.phase = "recording";
  S.activeStart = Date.now();
  S.accumulated = 0;
  recorder.start(perf.chunkMs || 1000);
  if (payload.diagAudio === true) startAudioMonitor(prep.outAudioTrack);
  setStatus("正在录制 " + width + "x" + height);
  S.progressTimer = setInterval(function () {
    if (S.phase !== "recording" && S.phase !== "paused") return;
    send("capture:progress", {
      bytes: S.writtenBytes,
      elapsedMs: elapsedMs(),
      width: width,
      height: height,
      hasAudio: hasAudio,
      mime: S.finalInfo.mime
    });
  }, perf.progressMs || 1000);
  send("capture:started", {
    width: width,
    height: height,
    fps: payload.fps,
    mime: S.finalInfo.mime,
    bitrate: prep.bitrate,
    chunkMs: perf.chunkMs || 1000,
    perfEnabled: perf.enabled === true,
    hasAudio: hasAudio,
    hasMic: !!prep.micTrack,
    tempPath: S.tempPath
  });
  log("recorder started bitrate=" + prep.bitrate + " mime=" + S.finalInfo.mime + " chunk=" + (perf.chunkMs || 1000) + "ms perf=" + (perf.enabled === true));
}

// 倒计时期间先把采集流准备好，start 时只差一个 MediaRecorder。
async function prepare(payload) {
  if (S.phase !== "idle") { send("capture:error", { message: "采集器正在使用中", code: "busy" }); return; }
  S.phase = "preparing";
  S.finishing = false;
  S.payload = payload;
  setStatus("正在准备采集…");
  log("prepare mode=" + payload.mode + " source=" + payload.sourceId + " format=" + payload.format + " sys=" + payload.systemAudio + " mic=" + payload.microphone + " quality=" + payload.quality + " perf=" + JSON.stringify(payload.perf || {}));
  try {
    var prep = await acquire(payload);
    if (prep.token !== prepToken) throw cancelledError();
    S.prepared = prep;
    S.phase = "prepared";
    send("capture:prepared", {
      sessionId: prep.sessionId,
      width: prep.width,
      height: prep.height,
      fps: payload.fps,
      mime: prep.mime,
      bitrate: prep.bitrate,
      hasAudio: prep.hasAudio,
      hasMic: !!prep.micTrack,
      tempPath: prep.tempPath
    });
    log("prepare done " + prep.width + "x" + prep.height + " mime=" + prep.mime + " audio=" + prep.hasAudio);
  } catch (e) {
    if (e && e.cancelled) { log("prepare cancelled"); cleanup(); return; }
    log("prepare failed: " + ((e && e.stack) || e));
    var code = payload.mode === "window" ? "window_capture_failed" : "capture_failed";
    send("capture:error", { message: (e && e.message) || "启动录制失败", code: code });
    try { discardTemp(); } catch (err) {}
    cleanup();
  }
}

async function start(payload) {
  if (S.phase === "prepared" && S.prepared && S.prepared.sessionId === payload.sessionId) {
    var ready = S.prepared;
    S.prepared = null;
    S.payload = payload;
    S.phase = "starting";
    try {
      beginRecording(ready);
    } catch (e) {
      log("start (prepared) failed: " + ((e && e.stack) || e));
      var code2 = payload.mode === "window" ? "window_capture_failed" : "capture_failed";
      send("capture:error", { message: (e && e.message) || "启动录制失败", code: code2 });
      try { discardTemp(); } catch (err) {}
      cleanup();
    }
    return;
  }
  // 没有预热（例如倒计时为 0，或准备阶段被跳过）：退化为一次性启动
  if (S.phase !== "idle") { send("capture:error", { message: "采集器正在使用中", code: "busy" }); return; }
  S.phase = "starting";
  S.finishing = false;
  S.payload = payload;
  setStatus("正在启动采集…");
  log("start mode=" + payload.mode + " source=" + payload.sourceId + " format=" + payload.format + " sys=" + payload.systemAudio + " mic=" + payload.microphone + " quality=" + payload.quality + " perf=" + JSON.stringify(payload.perf || {}));
  try {
    var prep = await acquire(payload);
    if (prep.token !== prepToken) throw cancelledError();
    S.prepared = prep;
    beginRecording(prep);
    S.prepared = null;
  } catch (e) {
    if (e && e.cancelled) { log("start cancelled"); cleanup(); return; }
    log("start failed: " + ((e && e.stack) || e));
    var code = payload.mode === "window" ? "window_capture_failed" : "capture_failed";
    send("capture:error", { message: (e && e.message) || "启动录制失败", code: code });
    try { discardTemp(); } catch (err) {}
    cleanup();
  }
}

function pauseRecording() {
  if (!S.recorder || S.phase !== "recording") return;
  try { S.recorder.pause(); } catch (e) { log("pause failed " + e.message); return; }
  S.accumulated += Math.max(0, Date.now() - S.activeStart);
  S.activeStart = 0;
  S.phase = "paused";
  setStatus("已暂停");
  send("capture:paused", { elapsedMs: S.accumulated });
}

function resumeRecording() {
  if (!S.recorder || S.phase !== "paused") return;
  try { S.recorder.resume(); } catch (e) { log("resume failed " + e.message); return; }
  S.activeStart = Date.now();
  S.phase = "recording";
  setStatus("正在录制");
  send("capture:resumed", { elapsedMs: elapsedMs() });
}

function stopRecording() {
  if (S.phase === "idle" || S.phase === "stopping") return;
  if (S.phase === "prepared" || S.phase === "preparing") { abort(); return; }
  if (S.phase === "paused") {
    if (S.recorder && S.recorder.state === "paused") {
      try { S.recorder.resume(); } catch (e) {}
    }
  }
  S.phase = "stopping";
  stopDraw();
  try { if (S.recorder && S.recorder.state !== "inactive") S.recorder.stop(); else finish(S.finalInfo || {}); } catch (e) { finish(S.finalInfo || {}); }
}

function abort() {
  log("abort");
  prepToken++;
  S.prepared = null;
  try { if (S.recorder && S.recorder.state !== "inactive") S.recorder.stop(); } catch (e) {}
  try { discardTemp(); } catch (e) {}
  cleanup();
  send("capture:cancelled", {});
}

ipcRenderer.on("capture:prepare", function (ev, payload) { prepare(payload); });
ipcRenderer.on("capture:start", function (ev, payload) { start(payload); });
ipcRenderer.on("capture:stop", function () { stopRecording(); });
ipcRenderer.on("capture:pause", function () { pauseRecording(); });
ipcRenderer.on("capture:resume", function () { resumeRecording(); });
ipcRenderer.on("capture:abort", function () { abort(); });

window.addEventListener("error", function (ev) { log("window error: " + (ev.message || "")); });
window.addEventListener("unhandledrejection", function (ev) { log("unhandled rejection: " + ((ev.reason && ev.reason.message) || ev.reason || "")); });

send("capture:ready", { ok: true });
log("capture engine ready");
