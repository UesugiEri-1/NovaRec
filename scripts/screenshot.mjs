// T1: NovaRec 三页 UI 真实渲染截图（Electron 主进程脚本，ESM）
// 运行: unset ELECTRON_RUN_AS_NODE; ./node_modules/electron/dist/electron.exe scripts/screenshot.mjs --no-sandbox
import { app, BrowserWindow, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "artifacts", "ui");
const USER_DATA = path.join(ROOT, ".data-shot");
const CONSOLE_LOG = path.join(OUT_DIR, "console.log");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(USER_DATA, { recursive: true }); // 必须在 requestSingleInstanceLock/ready 之前建好
app.commandLine.appendSwitch("no-sandbox");
app.setPath("userData", USER_DATA);

const consoleLines = [];
function log(s) { const line = new Date().toISOString() + " " + s; consoleLines.push(line); console.log(line); }
function flushConsoleLog() {
  try { fs.writeFileSync(CONSOLE_LOG, consoleLines.join("\n") + "\n", "utf8"); } catch (e) {}
}
function logConsole(...args) {
  let level, message, line, sourceId;
  const first = args[0];
  if (args.length === 1 && first && typeof first === "object" && typeof first.message === "string") {
    level = first.level; message = first.message; line = first.lineNumber; sourceId = first.sourceId;
  } else {
    level = args[1]; message = args[2]; line = args[3]; sourceId = args[4];
  }
  const text = "[console:" + level + "] " + message + (sourceId ? " (" + sourceId + ":" + line + ")" : "");
  consoleLines.push(new Date().toISOString() + " " + text);
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 非空白检测：按亮度统计方差与唯一色数量
function analyzeImage(nativeImg) {
  const size = nativeImg.getSize();
  let bmp;
  try { bmp = nativeImg.toBitmap(); } catch (e) { return { width: size.width, height: size.height, blank: true, error: String(e) }; }
  if (!bmp || bmp.length < size.width * size.height * 4) return { width: size.width, height: size.height, blank: true, error: "bitmap-too-small" };
  let sum = 0, sum2 = 0, n = 0;
  const colors = new Set();
  const step = 4 * 7; // 采样步长，控制开销
  for (let i = 0; i + 3 < bmp.length; i += step) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
    const y = 0.114 * b + 0.587 * g + 0.299 * r;
    sum += y; sum2 += y * y; n++;
    if (colors.size < 4096) colors.add((r << 16) | (g << 8) | b);
  }
  const mean = n ? sum / n : 0;
  const variance = n ? sum2 / n - mean * mean : 0;
  const stddev = Math.sqrt(Math.max(0, variance));
  return {
    width: size.width, height: size.height,
    meanLuma: Math.round(mean * 10) / 10,
    stddev: Math.round(stddev * 10) / 10,
    sampledColors: colors.size,
    blank: !(stddev > 2 && colors.size > 8)
  };
}

async function shoot(win, name, results) {
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, png);
  const analysis = analyzeImage(img);
  const st = fs.statSync(file);
  const entry = Object.assign({ file: file, bytes: st.size, pngBytes: png.length, analysis: analysis }, { name: name });
  results.push(entry);
  log("SHOT " + name + " bytes=" + st.size + " " + JSON.stringify(analysis));
  return entry;
}

async function clickAndWait(win, selector, waitMs) {
  const script = "(function(){var el=document.querySelector(" + JSON.stringify(selector) + "); if(!el) return 'missing'; el.click(); return 'clicked';})()";
  const r = await win.webContents.executeJavaScript(script, true);
  await sleep(waitMs);
  return r;
}

const results = [];
let exitCode = 0;

app.whenReady().then(async function () {
  log("screenshot start pid=" + process.pid + " userData=" + app.getPath("userData"));
  const win = new BrowserWindow({
    width: 1440, height: 900, show: true, frame: false, backgroundColor: "#0e121a",
    title: "NovaRec",
    webPreferences: {
      preload: path.join(ROOT, "src", "preload", "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.on("console-message", logConsole);
  win.webContents.on("render-process-gone", function (ev, details) { log("RENDERER GONE " + JSON.stringify(details || {})); });
  win.webContents.on("did-fail-load", function (ev, code, desc, url) { log("DID-FAIL-LOAD " + code + " " + desc + " " + url); });
  win.webContents.on("preload-error", function (ev, p, err) { log("PRELOAD-ERROR " + p + " " + (err && err.message)); });

  const indexPath = path.join(ROOT, "src", "renderer", "index.html");
  try {
    await win.loadFile(indexPath, { query: { mock: "1" } });
  } catch (e) {
    log("LOAD FAILED " + (e && e.message));
    exitCode = 1;
    flushConsoleLog(); app.exit(exitCode); return;
  }
  await sleep(1600); // did-finish-load 后等渲染与 mock 数据填充
  try { win.show(); win.focus(); } catch (e) {}
  await sleep(400);

  const info = await win.webContents.executeJavaScript("(function(){var mb=document.getElementById('mockBadge');return {title:document.title, hasNovarec:!!(window.novarec&&window.novarec.getSettings), mockBadgeHidden:mb?mb.hidden:null, mockBadgeText:mb?mb.textContent:'', page:(document.querySelector('.page.is-active')||{}).id, navItems:Array.prototype.map.call(document.querySelectorAll('.nav-item'),function(b){return b.getAttribute('data-page');}), size:[innerWidth,innerHeight], dpr:devicePixelRatio, bodyText:(document.body.innerText||'').slice(0,120)};})()", true);
  log("PAGE INFO " + JSON.stringify(info));
  if (!info.hasNovarec) { log("WARN: preload 未注入 window.novarec（门控仍应生效）"); }
  if (info.mockBadgeHidden !== false) { log("FAIL: mock=1 未强制 Mock（mockBadge 未显示）"); exitCode = 1; }

  await shoot(win, "01-record.png", results);

  log("click nav library => " + await clickAndWait(win, '.nav-item[data-page="library"]', 900));
  await shoot(win, "02-library.png", results);

  log("click nav settings => " + await clickAndWait(win, '.nav-item[data-page="settings"]', 900));
  await shoot(win, "03-settings.png", results);

  log("click nav record => " + await clickAndWait(win, '.nav-item[data-page="record"]', 500));
  log("click mode window => " + await clickAndWait(win, '.mode-card[data-mode="window"]', 1000));
  await shoot(win, "04-window-picker.png", results);

  log("click mode screen => " + await clickAndWait(win, '.mode-card[data-mode="screen"]', 700));
  log("click start => " + await clickAndWait(win, '#btnStart', 850));
  await shoot(win, "05-countdown.png", results);
  await sleep(3400);
  const recInfo = await win.webContents.executeJavaScript("(function(){var d=document.getElementById('actionRecording');return {hidden:d?d.hidden:null, timer:(document.getElementById('recTimer')||{}).textContent||'', tag:(document.getElementById('recStateTag')||{}).textContent||''};})()", true);
  log("REC STATE " + JSON.stringify(recInfo));
  await shoot(win, "06-recording.png", results);
  log("click pause => " + await clickAndWait(win, '#btnPause', 500));
  await shoot(win, "07-paused.png", results);
  log("click stop => " + await clickAndWait(win, '#btnStop', 300));
  await shoot(win, "08-processing.png", results);

  const core = results.filter(function (r) { return r.name !== "04-window-picker.png" && r.name !== "08-processing.png"; });
  const bad = results.filter(function (r) { return r.bytes < 20 * 1024 || r.analysis.blank; });
  const coreBad = core.filter(function (r) { return r.bytes < 20 * 1024 || r.analysis.blank; });
  log("SUMMARY shots=" + results.length + " core=" + core.length + " blankOrSmall=" + bad.length + " coreBad=" + coreBad.length);
  if (core.length < 3 || coreBad.length > 0) exitCode = 1;

  const manifest = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    window: { width: 1440, height: 900, scaleFactor: 1.25 },
    pageInfo: info,
    results: results,
    console: consoleLines.slice(),
    ok: exitCode === 0
  };
  try { fs.writeFileSync(path.join(OUT_DIR, "screenshot-result.json"), JSON.stringify(manifest, null, 2), "utf8"); } catch (e) {}
  flushConsoleLog();
  log("screenshot done exit=" + exitCode);
  setTimeout(function () { try { win.destroy(); } catch (e) {} app.exit(exitCode); }, 300);
}).catch(function (e) {
  log("FATAL " + (e && e.stack || e));
  flushConsoleLog();
  app.exit(1);
});

// 看门狗：避免无头/异常环境挂死
setTimeout(function () { log("WATCHDOG TIMEOUT"); flushConsoleLog(); app.exit(2); }, 120000);
