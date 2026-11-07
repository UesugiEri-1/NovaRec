// 冷/热启动耗时测量：启动打包后的 NovaRec.exe，等待渲染层 target 出现并 window.novarec 可用
// 运行: node scripts/measure-startup.mjs [--exe <path>] [--runs 2]
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const EXE = path.resolve(ROOT, arg("exe", path.join("artifacts", "dist-v5", "NovaRec-win32-x64", "NovaRec.exe")));
const RUNS = Math.max(1, parseInt(arg("runs", "2"), 10));
const OUT = path.join(ROOT, "artifacts", "startup");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(idx) {
  const port = 9410 + idx;
  const dataDir = path.join(OUT, "data-" + idx);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const env = Object.assign({}, process.env, { NOVAREC_DATA_DIR: dataDir, NOVAREC_NO_SANDBOX: "1" });
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const child = spawn(EXE, ["--remote-debugging-port=" + port, "--no-sandbox"], { env, cwd: path.dirname(EXE), windowsHide: true, stdio: "ignore" });
  const res = { run: idx, t0: new Date().toISOString(), firstTargetMs: null, apiReadyMs: null, domContentLoadedMs: null, loadEventMs: null, url: null };
  let ws = null;
  try {
    // 1) 等 CDP target 出现
    let page = null;
    for (let i = 0; i < 400; i++) {
      try {
        const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
        page = (list || []).find((x) => x.type === "page" && /renderer[\\/]index\.html/.test(x.url || ""));
        if (page) { res.firstTargetMs = Date.now() - t0; res.url = page.url; break; }
      } catch (e) {}
      await sleep(25);
    }
    if (!page) throw new Error("未等到渲染层 target");
    // 2) 等 preload 暴露 window.novarec
    const WebSocketCtor = globalThis.WebSocket;
    ws = new WebSocketCtor(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
    let nextId = 1;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    const send = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params: params || {} })); });
    await send("Runtime.enable");
    try { await send("Performance.enable"); } catch (e) {}
    const evalJs = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      return r && r.result && r.result.result ? r.result.result.value : undefined;
    };
    for (let i = 0; i < 400; i++) {
      const ok = await evalJs("!!(window.novarec && window.novarec.getAppInfo)").catch(() => false);
      if (ok) { res.apiReadyMs = Date.now() - t0; break; }
      await sleep(20);
    }
    const timing = await evalJs("JSON.stringify((function(){var n=performance.getEntriesByType('navigation')[0]||{};var p=performance.getEntriesByType('paint')||[];return {dcl:Math.round(n.domContentLoadedEventEnd||0),load:Math.round(n.loadEventEnd||0),dclStart:Math.round(n.domInteractive||0),respEnd:Math.round(n.responseEnd||0),paint:p.map(function(x){return x.name+'='+Math.round(x.startTime);}).join(','),ready:document.readyState,now:Math.round(performance.now())};})())").catch(() => null);
    if (timing) { try { const t = JSON.parse(timing); res.domContentLoadedMs = t.dcl; res.loadEventMs = t.load; res.interactiveMs = t.dclStart; res.responseEndMs = t.respEnd; res.paint = t.paint; res.navNow = t.now; res.readyState = t.ready; } catch (e) {} }
    try {
      const m = await send("Performance.getMetrics");
      const map = {};
      ((m && m.result && m.result.metrics) || []).forEach(function (x) { map[x.name] = Math.round(x.value * 1000) / 1000; });
      res.metrics = { ScriptDuration: map.ScriptDuration, LayoutDuration: map.LayoutDuration, RecalcStyleDuration: map.RecalcStyleDuration, TaskDuration: map.TaskDuration, JSHeapUsedSize: map.JSHeapUsedSize };
    } catch (e) {}
  } catch (e) {
    res.error = String((e && e.message) || e);
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch (e) {}
  }
  return res;
}

const runs = [];
for (let i = 0; i < RUNS; i++) { runs.push(await runOnce(i)); console.log("RUN " + JSON.stringify(runs[runs.length - 1])); await sleep(600); }
const out = { exe: EXE, exeBytes: fs.existsSync(EXE) ? fs.statSync(EXE).size : 0, at: new Date().toISOString(), runs };
fs.writeFileSync(path.join(OUT, "startup.json"), JSON.stringify(out, null, 2));
console.log("WROTE " + path.join(OUT, "startup.json"));
