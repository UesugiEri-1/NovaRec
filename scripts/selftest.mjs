// T2: NovaRec 三模式端到端录制自测（screen / region / window，含系统声音验证）
// 运行: unset ELECTRON_RUN_AS_NODE; ./node_modules/electron/dist/electron.exe scripts/selftest.mjs --no-sandbox
import { app, BrowserWindow, desktopCapturer } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts", "selftest");
const USER_DATA = path.join(OUT_DIR, "userData");
const VIDEO_DIR = path.join(OUT_DIR, "out");
const LOG_FILE = path.join(ROOT, "artifacts", "selftest.log");
const RESULT_FILE = path.join(OUT_DIR, "result.json");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true }); // requestSingleInstanceLock / ready 之前必须存在
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.writeFileSync(LOG_FILE, "", "utf8");

app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setPath("userData", USER_DATA);

// 把主进程 console 输出（含 recorder 转发的 [capture] 日志）同时落到 artifacts/selftest.log
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
function appendLog(line) { try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {} }
function log(s) { const line = new Date().toISOString() + " " + s; appendLog(line); try { origLog(line); } catch (e) {} }
function logErr(s) { const line = new Date().toISOString() + " [stderr] " + s; appendLog(line); try { origErr(line); } catch (e) {} }
console.log = function () { const args = Array.prototype.slice.call(arguments); log(" " + args.map(function (a) { return typeof a === "string" ? a : JSON.stringify(a); }).join(" ")); };
console.error = function () { const args = Array.prototype.slice.call(arguments); logErr(args.map(function (a) { return (a && a.stack) || String(a); }).join(" ")); };

const recorderMod = require("../src/main/recorder.js");
const ffmpeg = require("../src/main/ffmpeg.js");
const sourcesApi = require("../src/main/sources.js");
const storeMod = require("../src/main/store.js");
const { Recorder } = recorderMod;

// ---- 系统音频端点状态检查：静音机器上把“系统声音电平”检查降级为 WARN/SKIP，其余 checks 仍为硬失败 ----
const AUDIO_STATE_SCRIPT = path.join(__dirname, "audio-state.ps1");
const audioEndpoint = { mute: null, volume: null, channels: null, checked: false, error: null, raw: null };
const audioMuteSkip = { value: false };
function checkAudioEndpoint() {
  if (!fs.existsSync(AUDIO_STATE_SCRIPT)) { audioEndpoint.error = "scripts/audio-state.ps1 不存在"; return; }
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", AUDIO_STATE_SCRIPT, "-Action", "state"], { encoding: "utf8", timeout: 20000, windowsHide: true });
    const text = String(out || "");
    const m = text.match(/AUDIO_MUTE=(\w+)/i);
    const v = text.match(/AUDIO_VOLUME=([0-9.]+)/i);
    const c = text.match(/AUDIO_CHANNELS=(\d+)/i);
    audioEndpoint.checked = !!m;
    audioEndpoint.mute = m ? /true/i.test(m[1]) : null;
    audioEndpoint.volume = v ? parseFloat(v[1]) : null;
    audioEndpoint.channels = c ? parseInt(c[1], 10) : null;
    audioEndpoint.raw = text.trim().slice(0, 500);
    if (!m) audioEndpoint.error = "未能解析 AUDIO_MUTE 输出: " + text.trim().slice(0, 200);
  } catch (e) { audioEndpoint.error = (e && e.message) || String(e); }
}

// ---- 调试用：拦截 ffmpeg.finalize，把临时文件与失败诊断落到 artifacts/selftest/debug（仅 SELFTEST_DEBUG_FINALIZE=1 时生效）----
const DEBUG_DIR = path.join(OUT_DIR, "debug");
fs.mkdirSync(DEBUG_DIR, { recursive: true });
let currentModeLabel = "none";
const origFinalize = ffmpeg.finalize;
if (process.env.SELFTEST_DEBUG_FINALIZE === "1") {
  ffmpeg.finalize = async function (opts) {
    const stamp = Date.now();
    const ext = path.extname(opts.tempPath || "");
    const copy = path.join(DEBUG_DIR, "temp_" + currentModeLabel + "_" + stamp + ext);
    try {
      fs.copyFileSync(opts.tempPath, copy);
      log("DEBUG copied temp " + copy + " bytes=" + fs.statSync(copy).size);
    } catch (e) { log("DEBUG copy temp failed: " + (e && e.message || e)); }
    const r = await origFinalize(opts);
    log("DEBUG finalize result " + JSON.stringify(r));
    if (!r.ok && fs.existsSync(copy)) {
      const insp = await ffmpeg.run(["-hide_banner", "-i", copy], 60000);
      const remuxOut = copy + ".remux.mp4";
      const rm = await ffmpeg.run(["-hide_banner", "-y", "-i", copy, "-c", "copy", "-movflags", "+faststart", remuxOut], 60000);
      const transOut = copy + ".trans.mp4";
      const tr = await ffmpeg.run(["-hide_banner", "-y", "-i", copy, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", transOut], 120000);
      const dump = {
        tempPath: opts.tempPath, finalOk: r.ok, finalError: r.error,
        inspect: { code: insp.code, stderrTail: insp.stderr.slice(-4000) },
        remux: { ok: rm.ok, code: rm.code, stderrTail: rm.stderr.slice(-4000) },
        transcode: { ok: tr.ok, code: tr.code, stderrTail: tr.stderr.slice(-4000) }
      };
      fs.writeFileSync(path.join(DEBUG_DIR, "diag_" + currentModeLabel + "_" + stamp + ".json"), JSON.stringify(dump, null, 2), "utf8");
      log("DEBUG diag inspectCode=" + insp.code + " remuxOk=" + rm.ok + " transcodeOk=" + tr.ok);
      log("DEBUG inspect tail: " + insp.stderr.slice(-700).replace(/\s+/g, " "));
      log("DEBUG remux tail: " + rm.stderr.slice(-700).replace(/\s+/g, " "));
      log("DEBUG transcode tail: " + tr.stderr.slice(-700).replace(/\s+/g, " "));
    }
    return r;
  };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function writeResult(o) { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(o, null, 2), "utf8"); } catch (e) {} }

// demo 窗口：动态渐变 + 运动图形 + 440Hz 正弦波（供系统声音回环采集验证）
const DEMO_TITLE = "NovaRec 自测演示窗";
const DEMO_HTML = [
  "<!doctype html><html><head><meta charset='utf-8'><title>", DEMO_TITLE, "</title></head>",
  "<body style='margin:0;background:#0b1020;overflow:hidden'>",
  "<canvas id='c' width='800' height='600'></canvas>",
  "<script>",
  "var c=document.getElementById('c'),x=c.getContext('2d'),t=0;",
  "function f(){t+=0.05;var g=x.createLinearGradient(0,0,800,600);",
  "g.addColorStop(0,'hsl('+((t*18)%360)+',70%,22%)');g.addColorStop(1,'hsl('+((t*18+120)%360)+',70%,42%)');",
  "x.fillStyle=g;x.fillRect(0,0,800,600);",
  "for(var i=0;i<6;i++){x.fillStyle='hsla('+((t*40+i*60)%360)+',85%,65%,0.85)';",
  "x.beginPath();x.arc(400+Math.cos(t+i)*240,300+Math.sin(t*1.3+i)*180,26+i*5,0,Math.PI*2);x.fill();}",
  "x.fillStyle='#fff';x.font='bold 34px sans-serif';x.fillText('NovaRec 自测演示窗',40,60);",
  "x.font='20px monospace';x.fillText('SELFTEST '+t.toFixed(2),40,100);",
  "x.fillRect(40,520,Math.round((Math.sin(t)*0.5+0.5)*600),12);",
  "requestAnimationFrame(f)}f();",
  "var ac=null,osc=null,gain=null;",
  "window.__startTone=function(){try{if(ac)return;var AC=window.AudioContext||window.webkitAudioContext;ac=new AC();",
  "osc=ac.createOscillator();gain=ac.createGain();osc.type='sine';osc.frequency.value=440;gain.gain.value=0.35;",
  "osc.connect(gain);gain.connect(ac.destination);osc.start();if(ac.state!=='running'){ac.resume();}",
  "setInterval(function(){if(ac&&ac.state==='suspended'){ac.resume();}},400);}catch(e){}};",
  "window.__toneState=function(){return ac?ac.state:'none';};",
  "</script></body></html>"
].join("");

function parseFfmpegText(text) {
  const out = { width: null, height: null, codec: null, audioCodec: null, audioSampleRate: null, durationSec: null };
  const vline = (text.match(/Video:\s*([^\n]+)/i) || [])[1];
  if (vline) {
    out.codec = vline.split(",")[0].trim();
    const size = vline.match(/(\d{2,5})x(\d{2,5})/);
    if (size) { out.width = parseInt(size[1], 10); out.height = parseInt(size[2], 10); }
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

async function probeFile(file) {
  const info = { file: file, exists: fs.existsSync(file) };
  if (!info.exists) return info;
  info.bytes = fs.statSync(file).size;
  try {
    const insp = await ffmpeg.inspect(file);
    const text = ((insp && insp.stderr) || "") + ((insp && insp.stdout) || "");
    info.inspect = Object.assign({ inspectOk: !!(insp && insp.ok) }, parseFfmpegText(text));
  } catch (e) { info.inspectError = String(e && e.message || e); }
  try { info.validate = await ffmpeg.validate(file); } catch (e) { info.validate = false; info.validateError = String(e && e.message || e); }
  try {
    const vol = await ffmpeg.run(["-hide_banner", "-i", file, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], 60000);
    const vt = ((vol && vol.stderr) || "") + ((vol && vol.stdout) || "");
    const mv = vt.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
    const mx = vt.match(/max_volume:\s*(-?[0-9.]+)\s*dB/);
    info.meanVolumeDb = mv ? parseFloat(mv[1]) : null;
    info.maxVolumeDb = mx ? parseFloat(mx[1]) : null;
    info.volumeOk = vol && vol.ok && info.meanVolumeDb !== null;
  } catch (e) { info.volumeError = String(e && e.message || e); }
  try {
    const gray = path.join(OUT_DIR, "frame-" + path.basename(file).replace(/[^\w.-]+/g, "_") + ".gray");
    const dur = (info.inspect && info.inspect.durationSec) || 1;
    const fr = await ffmpeg.run(["-hide_banner", "-y", "-ss", String(Math.min(1.0, dur / 2).toFixed(2)), "-i", file, "-frames:v", "1", "-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "gray", gray], 60000);
    if (fr && fr.ok && fs.existsSync(gray)) {
      const buf = fs.readFileSync(gray);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
      info.frameMeanGray = Math.round((sum / Math.max(1, buf.length)) * 10) / 10;
      try { fs.unlinkSync(gray); } catch (e) {}
    }
  } catch (e) { info.frameError = String(e && e.message || e); }
  return info;
}

function waitSaved(rec, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () { if (done) return; done = true; reject(new Error("等待 saved 事件超时(" + timeoutMs + "ms)")); }, timeoutMs);
    rec.once("saved", function (item) { if (done) return; done = true; clearTimeout(timer); resolve(item); });
  });
}

const result = { ok: false, startedAt: new Date().toISOString(), pid: process.pid, checks: [], modes: [], error: null };

async function main() {
  log("selftest start pid=" + process.pid + " electron=" + process.versions.electron + " userData=" + app.getPath("userData"));
  checkAudioEndpoint();
  result.audioEndpoint = audioEndpoint;
  log("audio endpoint mute=" + audioEndpoint.mute + " volume=" + audioEndpoint.volume + " channels=" + audioEndpoint.channels + " checked=" + audioEndpoint.checked + " err=" + audioEndpoint.error);
  if (audioEndpoint.mute === true) {
    audioMuteSkip.value = true;
    result.audioMuteSkipped = true;
    log("WARN: 系统音频端点处于静音（AUDIO_MUTE=True），系统声音 mean_volume>-60dB 检查降级为 WARN/SKIP；尺寸/时长/可解码/音轨/pause 仍为硬校验");
  }
  const devLock = path.join(ROOT, ".data", "SingletonLock");
  if (fs.existsSync(devLock)) log("WARN: 项目 .data/SingletonLock 存在，可能有 NovaRec 开发实例，注意单实例冲突");
  if (!app.requestSingleInstanceLock()) { log("FAIL: 已存在另一个 selftest 实例，退出"); result.error = "single-instance"; return 3; }

  const displayInfo = sourcesApi.getDisplayInfo();
  const primary = displayInfo.displays.find(function (d) { return d.primary; }) || displayInfo.displays[0];
  log("display primary=" + JSON.stringify(primary));
  result.display = { displays: displayInfo.displays, primary: primary, scaleFactor: primary ? primary.scaleFactor : 1 };
  if (!primary) { result.error = "未检测到显示器"; return 3; }

  // 可见演示窗口
  const demoWin = new BrowserWindow({
    width: 800, height: 600, x: 100, y: 100, frame: false, show: true,
    title: DEMO_TITLE, backgroundColor: "#0b1020",
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, spellcheck: false }
  });
  await demoWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(DEMO_HTML));
  demoWin.setTitle(DEMO_TITLE);
  await sleep(900);
  await demoWin.webContents.executeJavaScript("window.__startTone && window.__startTone();", true).catch(function () {});
  try { demoWin.show(); demoWin.focus(); } catch (e) {}
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const st = await demoWin.webContents.executeJavaScript("window.__toneState ? window.__toneState() : 'none'", true).catch(function () { return "err"; });
    log("demo tone state=" + st + " visible=" + demoWin.isVisible() + " title=" + demoWin.getTitle());
    if (st === "running") break;
  }

  // 从 desktopCapturer 按标题找到演示窗 sourceId
  let winSources = [];
  try {
    winSources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
  } catch (e) {
    log("getSources(0x0) 失败: " + e.message + "，改用 320x180 重试");
    winSources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 320, height: 180 } });
  }
  log("window sources=" + JSON.stringify(winSources.map(function (s) { return s.id + "|" + s.name; })));
  let demoSrc = winSources.find(function (s) { return (s.name || "").indexOf("自测演示窗") >= 0 || (s.name || "").indexOf(DEMO_TITLE) >= 0; });
  if (!demoSrc) {
    // 标题编码差异兜底：取最新的 window source 中名字含 NovaRec 的
    demoSrc = winSources.filter(function (s) { return /NovaRec/.test(s.name || ""); }).slice(-1)[0];
  }
  result.demoWindow = { title: DEMO_TITLE, sourceId: demoSrc ? demoSrc.id : null, sourceName: demoSrc ? demoSrc.name : null };
  if (!demoSrc) {
    result.error = "未能在 desktopCapturer 中找到演示窗口 source";
    log("FAIL: " + result.error);
    try { demoWin.destroy(); } catch (e) {}
    app.exit(3); return 3;
  }

  // 屏幕/区域采集源（与 recorder 内部 listSources 的 id 保持一致）
  const sourceData = await sourcesApi.listSources();
  const primaryScreen = sourcesApi.screenForDisplay(sourceData.screens, displayInfo.displays, primary) || sourceData.screens[0];
  const screenSourceId = primaryScreen ? primaryScreen.id : (sourceData.screens[0] || {}).id;
  log("screen source=" + screenSourceId + " screens=" + JSON.stringify(sourceData.screens.map(function (s) { return s.id; })));

  const settings = {
    outputDir: VIDEO_DIR, format: "mp4", fps: 30, quality: "high",
    systemAudio: true, microphone: false, countdown: 0, hideMainWindow: false,
    micDeviceId: "default", lastSourceId: screenSourceId,
    performanceMode: "off" // 固定原生画质，分辨率断言才有意义；性能模式另由 scripts/perfbench.mjs 验证
  };
  const library = new storeMod.Library(path.join(USER_DATA, "library.json"));
  const rec = new Recorder({ userDataPath: app.getPath("userData"), getSettings: function () { return settings; }, getMainWindow: function () { return demoWin; }, library: library });
  const savedItems = [];
  rec.on("saved", function (item) { savedItems.push(item); log("EVENT saved file=" + item.filePath + " bytes=" + item.sizeBytes + " mode=" + item.mode); });
  rec.on("error", function (p) { log("EVENT error " + JSON.stringify(p)); });
  rec.on("toast", function (p) { log("EVENT toast " + JSON.stringify(p)); });
  result.settings = settings;

  const scale = primary.scaleFactor || 1;
  const regionDip = { x: 80, y: 80, width: 800, height: 600, displayId: primary.id };
  const expected = {
    screen: { width: Math.round(primary.bounds.width * scale), height: Math.round(primary.bounds.height * scale) },
    region: { width: Math.round(regionDip.width * scale), height: Math.round(regionDip.height * scale) }
  };
  result.expected = expected;
  log("expected screen=" + JSON.stringify(expected.screen) + " region=" + JSON.stringify(expected.region) + " (DIP " + JSON.stringify(primary.bounds) + " x" + scale + ")");

  const planAll = [
    { mode: "screen", req: { mode: "screen", sourceId: screenSourceId }, pauseTest: true },
    { mode: "region", req: { mode: "region", region: regionDip }, pauseTest: false },
    { mode: "window", req: { mode: "window", sourceId: demoSrc.id }, pauseTest: false }
  ];
  const only = (process.env.SELFTEST_MODES || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  const plan = only.length ? planAll.filter(function (x) { return only.indexOf(x.mode) >= 0; }) : planAll;
  log("SELFTEST_MODES=" + (only.length ? only.join(",") : "(all)"));

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    currentModeLabel = p.mode;
    const entry = { mode: p.mode, req: p.req, ok: false, errors: [], warnings: [], pause: null, startWallAt: Date.now() };
    entry.toneStateBefore = await demoWin.webContents.executeJavaScript("window.__toneState ? window.__toneState() : 'none'", true).catch(function () { return "err"; });
    log("MODE " + p.mode + " toneStateBefore=" + entry.toneStateBefore + " demoVisible=" + demoWin.isVisible());
    log("========== MODE " + p.mode + " start ==========");
    const savedBefore = savedItems.length;
    let startRes;
    try { startRes = await rec.start(p.req); } catch (e) { startRes = { ok: false, error: String(e && e.message || e) }; }
    entry.startResult = startRes;
    if (!startRes || !startRes.ok) {
      entry.errors.push("start 失败: " + ((startRes && startRes.error) || "unknown"));
      log("MODE " + p.mode + " START FAILED " + JSON.stringify(startRes));
      entry.finishedWallAt = Date.now();
      result.modes.push(entry); writeResult(result);
      continue;
    }
    await sleep(300);
    entry.startedState = rec.getState();
    log("MODE " + p.mode + " started state=" + JSON.stringify(entry.startedState));

    try {
      if (p.pauseTest) {
        await sleep(1200);
        const pauseRes = await rec.togglePause();
        const pausedState = rec.getState();
        await sleep(500);
        const resumeRes = await rec.togglePause();
        const resumedState = rec.getState();
        entry.pause = { pauseRes: pauseRes, pausedState: pausedState, resumeRes: resumeRes, resumedState: resumedState, pausedOk: !!(pausedState && pausedState.state === "paused"), resumedOk: !!(resumedState && resumedState.state === "recording") };
        log("MODE " + p.mode + " pause=" + JSON.stringify(entry.pause));
        await sleep(1800);
      } else {
        await sleep(3500);
      }
    } catch (e) {
      entry.errors.push("录制中异常: " + String(e && e.message || e));
      log("MODE " + p.mode + " DURING ERROR " + (e && e.stack || e));
    }
    const stopWallAt = Date.now();
    const savedPromise = waitSaved(rec, 60000).catch(function (e) { return { __error: e.message }; });
    let stopRes;
    try { stopRes = await rec.stop(); } catch (e) { stopRes = { ok: false, error: String(e && e.message || e) }; }
    const savedEvent = await savedPromise;
    entry.stopResult = stopRes;
    entry.toneStateAfter = await demoWin.webContents.executeJavaScript("window.__toneState ? window.__toneState() : 'none'", true).catch(function () { return "err"; });
    entry.recordedWallMs = stopWallAt - entry.startWallAt;
    entry.stopMs = Date.now() - stopWallAt;
    log("MODE " + p.mode + " stop result=" + JSON.stringify(stopRes) + " stopMs=" + entry.stopMs + " wall=" + entry.recordedWallMs);

    const item = (savedEvent && !savedEvent.__error) ? savedEvent : (savedItems.length > savedBefore ? savedItems[savedItems.length - 1] : (stopRes && stopRes.item) || null);
    if (!item) {
      entry.errors.push("未拿到 saved 文件: " + ((savedEvent && savedEvent.__error) || "无 saved 事件"));
      log("MODE " + p.mode + " NO SAVED ITEM " + JSON.stringify(savedEvent));
      entry.finishedWallAt = Date.now();
      result.modes.push(entry); writeResult(result);
      continue;
    }
    entry.file = item.filePath;
    entry.fileName = item.fileName;
    entry.bytes = item.sizeBytes;
    entry.durationMs = item.durationMs;
    entry.width = item.width;
    entry.height = item.height;
    entry.hasAudio = item.hasAudio;
    entry.transcode = item.transcode;
    entry.fallback = item.fallback;
    log("MODE " + p.mode + " SAVED " + JSON.stringify({ file: item.filePath, bytes: item.sizeBytes, durationMs: item.durationMs, w: item.width, h: item.height, hasAudio: item.hasAudio, transcode: item.transcode, fallback: item.fallback }));

    // ffmpeg 独立探测
    entry.probe = await probeFile(item.filePath);
    log("MODE " + p.mode + " PROBE " + JSON.stringify(entry.probe));

    // 验收判定
    const pr = entry.probe;
    const hasVideo = pr.inspect && pr.inspect.width && pr.inspect.height;
    const hasAudioStream = !!(pr.inspect && pr.inspect.audioCodec);
    const meanOk = pr.meanVolumeDb !== null && pr.meanVolumeDb > -60;
    const meanSkipped = !meanOk && audioMuteSkip.value;
    const meanOkEffective = meanOk || meanSkipped;
    const sizeOk = pr.bytes >= 100 * 1024;
    const validateOk = pr.validate === true;
    const durOk = entry.durationMs >= 2000 && entry.durationMs <= 6000;
    let resOk = true;
    if (p.mode === "screen") resOk = hasVideo && Math.abs(pr.inspect.width - expected.screen.width) <= 2 && Math.abs(pr.inspect.height - expected.screen.height) <= 2;
    else if (p.mode === "region") resOk = hasVideo && Math.abs(pr.inspect.width - expected.region.width) <= 8 && Math.abs(pr.inspect.height - expected.region.height) <= 8;
    else resOk = hasVideo && pr.inspect.width >= 300 && pr.inspect.height >= 200;
    let pauseOk = true;
    if (p.pauseTest) pauseOk = !!(entry.pause && entry.pause.pausedOk && entry.pause.resumedOk);
    entry.checks = { sizeOk: sizeOk, validateOk: validateOk, hasVideo: !!hasVideo, resolutionOk: resOk, hasAudioStream: hasAudioStream, meanVolumeOk: meanOkEffective, meanVolumeSkipped: meanSkipped, durationOk: durOk, pauseOk: pauseOk };
    entry.ok = sizeOk && validateOk && hasVideo && resOk && hasAudioStream && meanOkEffective && durOk && pauseOk;
    if (!entry.ok) {
      if (!sizeOk) entry.errors.push("文件小于 100KB: " + pr.bytes);
      if (!validateOk) entry.errors.push("ffmpeg validate 失败");
      if (!hasVideo) entry.errors.push("未解析到视频流");
      if (!resOk) entry.errors.push("分辨率异常: " + (pr.inspect && (pr.inspect.width + "x" + pr.inspect.height)) + " 期望 " + JSON.stringify(expected[p.mode] || "窗口尺寸"));
      if (!hasAudioStream) entry.errors.push("无音轨");
      if (!meanOk && !meanSkipped) entry.errors.push("系统声音 mean_volume=" + pr.meanVolumeDb + " dB（需 > -60 dB）");
      if (meanSkipped) entry.warnings.push("系统音频端点静音，mean_volume=" + pr.meanVolumeDb + " dB 未校验（WARN/SKIP）");
      if (!durOk) entry.errors.push("时长异常: " + entry.durationMs + "ms");
      if (!pauseOk) entry.errors.push("暂停/恢复异常");
    }
    entry.finishedWallAt = Date.now();
    log("MODE " + p.mode + " RESULT ok=" + entry.ok + " checks=" + JSON.stringify(entry.checks) + " errors=" + JSON.stringify(entry.errors));
    result.modes.push(entry);
    writeResult(result);
    await sleep(500);
  }

  const allOk = result.modes.length === plan.length && result.modes.every(function (m) { return m.ok === true; });
  result.ok = allOk;
  result.finishedAt = new Date().toISOString();
  writeResult(result);
  if (audioMuteSkip.value) log("SELFTEST NOTE: 系统音频端点静音（AUDIO_MUTE=True），系统声音电平未校验（WARN/SKIP）；若需真实音量验证请先取消端点静音");
  log("SELFTEST SUMMARY ok=" + allOk + " " + JSON.stringify(result.modes.map(function (m) {
    return { mode: m.mode, ok: m.ok, file: m.fileName, bytes: m.bytes, durationMs: m.durationMs, width: m.width, height: m.height, meanVolumeDb: m.probe && m.probe.meanVolumeDb };
  })));
  try { rec.dispose(); } catch (e) {}
  try { demoWin.destroy(); } catch (e) {}
  await sleep(300);
  return allOk ? 0 : 1;
}

app.whenReady().then(async function () {
  let code = 1;
  try { code = await main(); } catch (e) { log("FATAL " + (e && e.stack || e)); writeResult(Object.assign(result, { ok: false, error: String(e && e.stack || e) })); code = 1; }
  log("selftest exit code=" + code);
  setTimeout(function () { try { app.exit(code); } catch (e) { process.exit(code); } }, 300);
});

setTimeout(function () { log("WATCHDOG TIMEOUT"); writeResult(Object.assign(result, { ok: false, error: "watchdog" })); try { app.exit(2); } catch (e) { process.exit(2); } }, 240000);
