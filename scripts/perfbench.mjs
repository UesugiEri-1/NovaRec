// T6: NovaRec 录制期性能基准（CPU / 内存 / 起停延迟 / 落盘效率）
// 运行: unset ELECTRON_RUN_AS_NODE; ./node_modules/electron/dist/electron.exe scripts/perfbench.mjs --no-sandbox
// 环境变量:
//   PERFBENCH_CASES=id1,id2   只跑指定用例
//   PERFBENCH_DURATION=10000  每用例录制时长(ms)
//   PERFBENCH_TAG=run         结果文件后缀
// 产物: artifacts/perfbench/result-<tag>.json, artifacts/perfbench-<tag>.log
import { app, BrowserWindow, desktopCapturer } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts", "perfbench");
const USER_DATA = path.join(OUT_DIR, "userData");
const VIDEO_DIR = path.join(OUT_DIR, "out");
const TAG = process.env.PERFBENCH_TAG || "run";
const LOG_FILE = path.join(ROOT, "artifacts", "perfbench-" + TAG + ".log");
const RESULT_FILE = path.join(OUT_DIR, "result-" + TAG + ".json");
const DURATION = Math.max(2000, parseInt(process.env.PERFBENCH_DURATION || "10000", 10));
// 倒计时用于测量两段式启动：postCountdownMs = 倒计时结束(phase=starting) → 真正开录(phase=recording)
const COUNTDOWN = Math.max(0, Math.min(10, parseInt(process.env.PERFBENCH_COUNTDOWN || "0", 10)));
const PREWARM = process.env.PERFBENCH_PREWARM === "1";

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.writeFileSync(LOG_FILE, "", "utf8");

app.commandLine.appendSwitch("no-sandbox");
// 同 main.js：避免演示窗被遮挡后 rAF 被节流（表现为桌面几乎不更新、采集掉到 ~1fps 的假故障）
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setPath("userData", USER_DATA);

const logLines = [];
const origLog = console.log.bind(console);
function appendLog(line) { logLines.push(line); try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {} }
function log(s) { const line = new Date().toISOString() + " " + s; appendLog(line); try { origLog(line); } catch (e) {} }
function logErr(s) { const line = new Date().toISOString() + " [stderr] " + s; appendLog(line); }
console.log = function () { log(" " + Array.prototype.map.call(arguments, function (a) { return typeof a === "string" ? a : JSON.stringify(a); }).join(" ")); };
console.error = function () { logErr(Array.prototype.map.call(arguments, function (a) { return (a && a.stack) || String(a); }).join(" ")); };

const recorderMod = require("../src/main/recorder.js");
const ffmpeg = require("../src/main/ffmpeg.js");
const sourcesApi = require("../src/main/sources.js");
const storeMod = require("../src/main/store.js");
const perfMod = require("../src/main/perf.js");
const { Recorder } = recorderMod;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function writeResult(o) { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(o, null, 2), "utf8"); } catch (e) {} }
function mb(kb) { return Math.round((kb / 1024) * 10) / 10; }
function pct(part, total) { return total > 0 ? Math.round((part / total) * 1000) / 10 : null; }

function stats(arr) {
  if (!arr || !arr.length) return { n: 0, mean: null, p95: null, max: null, min: null };
  const s = arr.slice().sort(function (a, b) { return a - b; });
  const sum = s.reduce(function (a, b) { return a + b; }, 0);
  return {
    n: s.length,
    mean: Math.round((sum / s.length) * 100) / 100,
    p95: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] * 100) / 100,
    max: Math.round(s[s.length - 1] * 100) / 100,
    min: Math.round(s[0] * 100) / 100
  };
}

// 系统音频端点状态（静音机器上不影响本基准，仅记录）
function audioEndpointState() {
  try {
    const script = path.join(__dirname, "audio-state.ps1");
    if (!fs.existsSync(script)) return { checked: false };
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "state"], { encoding: "utf8", timeout: 20000, windowsHide: true });
    const m = /AUDIO_MUTE=(\w+)/i.exec(out);
    const v = /AUDIO_VOLUME=([0-9.]+)/i.exec(out);
    return { checked: !!m, mute: m ? /true/i.test(m[1]) : null, volume: v ? parseFloat(v[1]) : null };
  } catch (e) { return { checked: false, error: String((e && e.message) || e) }; }
}

const DEMO_TITLE = "NovaRec 性能基准演示窗";
const DEMO_HTML = [
  "<!doctype html><html><head><meta charset='utf-8'><title>", DEMO_TITLE, "</title></head>",
  "<body style='margin:0;background:#0b1020;overflow:hidden'>",
  "<canvas id='c' width='800' height='600'></canvas>",
  "<script>",
  "var c=document.getElementById('c'),x=c.getContext('2d'),t=0,raf=0;",
  "window.__rafc=function(){return raf;};",
  "function f(){raf++;t+=0.05;var g=x.createLinearGradient(0,0,800,600);",
  "g.addColorStop(0,'hsl('+((t*18)%360)+',70%,22%)');g.addColorStop(1,'hsl('+((t*18+120)%360)+',70%,42%)');",
  "x.fillStyle=g;x.fillRect(0,0,800,600);",
  "for(var i=0;i<6;i++){x.fillStyle='hsla('+((t*40+i*60)%360)+',85%,65%,0.85)';",
  "x.beginPath();x.arc(400+Math.cos(t+i)*240,300+Math.sin(t*1.3+i)*180,26+i*5,0,Math.PI*2);x.fill();}",
  "x.fillStyle='#fff';x.font='bold 34px sans-serif';x.fillText('NovaRec 性能基准',40,60);",
  "requestAnimationFrame(f)}f();",
  "var ac=null,osc=null,gain=null;",
  "window.__startTone=function(){try{if(ac)return;var AC=window.AudioContext||window.webkitAudioContext;ac=new AC();",
  "osc=ac.createOscillator();gain=ac.createGain();osc.type='sine';osc.frequency.value=440;gain.gain.value=0.3;",
  "osc.connect(gain);gain.connect(ac.destination);osc.start();if(ac.state!=='running'){ac.resume();}",
  "setInterval(function(){if(ac&&ac.state==='suspended'){ac.resume();}},400);}catch(e){}};",
  "window.__toneState=function(){return ac?ac.state:'none';};",
  "</script></body></html>"
].join("");

function parseFfmpegText(text) {
  const out = { width: null, height: null, codec: null, audioCodec: null, audioSampleRate: null, durationSec: null, fps: null };
  const vline = (text.match(/Video:\s*([^\n]+)/i) || [])[1];
  if (vline) {
    out.codec = vline.split(",")[0].trim();
    const size = vline.match(/(\d{2,5})x(\d{2,5})/);
    if (size) { out.width = parseInt(size[1], 10); out.height = parseInt(size[2], 10); }
    const fps = vline.match(/([0-9.]+)\s*fps/);
    if (fps) out.fps = parseFloat(fps[1]);
  }
  const aline = (text.match(/Audio:\s*([^\n]+)/i) || [])[1];
  if (aline) {
    out.audioCodec = aline.split(",")[0].trim();
    const rate = aline.match(/(\d+)\s*Hz/i);
    if (rate) out.audioSampleRate = parseInt(rate[1], 10);
  }
  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dur) out.durationSec = Math.round((parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + parseFloat(dur[3])) * 1000) / 1000;
  return out;
}

function countFrames(file) {
  try {
    const { spawnSync } = require("node:child_process");
    const r = spawnSync(path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe"), ["-hide_banner", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"], { encoding: "utf8", timeout: 120000, windowsHide: true });
    const out = String(r.stdout || "") + String(r.stderr || "");
    const ms = out.match(/frame=\s*(\d+)/g) || [];
    if (!ms.length) return null;
    return parseInt(ms[ms.length - 1].replace(/[^0-9]/g, ""), 10);
  } catch (e) { return null; }
}

function waitSaved(rec, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () { if (done) return; done = true; reject(new Error("等待 saved 事件超时(" + timeoutMs + "ms)")); }, timeoutMs);
    rec.once("saved", function (item) { if (done) return; done = true; clearTimeout(timer); resolve(item); });
  });
}

// ---- 用例矩阵 ----
const regionDip = { x: 80, y: 80, width: 1280, height: 720 };
const CASES = [
  { id: "screen-mp4-high30-native", format: "mp4", fps: 30, quality: "high", performanceMode: "off", mode: "screen" },
  { id: "screen-webm-high30-native", format: "webm", fps: 30, quality: "high", performanceMode: "off", mode: "screen" },
  { id: "screen-mp4-high60-native", format: "mp4", fps: 60, quality: "high", performanceMode: "off", mode: "screen" },
  { id: "screen-mp4-low30-native", format: "mp4", fps: 30, quality: "low", performanceMode: "off", mode: "screen" },
  { id: "region-mp4-high30-native", format: "mp4", fps: 30, quality: "high", performanceMode: "off", mode: "region" },
  { id: "window-mp4-high30-native", format: "mp4", fps: 30, quality: "high", performanceMode: "off", mode: "window" },
  { id: "screen-mp4-high30-auto", format: "mp4", fps: 30, quality: "high", performanceMode: "auto", mode: "screen" },
  { id: "screen-webm-high30-auto", format: "webm", fps: 30, quality: "high", performanceMode: "auto", mode: "screen" },
  // 瓶颈定位用例（v6）：60fps 在小画面能否达成、VP8 720p 低帧率是否可复现
  { id: "region-mp4-high60-small", format: "mp4", fps: 60, quality: "high", performanceMode: "off", mode: "region", region: { x: 80, y: 80, width: 640, height: 360 } },
  { id: "window-mp4-high60-native", format: "mp4", fps: 60, quality: "high", performanceMode: "off", mode: "window" }
];
const only = String(process.env.PERFBENCH_CASES || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
const plan = only.length ? CASES.filter(function (c) { return only.indexOf(c.id) >= 0; }) : CASES;

const result = {
  ok: false, tag: TAG, startedAt: new Date().toISOString(), pid: process.pid,
  electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
  durationPerCaseMs: DURATION, hardware: null, display: null, audioEndpoint: null,
  environment: null, cases: [], idle: null, error: null
};
const hw = perfMod.getHardware();
result.hardware = hw;

async function main() {
  log("perfbench start tag=" + TAG + " pid=" + process.pid + " electron=" + process.versions.electron);
  log("hardware=" + JSON.stringify(hw) + " duration=" + DURATION + "ms");
  log("cases plan=" + JSON.stringify(plan.map(function (c) { return c.id; })));

  if (!app.requestSingleInstanceLock()) { log("FAIL: 已存在另一个 perfbench 实例"); result.error = "single-instance"; return 3; }
  // 基准不依赖系统音频端点状态（静音机器同样可测 CPU/内存），跳过 PowerShell 探测
  result.audioEndpoint = { checked: false, skipped: true };
  log("audioEndpoint=skipped");

  const displayInfo = sourcesApi.getDisplayInfo();
  const primary = displayInfo.displays.find(function (d) { return d.primary; }) || displayInfo.displays[0];
  if (!primary) { result.error = "未检测到显示器"; return 3; }
  const scale = primary.scaleFactor || 1;
  result.display = { id: primary.id, bounds: primary.bounds, scaleFactor: scale };
  log("display primary=" + JSON.stringify(primary));

  const sysInfo = {
    cpu: (function () { try { return require("node:os").cpus()[0].model; } catch (e) { return ""; } })(),
    cores: hw.cores, memGB: hw.memGB, platform: process.platform, arch: process.arch
  };
  result.environment = sysInfo;

  // 画面源窗口：始终可见+置顶，且不会被"主窗隐藏"影响 —— 保证录制期间桌面持续有画面更新
  // （此前把动画窗同时当作"主窗"传给 Recorder，screen/region 用例开录前会隐藏它，桌面变静止，
  //   DXGI 桌面复制不再产生新帧，MediaRecorder 帧数掉到 3-30 帧/8s，属于测试环境假故障）
  const demoWin = new BrowserWindow({
    width: 800, height: 600, x: 60, y: 60, frame: false, show: true, title: DEMO_TITLE, backgroundColor: "#0b1020",
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, spellcheck: false }
  });
  await demoWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(DEMO_HTML));
  demoWin.setTitle(DEMO_TITLE);
  try { demoWin.setAlwaysOnTop(true, "screen-saver"); } catch (e) {}
  try { demoWin.setIgnoreMouseEvents(true); } catch (e) {}
  await sleep(900);
  await demoWin.webContents.executeJavaScript("window.__startTone && window.__startTone();", true).catch(function () {});
  try { demoWin.showInactive(); } catch (e) {}

  // 占位"应用主窗"：screen/region 用例开录前会被隐藏（还原真实 hideMainWindow 行为），但不是画面来源
  const shellWin = new BrowserWindow({
    width: 460, height: 320, x: 1180, y: 620, frame: false, show: true, title: "NovaRec 基准占位主窗",
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  });
  await shellWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<body style='margin:0;background:#12172b;color:#9fb3ff;font:20px sans-serif;display:flex;align-items:center;justify-content:center'>NovaRec 占位主窗</body>"));
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const st = await demoWin.webContents.executeJavaScript("window.__toneState ? window.__toneState() : 'none'", true).catch(function () { return "err"; });
    if (st === "running") break;
  }

  const winSources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
  const demoSrc = winSources.find(function (s) { return (s.name || "").indexOf("性能基准") >= 0; });
  log("demo window source=" + (demoSrc ? demoSrc.id + "|" + demoSrc.name : "NOT FOUND"));
  if (!demoSrc) { result.error = "未找到演示窗口采集源"; return 3; }

  const sourceData = await sourcesApi.listSources();
  const primaryScreen = sourcesApi.screenForDisplay(sourceData.screens, displayInfo.displays, primary) || sourceData.screens[0];
  const screenSourceId = primaryScreen ? primaryScreen.id : (sourceData.screens[0] || {}).id;
  log("screen source=" + screenSourceId);

  const settings = {
    outputDir: VIDEO_DIR, format: "mp4", fps: 30, quality: "high", systemAudio: true, microphone: false,
    countdown: COUNTDOWN, hideMainWindow: true, micDeviceId: "default", lastSourceId: screenSourceId, performanceMode: "off"
  };
  const library = new storeMod.Library(path.join(USER_DATA, "library.json"));
  const rec = new Recorder({ userDataPath: app.getPath("userData"), getSettings: function () { return settings; }, getMainWindow: function () { return shellWin; }, library: library });
  const savedItems = [];
  rec.on("saved", function (item) { savedItems.push(item); log("EVENT saved file=" + item.filePath + " bytes=" + item.sizeBytes + " durationMs=" + item.durationMs); });
  rec.on("error", function (p) { log("EVENT error " + JSON.stringify(p)); });
  // 起录延迟分解：phase=starting 是倒计时结束/准备完成的时刻，phase=recording 是真正开录时刻
  let stateMarks = { starting: 0, recording: 0 };
  rec.on("state", function (s) {
    if (!s) return;
    // getState() 映射：phase=starting → state="processing"；phase=recording → state="recording"
    if (s.state === "processing" && !stateMarks.starting) stateMarks.starting = Date.now();
    if (s.state === "recording" && !stateMarks.recording) stateMarks.recording = Date.now();
  });

  const el = monitorEventLoopDelay({ resolution: 1 });
  el.enable();

  function reqFor(c) {
    if (c.mode === "screen") return { mode: "screen", sourceId: screenSourceId };
    if (c.mode === "region") return { mode: "region", region: Object.assign({ displayId: primary.id }, c.region || regionDip) };
    return { mode: "window", sourceId: demoSrc.id };
  }

  // 采样：每 500ms 一次 app.getAppMetrics()
  function sampleOnce(sink) {
    let metrics = [];
    try { metrics = app.getAppMetrics(); } catch (e) { return; }
    const byType = {};
    let totalCpu = 0;
    let totalWsKb = 0;
    metrics.forEach(function (p) {
      const t = p.type || "Other";
      const cpu = (p.cpu && typeof p.cpu.percentCPUUsage === "number") ? p.cpu.percentCPUUsage : 0;
      const ws = (p.memory && typeof p.memory.workingSetSize === "number") ? p.memory.workingSetSize : 0;
      if (!byType[t]) byType[t] = { cpu: 0, wsKb: 0, count: 0, pids: [] };
      byType[t].cpu += cpu;
      byType[t].wsKb += ws;
      byType[t].count += 1;
      byType[t].pids.push(p.pid);
      totalCpu += cpu;
      totalWsKb += ws;
    });
    sink.push({ t: Date.now(), totalCpu: Math.round(totalCpu * 10) / 10, totalWsKb: totalWsKb, byType: byType });
  }

  for (let ci = 0; ci < plan.length; ci++) {
    const c = plan[ci];
    const entry = { id: c.id, mode: c.mode, format: c.format, fps: c.fps, quality: c.quality, performanceMode: c.performanceMode, countdown: COUNTDOWN, ok: false, errors: [] };
    stateMarks = { starting: 0, recording: 0 };
    const profile = perfMod.resolve(Object.assign({}, settings, c));
    entry.effectiveProfile = { enabled: profile.enabled, fpsCap: profile.fpsCap, qualityCap: profile.qualityCap, bitrateCap: profile.bitrateCap, chunkMs: profile.chunkMs, preferVp8: profile.preferVp8, label: profile.label };
    log("===== CASE " + c.id + " profile=" + JSON.stringify(entry.effectiveProfile) + " =====");
    settings.format = c.format; settings.fps = c.fps; settings.quality = c.quality; settings.performanceMode = c.performanceMode;
    settings.hideMainWindow = c.mode !== "window";
    el.reset();
    const samples = [];
    let sampler = null;
    const logStart = logLines.length;
    // 桌面动画实际帧率：区分"编码/采集瓶颈"与"桌面本来就没动"
    let rafStart = 0;
    try { rafStart = await demoWin.webContents.executeJavaScript("window.__rafc ? window.__rafc() : 0", true); } catch (e) { rafStart = 0; }
    // 预热对照：销毁采集窗后先 prewarm，模拟「鼠标悬停开始按钮再点录制」
    if (PREWARM && typeof rec.prewarm === "function") {
      try { if (typeof rec._cleanupCapture === "function") rec._cleanupCapture(); } catch (e) {}
      await sleep(60);
      try { await rec.prewarm(); await sleep(60); } catch (e) { log("prewarm failed " + ((e && e.message) || e)); }
    }
    const caseT0 = Date.now();
    const t0 = Date.now();
    let startRes = null;
    try {
      startRes = await rec.start(reqFor(c));
    } catch (e) { startRes = { ok: false, error: String((e && e.message) || e) }; }
    entry.startMs = Date.now() - t0;
    if (stateMarks.starting && stateMarks.recording) {
      entry.postCountdownMs = stateMarks.recording - stateMarks.starting;
      entry.startBreakdown = { toStartingMs: stateMarks.starting - t0, toRecordingMs: stateMarks.recording - t0 };
    }
    entry.startResult = startRes;
    if (!startRes || !startRes.ok) {
      entry.errors.push("start 失败: " + ((startRes && startRes.error) || "unknown"));
      log("CASE " + c.id + " START FAILED " + JSON.stringify(startRes));
      result.cases.push(entry); writeResult(result); continue;
    }
    log("CASE " + c.id + " started startMs=" + entry.startMs);
    // 跳过前 300ms 的上报窗口，然后按 500ms 采样
    await sleep(300);
    sampler = setInterval(function () { sampleOnce(samples); }, 500);
    // 主线程定时器抖动：100ms ticker 实际间隔与 100ms 的偏差（max 即最坏卡顿）
    const tickDeltas = [];
    let lastTickAt = Date.now();
    const jitterTimer = setInterval(function () { const now = Date.now(); tickDeltas.push(now - lastTickAt); lastTickAt = now; }, 100);
    const sampleFrom = Date.now();
    await sleep(Math.max(500, DURATION - 300));
    if (sampler) { clearInterval(sampler); sampler = null; }
    clearInterval(jitterTimer);
    const devs = tickDeltas.map(function (d) { return Math.abs(d - 100); });
    entry.timerJitterMs = { ticks: tickDeltas.length, meanDelta: stats(tickDeltas).mean, maxDeviation: devs.length ? Math.max.apply(null, devs) : null, p95Deviation: stats(devs).p95 };
    const stopT0 = Date.now();
    const savedPromise = waitSaved(rec, 90000).catch(function (e) { return { __error: e.message }; });
    let stopRes = null;
    try { stopRes = await rec.stop(); } catch (e) { stopRes = { ok: false, error: String((e && e.message) || e) }; }
    const saved = await savedPromise;
    entry.stopMs = Date.now() - stopT0;
    entry.recordedMs = stopT0 - t0;
    el.disable();
    entry.eventLoopDelayMs = {
      mean: Math.round((el.mean / 1e6) * 100) / 100,
      p50: Math.round((el.percentile(50) / 1e6) * 100) / 100,
      p95: Math.round((el.percentile(95) / 1e6) * 100) / 100,
      p99: Math.round((el.percentile(99) / 1e6) * 100) / 100,
      max: Math.round((el.max / 1e6) * 100) / 100
    };
    el.enable();
    try {
      const rafEnd = await demoWin.webContents.executeJavaScript("window.__rafc ? window.__rafc() : 0", true);
      const secs = (Date.now() - caseT0) / 1000;
      if (rafStart && rafEnd >= rafStart && secs > 0) entry.demoFps = Math.round(((rafEnd - rafStart) / secs) * 10) / 10;
    } catch (e) { entry.demoFps = null; }

    // 采样汇总
    const cpuSeries = samples.map(function (s) { return s.totalCpu; });
    const wsSeries = samples.map(function (s) { return s.totalWsKb; });
    entry.samples = samples.length;
    entry.cpuPercentOneCore = stats(cpuSeries);
    entry.cpuPercentAllCores = stats(cpuSeries.map(function (v) { return Math.round((v / hw.cores) * 100) / 100; }));
    entry.memoryTotalMB = { mean: stats(wsSeries).mean === null ? null : mb(stats(wsSeries).mean), max: wsSeries.length ? mb(Math.max.apply(null, wsSeries)) : null };
    const perType = {};
    samples.forEach(function (s) {
      Object.keys(s.byType).forEach(function (t) {
        if (!perType[t]) perType[t] = { cpu: [], wsKb: [] };
        perType[t].cpu.push(s.byType[t].cpu);
        perType[t].wsKb.push(s.byType[t].wsKb);
      });
    });
    entry.cpuByType = {};
    entry.memoryByTypeMB = {};
    Object.keys(perType).forEach(function (t) {
      entry.cpuByType[t] = stats(perType[t].cpu);
      entry.memoryByTypeMB[t] = { mean: mb(stats(perType[t].wsKb).mean || 0), max: mb(Math.max.apply(null, perType[t].wsKb)) };
    });

    const item = (saved && !saved.__error) ? saved : (savedItems.length ? savedItems[savedItems.length - 1] : (stopRes && stopRes.item) || null);
    if (!item) {
      entry.errors.push("未拿到录制结果: " + ((saved && saved.__error) || "无 saved 事件"));
      log("CASE " + c.id + " NO SAVED " + JSON.stringify(saved));
      result.cases.push(entry); writeResult(result); continue;
    }
    entry.item = { fileName: item.fileName, filePath: item.filePath, bytes: item.sizeBytes, durationMs: item.durationMs, width: item.width, height: item.height, hasAudio: item.hasAudio, transcode: item.transcode };
    // 解析本用例期间的 recorder 日志（remux 耗时）
    const remuxAll = logLines.slice(logStart).join("\n").match(/\[recorder\] remux (\w+) (\d+)ms/g) || [];
    const remuxLine = remuxAll.length ? /\[recorder\] remux (\w+) (\d+)ms/.exec(remuxAll[remuxAll.length - 1]) : null;
    entry.remuxMs = remuxLine ? parseInt(remuxLine[2], 10) : null;
    entry.remuxFormat = remuxLine ? remuxLine[1] : null;

    // ffmpeg 探针：分辨率 / 码率 / 帧数
    try {
      const insp = await ffmpeg.inspect(item.filePath);
      const text = ((insp && insp.stderr) || "") + ((insp && insp.stdout) || "");
      entry.probe = Object.assign({ inspectOk: !!(insp && insp.ok) }, parseFfmpegText(text));
      entry.probe.frames = countFrames(item.filePath);
    } catch (e) { entry.errors.push("探针失败: " + String((e && e.message) || e)); }

    const durSec = entry.item.durationMs / 1000;
    entry.effective = {
      width: entry.probe && entry.probe.width, height: entry.probe && entry.probe.height,
      fps: entry.probe && entry.probe.fps,
      frames: entry.probe && entry.probe.frames,
      durationSec: Math.round(durSec * 100) / 100,
      bitrateMbps: durSec > 0 ? Math.round((entry.item.bytes * 8 / durSec / 1e6) * 100) / 100 : null,
      bytesPerSec: durSec > 0 ? Math.round(entry.item.bytes / durSec) : null,
      expectedFrames: Math.round((entry.item.durationMs / 1000) * c.fps),
      droppedFramePct: null
    };
    if (entry.effective.frames && entry.effective.expectedFrames) {
      entry.effective.droppedFramePct = Math.round((1 - entry.effective.frames / entry.effective.expectedFrames) * 1000) / 10;
    }
    // 落盘效率：录制期写入字节 / 录制时长
    entry.io = { bytes: entry.item.bytes, wallMs: entry.recordedMs, bytesPerSecWall: Math.round(entry.item.bytes / (entry.recordedMs / 1000)) };
    entry.ok = !!(entry.item && entry.item.bytes > 10000 && entry.probe && entry.probe.width);
    log("CASE " + c.id + " RESULT ok=" + entry.ok + " startMs=" + entry.startMs + " postCountdownMs=" + entry.postCountdownMs + " stopMs=" + entry.stopMs +
      " cpuMean=" + entry.cpuPercentOneCore.mean + "% cpuP95=" + entry.cpuPercentOneCore.p95 + "%" +
      " memMax=" + JSON.stringify(entry.memoryTotalMB) + " remuxMs=" + entry.remuxMs +
      " eff=" + JSON.stringify(entry.effective) + " elDelay=" + JSON.stringify(entry.eventLoopDelayMs));
    result.cases.push(entry);
    writeResult(result);
    await sleep(800);
  }

  // 空闲态：等采集窗自动关闭（25s）后再测一次
  if (process.env.PERFBENCH_SKIP_IDLE !== "1") {
  log("idle measurement: 等待采集窗自动关闭(27s)...");
  await sleep(27000);
  }
  const idleSamples = [];
  for (let i = 0; i < 6; i++) { sampleOnce(idleSamples); await sleep(500); }
  const idleWs = idleSamples.map(function (s) { return s.totalWsKb; });
  const idleCpu = idleSamples.map(function (s) { return s.totalCpu; });
  result.idle = {
    memoryTotalMB: { mean: mb(stats(idleWs).mean || 0), max: idleWs.length ? mb(Math.max.apply(null, idleWs)) : null },
    cpuPercentOneCore: stats(idleCpu),
    appProcessCount: (function () { try { return app.getAppMetrics().length; } catch (e) { return null; } })()
  };
  log("IDLE " + JSON.stringify(result.idle));

  const okCount = result.cases.filter(function (c) { return c.ok; }).length;
  result.ok = okCount === plan.length;
  result.finishedAt = new Date().toISOString();
  writeResult(result);
  log("PERFBENCH SUMMARY ok=" + result.ok + " passed=" + okCount + "/" + plan.length);
  try { rec.dispose(); } catch (e) {}
  try { demoWin.destroy(); } catch (e) {}
  await sleep(200);
  return result.ok ? 0 : 1;
}

app.whenReady().then(async function () {
  let code = 1;
  try { code = await main(); }
  catch (e) { log("FATAL " + (e && e.stack || e)); writeResult(Object.assign(result, { ok: false, error: String((e && e.stack) || e) })); code = 1; }
  log("perfbench exit code=" + code);
  setTimeout(function () { try { app.exit(code); } catch (e) { process.exit(code); } }, 300);
});

setTimeout(function () { log("WATCHDOG TIMEOUT"); writeResult(Object.assign(result, { ok: false, error: "watchdog" })); try { app.exit(2); } catch (e) { process.exit(2); } }, 420000);
