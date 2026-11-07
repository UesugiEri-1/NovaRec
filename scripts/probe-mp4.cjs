"use strict";
// 探针：抓一段 MediaRecorder MP4 并分析 box 结构（fragmented? 时长? mfra?）
const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
app.setPath("userData", path.join(ROOT, ".data-probe"));
process.on("uncaughtException", function (e) { console.log("UNCAUGHT " + ((e && e.stack) || e)); app.exit(3); });
const OUT = path.join(ROOT, "artifacts", "probe-mp4");
fs.mkdirSync(OUT, { recursive: true });
const outBase = path.join(OUT, "sample");

function analyze(file) {
  const buf = fs.readFileSync(file);
  const r = { file, bytes: buf.length, top: [], fragments: 0, mfra: false };
  let off = 0;
  const boxes = [];
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    if (!size || size < 8 || off + size > buf.length) { r.badBox = { off, size, type }; break; }
    boxes.push({ type, off, size });
    off += size;
  }
  r.top = boxes.map(b => b.type + ":" + b.size);
  function kids(m, start, end) {
    const out = []; let p = start;
    while (p + 8 <= end) { const s = m.readUInt32BE(p); const t = m.toString("latin1", p + 4, p + 8); if (s < 8 || p + s > end) break; out.push({ type: t, off: p, size: s }); p += s; }
    return out;
  }
  const moov = boxes.find(b => b.type === "moov");
  if (moov) {
    const m = buf.subarray(moov.off, moov.off + moov.size);
    r.moov = { size: moov.size, children: kids(m, 8, m.length).map(k => k.type + ":" + k.size) };
    kids(m, 8, m.length).forEach(function (k) {
      if (k.type === "mvhd") {
        const ver = m[k.off + 8];
        r.mvhd = { version: ver, timescale: m.readUInt32BE(k.off + 8 + (ver === 1 ? 20 : 12)), duration: ver === 1 ? Number(m.readBigUInt64BE(k.off + 8 + 24)) : m.readUInt32BE(k.off + 8 + 16) };
      }
      if (k.type === "mvex") r.mvex = true;
      if (k.type === "trak") {
        const tr = { kids: kids(m, k.off + 8, k.off + k.size).map(x => x.type + ":" + x.size) };
        kids(m, k.off + 8, k.off + k.size).forEach(function (x) {
          if (x.type === "tkhd") { const v = m[x.off + 8]; tr.tkhd = { version: v, duration: v === 1 ? Number(m.readBigUInt64BE(x.off + 8 + 28)) : m.readUInt32BE(x.off + 8 + 20), w: m.readUInt32BE(x.off + 8 + (v === 1 ? 88 : 76)) / 65536, h: m.readUInt32BE(x.off + 8 + (v === 1 ? 92 : 80)) / 65536 }; }
          if (x.type === "mdia") {
            kids(m, x.off + 8, x.off + x.size).forEach(function (d) {
              if (d.type === "mdhd") { const v = m[d.off + 8]; tr.mdhd = { version: v, timescale: m.readUInt32BE(d.off + 8 + (v === 1 ? 20 : 12)), duration: v === 1 ? Number(m.readBigUInt64BE(d.off + 8 + 24)) : m.readUInt32BE(d.off + 8 + 16) }; }
              if (d.type === "hdlr") tr.handler = m.toString("latin1", d.off + 16, d.off + 20).trim();
              if (d.type === "minf") {
                kids(m, d.off + 8, d.off + d.size).forEach(function (mm) {
                  if (mm.type !== "stbl") return;
                  tr.stbl = kids(m, mm.off + 8, mm.off + mm.size).map(st => st.type + ":" + st.size);
                  kids(m, mm.off + 8, mm.off + mm.size).forEach(function (st) {
                    if (st.type === "stsd") tr.stsdSize = st.size;
                  });
                });
              }
            });
          }
        });
        (r.traks = r.traks || []).push(tr);
      }
    });
  }
  // 采样片段：统计 moof 里的 trun sample_count 总和与 tfdt
  let samples = 0; const frags = [];
  boxes.filter(b => b.type === "moof").forEach(function (b) {
    const m = buf.subarray(b.off, b.off + b.size);
    let n = 0, tfdt = null;
    kids(m, 8, m.length).forEach(function (t) {
      if (t.type !== "traf") return;
      kids(m, t.off + 8, t.off + t.size).forEach(function (x) {
        if (x.type === "tfdt") { const v = m[x.off + 8]; tfdt = v === 1 ? Number(m.readBigUInt64BE(x.off + 12)) : m.readUInt32BE(x.off + 12); }
        if (x.type === "trun") { const v = m[x.off + 8]; n += m.readUInt32BE(x.off + 8 + (v === 1 ? 8 : 4) + 0) || 0; }
      });
    });
    samples += n; frags.push({ n, tfdt });
  });
  r.fragments = frags.length;
  r.samples = samples;
  r.fragSamples = frags.slice(0, 6);
  r.mfra = boxes.some(b => b.type === "mfra");
  return r;
}

app.whenReady().then(async function () {
  const killTimer = setTimeout(function () { console.log("TIMEOUT-HARD"); app.exit(4); }, 40000);
  const win = new BrowserWindow({ show: false, width: 480, height: 320, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  let started = false;
  ipcMain.on("capture:log", function (ev, p) { const s = String(p && p.message || ""); if (/error|fail|warning/i.test(s)) console.log("[cap] " + s); });
  ipcMain.on("capture:ready", async function () {
    if (started) return; started = true;
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
      const screenId = (sources[0] && sources[0].id) || "screen:0:0";
      console.log("screen source=" + screenId);
      win.webContents.send("capture:start", {
        sessionId: "probe", mode: "screen", sourceId: screenId, screenId: screenId,
        format: "mp4", fps: 30, quality: "high", systemAudio: true, microphone: false,
        region: null, displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
        perf: {}, outBasePath: outBase
      });
    } catch (e) { console.log("ERR " + e.message); app.exit(5); }
  });
  ipcMain.on("capture:started", function (ev, info) {
    console.log("started " + JSON.stringify(info));
    setTimeout(function () { win.webContents.send("capture:stop", {}); }, 2500);
  });
  ipcMain.on("capture:stopped", function (ev, info) {
    try {
      const r = analyze(info.tempPath);
      r.captureInfo = info;
      fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(r, null, 2));
      console.log("REPORT " + JSON.stringify(r));
    } catch (e) { console.log("analyze fail " + e.message); }
    clearTimeout(killTimer);
    setTimeout(function () { app.exit(0); }, 300);
  });
  ipcMain.on("capture:error", function (ev, p) { console.log("capture error " + JSON.stringify(p)); clearTimeout(killTimer); app.exit(6); });
  await win.loadFile(path.join(ROOT, "src", "capture", "capture.html"));
  console.log("loaded capture.html");
});
