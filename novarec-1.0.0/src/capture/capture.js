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
  finishing: false
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

async function finish(info) {
  if (S.phase === "idle" || S.finishing) return;
  S.finishing = true;
  const durationMs = elapsedMs();
  S.phase = "stopping";
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
    hasAudio: info.hasAudio
  });
  cleanup();
  setStatus("采集结束");
}

async function start(payload) {
  if (S.phase !== "idle") { send("capture:error", { message: "采集器正在使用中", code: "busy" }); return; }
  S.phase = "starting";
  S.finishing = false;
  S.payload = payload;
  setStatus("正在启动采集…");
  log("start mode=" + payload.mode + " source=" + payload.sourceId + " format=" + payload.format + " sys=" + payload.systemAudio + " mic=" + payload.microphone + " quality=" + payload.quality + " perf=" + JSON.stringify(payload.perf || {}));
  const perf = payload.perf || {};
  const displayAspect = (payload.displayBounds && payload.displayBounds.height > 0) ? (payload.displayBounds.width / payload.displayBounds.height) : (16 / 9);
  try {
    if (!payload.sourceId) throw new Error("缺少采集源");
    const wantSys = !!payload.systemAudio;
    let sourceStream = null;
    let systemAudioTrack = null;
    if (payload.mode === "window") {
      sourceStream = await getUserMediaWith({ video: videoConstraints(payload.sourceId, payload.fps, perf, 0), audio: false });
      S.sourceStreams.push(sourceStream);
      if (wantSys) {
        const audioStream = await getUserMediaWith({
          video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: payload.screenId, maxWidth: 320, maxHeight: 180, maxFrameRate: 5 } },
          audio: { mandatory: { chromeMediaSource: "desktop" } }
        });
        S.sourceStreams.push(audioStream);
        systemAudioTrack = audioStream.getAudioTracks()[0] || null;
        // 关键：不要 stop 这条 loopback 流里的视频轨。Windows 上桌面采集会话的音频数据
        // 依赖该流保持运行，停掉视频轨后音轨会变成静音（实测 mean_volume -91dB）。
        // 整条流保留在 S.sourceStreams，cleanup() 时统一停止。
        if (!systemAudioTrack) log("warning: loopback audio track missing");
      }
    } else {
      const audioConstraint = wantSys ? { mandatory: { chromeMediaSource: "desktop" } } : false;
      sourceStream = await getUserMediaWith({ video: videoConstraints(payload.sourceId, payload.fps, perf, displayAspect), audio: audioConstraint });
      S.sourceStreams.push(sourceStream);
      if (wantSys) {
        systemAudioTrack = sourceStream.getAudioTracks()[0] || null;
        if (!systemAudioTrack) log("warning: system audio track missing");
      }
    }
    logAudioTrack("system", systemAudioTrack);
    const videoTrack = sourceStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error("未获取到画面数据");
    video.srcObject = new MediaStream([videoTrack]);
    video.muted = true;
    await waitEvent(video, "loadedmetadata", 8000);
    try { await video.play(); } catch (e) { log("video play: " + e.message); }
    let width = video.videoWidth || 0;
    let height = video.videoHeight || 0;
    if (!width || !height) {
      const st = videoTrack.getSettings ? videoTrack.getSettings() : {};
      width = st.width || 1280;
      height = st.height || 720;
    }
    let micStream = null;
    let micTrack = null;
    if (payload.microphone) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        S.micStream = micStream;
        micTrack = micStream.getAudioTracks()[0] || null;
      } catch (e) { log("microphone failed: " + e.message); }
    }
    let outVideoTrack = videoTrack;
    let outAudioTrack = null;
    if (payload.mode === "region") {
      const region = payload.region || {};
      const db = payload.displayBounds || { x: 0, y: 0, width: width, height: height };
      const scaleX = width / (db.width || width);
      const scaleY = height / (db.height || height);
      const sx = Math.max(0, Math.round((region.x - db.x) * scaleX));
      const sy = Math.max(0, Math.round((region.y - db.y) * scaleY));
      const sw = Math.min(width - sx, Math.round(region.width * scaleX));
      const sh = Math.min(height - sy, Math.round(region.height * scaleY));
      if (sw < 16 || sh < 16) throw new Error("选区太小或超出屏幕范围");
      const canvas = document.getElementById("crop");
      // 性能模式：选区高度超过上限时在 canvas 内等比缩小（drawImage 目标尺寸同时完成缩放）
      const capH = perf.maxHeight > 0 ? perf.maxHeight : 0;
      const shrink = capH > 0 && sh > capH ? capH / sh : 1;
      const cw = evenDim(sw * shrink);
      const ch = evenDim(sh * shrink);
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d", { alpha: false });
      const draw = function () { try { ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cw, ch); } catch (e) {} };
      draw();
      S.loopActive = true;
      // 采集窗口是隐藏窗（show:false），video 元素不参与合成，requestVideoFrameCallback
      // 几乎不触发（实测只有 ~1.3fps），因此这里必须用固定定时器重绘 canvas。
      const frameMs = Math.max(5, Math.round(1000 / (payload.fps || 30)));
      const loop = function () {
        if (!S.loopActive) return;
        draw();
        S.drawTimer = setTimeout(loop, frameMs);
      };
      loop();
      log("region draw timer " + frameMs + "ms");
      const canvasStream = canvas.captureStream(payload.fps || 30);
      S.sourceStreams.push(canvasStream);
      outVideoTrack = canvasStream.getVideoTracks()[0];
      width = cw;
      height = ch;
      log("region crop sx=" + sx + " sy=" + sy + " sw=" + sw + " sh=" + sh + " out=" + cw + "x" + ch + " shrink=" + shrink);
    }
    if (systemAudioTrack && micTrack) {
      try {
        const ac = new AudioContext();
        S.audioContext = ac;
        if (ac.state === "suspended") { try { await ac.resume(); } catch (e) {} }
        const dest = ac.createMediaStreamDestination();
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
    const hasAudio = !!outAudioTrack;
    logAudioTrack("out", outAudioTrack);
    let mime = pickMime(payload.format, hasAudio, perf.preferVp8 === true);
    if (!mime) throw new Error("当前环境不支持录制格式");
    const ext = mime.indexOf("mp4") >= 0 ? ".mp4" : ".webm";
    S.tempPath = payload.outBasePath + ext;
    try { if (fs.existsSync(S.tempPath)) fs.unlinkSync(S.tempPath); } catch (e) {}
    S.writeStream = fs.createWriteStream(S.tempPath);
    S.writeChain = Promise.resolve();
    S.writtenBytes = 0;
    const recordStream = new MediaStream();
    recordStream.addTrack(outVideoTrack);
    if (outAudioTrack) recordStream.addTrack(outAudioTrack);
    S.recordStream = recordStream;
    const rawBitrate = videoBitrate(width, height, payload.fps, payload.quality);
    const bitrate = perf.bitrateCap > 0 ? Math.min(rawBitrate, perf.bitrateCap) : rawBitrate;
    const recorder = new MediaRecorder(recordStream, {
      mimeType: mime,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: perf.audioBitrate || 128000
    });
    S.recorder = recorder;
    recorder.ondataavailable = function (ev) {
      if (!ev.data || !ev.data.size) return;
      const blob = ev.data;
      S.writeChain = S.writeChain.then(async function () {
        const buf = Buffer.from(await blob.arrayBuffer());
        S.writtenBytes += buf.length;
        if (!S.writeStream) return;
        if (!S.writeStream.write(buf)) {
          await new Promise(function (resolve) { S.writeStream.once("drain", resolve); });
        }
      }).catch(function (e) { log("write error: " + e.message); });
    };
    recorder.onerror = function (ev) {
      const msg = (ev && ev.error && ev.error.message) || "录制器错误";
      log("recorder error " + msg);
      send("capture:error", { message: msg, code: "recorder_error" });
      try { discardTemp(); } catch (e) {}
      cleanup();
    };
    recorder.onstop = function () {
      const info = S.finalInfo || { mime: mime, width: width, height: height, hasAudio: hasAudio };
      finish(info);
    };
    S.finalInfo = { mime: mime, width: width, height: height, hasAudio: hasAudio };
    S.phase = "recording";
    S.activeStart = Date.now();
    S.accumulated = 0;
    recorder.start(perf.chunkMs || 1000);
    if (payload.diagAudio === true) startAudioMonitor(outAudioTrack);
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
    videoTrack.addEventListener("ended", function () {
      log("video track ended");
      if (S.phase === "recording" || S.phase === "paused") {
        send("capture:error", { message: "采集源已断开", code: "source_ended" });
        stopRecording();
      }
    });
    send("capture:started", {
      width: width,
      height: height,
      fps: payload.fps,
      mime: S.finalInfo.mime,
      bitrate: bitrate,
      chunkMs: perf.chunkMs || 1000,
      perfEnabled: perf.enabled === true,
      hasAudio: hasAudio,
      hasMic: !!micTrack,
      tempPath: S.tempPath
    });
    log("recorder started bitrate=" + bitrate + " mime=" + S.finalInfo.mime + " chunk=" + (perf.chunkMs || 1000) + "ms perf=" + (perf.enabled === true));
  } catch (e) {
    log("start failed: " + ((e && e.stack) || e));
    const code = payload.mode === "window" ? "window_capture_failed" : "capture_failed";
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
  try { if (S.recorder && S.recorder.state !== "inactive") S.recorder.stop(); } catch (e) {}
  try { discardTemp(); } catch (e) {}
  cleanup();
  send("capture:cancelled", {});
}

ipcRenderer.on("capture:start", function (ev, payload) { start(payload); });
ipcRenderer.on("capture:stop", function () { stopRecording(); });
ipcRenderer.on("capture:pause", function () { pauseRecording(); });
ipcRenderer.on("capture:resume", function () { resumeRecording(); });
ipcRenderer.on("capture:abort", function () { abort(); });

window.addEventListener("error", function (ev) { log("window error: " + (ev.message || "")); });
window.addEventListener("unhandledrejection", function (ev) { log("unhandled rejection: " + ((ev.reason && ev.reason.message) || ev.reason || "")); });

send("capture:ready", { ok: true });
log("capture engine ready");
