// 打包产物端到端验证：启动打包后的 NovaRec.exe，用 CDP 驱动渲染层 API
// 依次录制 screen / region / window 三种模式（各约 3s），检查落盘文件与音视频流。
// 运行: node scripts/verify-packaged-record.mjs [--exe <path>] [--port 9333]
// 依赖: 无（用 Node 内置 WebSocket / fetch；ffmpeg 只用于解析流信息，缺省则跳过完整性校验）
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const EXE = path.resolve(ROOT, arg("exe", path.join("artifacts", "dist-v5", "NovaRec-win32-x64", "NovaRec.exe")));
const PORT = parseInt(arg("port", "9333"), 10);
const OUT_DIR = path.join(ROOT, "artifacts", "verify-packaged");
const DATA_DIR = path.join(OUT_DIR, "data");
const MEDIA_DIR = path.join(OUT_DIR, "out");
const LOG_FILE = path.join(OUT_DIR, "verify.log");
const RESULT_FILE = path.join(OUT_DIR, "result.json");
const FFMPEG = path.join(ROOT, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.writeFileSync(LOG_FILE, "", "utf8");

const logLines = [];
function log(s) {
  const line = new Date().toISOString() + " " + s;
  logLines.push(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
  console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(EXE)) { console.error("EXE 不存在: " + EXE); process.exit(2); }
log("EXE=" + EXE + " size=" + fs.statSync(EXE).size);
log("PORT=" + PORT + " DATA=" + DATA_DIR);

const env = Object.assign({}, process.env, {
  NOVAREC_DATA_DIR: DATA_DIR,
  NOVAREC_NO_SANDBOX: "1",
  ELECTRON_ENABLE_LOGGING: "0"
});
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(EXE, ["--remote-debugging-port=" + PORT, "--no-sandbox"], {
  env, cwd: path.dirname(EXE), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
});
let appOut = "";
child.stdout.on("data", (d) => { appOut += String(d); });
child.stderr.on("data", (d) => { appOut += String(d); });
log("spawn pid=" + child.pid);

function killApp() {
  try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch (e) {}
  try { child.kill(); } catch (e) {}
}
process.on("exit", killApp);
process.on("SIGINT", () => { killApp(); process.exit(130); });

async function fetchJson(url) {
  const r = await fetch(url);
  return await r.json();
}

// 等 DevTools HTTP 端点就绪，并找到主窗口页面
async function waitForTarget(maxMs) {
  const deadline = Date.now() + maxMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson("http://127.0.0.1:" + PORT + "/json/list");
      const page = (list || []).find((t) => t.type === "page" && String(t.url || "").indexOf("renderer/index.html") >= 0);
      if (page && page.webSocketDebuggerUrl) return page;
      lastErr = "targets=" + (list || []).map((t) => t.type + ":" + t.url).join("|");
    } catch (e) { lastErr = (e && e.message) || String(e); }
    await sleep(200);
  }
  throw new Error("等待 DevTools 目标超时: " + lastErr);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    ws.onopen = () => resolve({
      call(method, params) {
        const id = ++seq;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("CDP 超时: " + method)); } }, 120000);
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    });
    ws.onerror = (e) => reject(new Error("WebSocket 错误"));
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.id) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.res(msg.result);
    };
  });
}

async function main() {
  const page = await waitForTarget(45000);
  log("devtools target ok: " + page.url);
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable", {});

  async function evalJs(expression) {
    const r = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("页面异常: " + ((d.exception && (d.exception.description || d.exception.value)) || d.text || "unknown"));
    }
    return r.result ? r.result.value : undefined;
  }

  // 等 preload API 就绪
  const apiDeadline = Date.now() + 30000;
  while (Date.now() < apiDeadline) {
    const ok = await evalJs("!!(window.novarec && window.novarec.startRecording)").catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  const hasApi = await evalJs("!!(window.novarec && window.novarec.startRecording)");
  if (!hasApi) throw new Error("window.novarec API 未就绪");
  log("novarec API ready");

  const info = await evalJs("window.novarec.getAppInfo()");
  log("app info: version=" + info.version + " electron=" + info.electron + " ffmpeg=" + info.ffmpeg);

  const settings = await evalJs('window.novarec.setSettings(' + JSON.stringify({
    format: "mp4", fps: 30, quality: "high", systemAudio: true, microphone: false,
    countdown: 0, hideMainWindow: true, performanceMode: "off", outputDir: MEDIA_DIR
  }) + ")");
  log("settings: format=" + settings.format + " outputDir=" + settings.outputDir);

  const sources = await evalJs("window.novarec.listSources()");
  log("sources: screens=" + (sources.screens || []).length + " windows=" + (sources.windows || []).length);
  const winTarget = (sources.windows || []).find((w) => w.id !== "" && w.name);

  const cases = [
    { mode: "screen", req: { mode: "screen", sourceId: ((sources.screens || [])[0] || {}).id, countdown: 0, hideMainWindow: true } },
    { mode: "region", req: { mode: "region", region: { x: 120, y: 100, width: 960, height: 540 }, countdown: 0, hideMainWindow: true } },
    { mode: "window", req: { mode: "window", sourceId: winTarget ? winTarget.id : "", countdown: 0, hideMainWindow: false } }
  ];

  const results = [];
  for (const c of cases) {
    const entry = { mode: c.mode, ok: false, error: null, item: null, file: null, size: 0, ms: 0 };
    const t0 = Date.now();
    try {
      const before = await evalJs("window.novarec.listRecordings()");
      const req = Object.assign({ systemAudio: true, format: "mp4", fps: 30, quality: "high", countdown: 0 }, c.req);
      const start = await evalJs("window.novarec.startRecording(" + JSON.stringify(req) + ")");
      if (!start || !start.ok) throw new Error("start 失败: " + JSON.stringify(start));
      log("[" + c.mode + "] recording started");
      await sleep(3200);
      const stop = await evalJs("window.novarec.stopRecording()");
      if (!stop || !stop.ok) throw new Error("stop 失败: " + JSON.stringify(stop));
      log("[" + c.mode + "] stop ok");
      // 等收尾入库（最多 20s）
      let after = before;
      const dl = Date.now() + 20000;
      while (Date.now() < dl) {
        after = await evalJs("window.novarec.listRecordings()");
        if ((after || []).length > (before || []).length) break;
        await sleep(300);
      }
      const item = (after || []).find((it) => !(before || []).some((b) => b.id === it.id));
      if (!item) throw new Error("等待入库超时（录制项未出现）");
      entry.item = { id: item.id, fileName: item.fileName, durationMs: item.durationMs, transcode: item.transcode, size: item.size, hasAudio: item.hasAudio };
      const filePath = item.filePath;
      if (!fs.existsSync(filePath)) throw new Error("落盘文件不存在: " + filePath);
      entry.file = filePath;
      entry.size = fs.statSync(filePath).size;
      entry.ms = Date.now() - t0;
      if (entry.size < 20000) throw new Error("文件过小: " + entry.size);
      if (fs.existsSync(FFMPEG)) {
        // 注意：ffmpeg -i 不带输出文件时退出码非 0，execFileSync 会直接抛错；这里必须用 spawnSync 收集 stderr
    const probeRun = spawnSync(FFMPEG, ["-hide_banner", "-i", filePath], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    const probe = String(probeRun.stdout || "") + String(probeRun.stderr || "");
        entry.probe = { video: /Video:\s*([^\n]+)/.exec(probe)?.[1]?.trim() || "", audio: /Audio:\s*([^\n]+)/.exec(probe)?.[1]?.trim() || "" };
        if (!entry.probe.video) throw new Error("ffmpeg 未识别到视频流");
        if (!entry.probe.audio) throw new Error("ffmpeg 未识别到音频流（系统声音缺失）");
      } else {
        entry.probe = { skipped: true };
      }
      entry.ok = true;
      log("[" + c.mode + "] PASS size=" + entry.size + " dur=" + (entry.item && entry.item.durationMs) + "ms transcode=" + (entry.item && entry.item.transcode) + " probe=" + JSON.stringify(entry.probe));
    } catch (e) {
      entry.error = (e && e.message) || String(e);
      entry.ms = Date.now() - t0;
      log("[" + c.mode + "] FAIL " + entry.error);
    }
    results.push(entry);
  }

  cdp.close();
  const ok = results.every((r) => r.ok);
  const out = { ok, exe: EXE, exeSize: fs.statSync(EXE).size, checkedAt: new Date().toISOString(), appInfo: info, results, appOutputTail: appOut.slice(-4000) };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(out, null, 2), "utf8");
  log("SUMMARY ok=" + ok + " " + results.map((r) => r.mode + ":" + (r.ok ? "PASS" : "FAIL")).join(", "));
  log("result -> " + RESULT_FILE);
  return ok ? 0 : 1;
}

let code = 1;
try { code = await main(); }
catch (e) { log("FATAL " + ((e && e.message) || e)); code = 2; }
finally { killApp(); }
process.exit(code);
