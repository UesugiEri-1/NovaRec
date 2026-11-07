"use strict";
// 探针：抓一段 MediaRecorder MP4 并分析 box 结构，判断是否 fragmented、时长是否可读、有无 mfra。
const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
app.setPath("userData", path.join(ROOT, ".data-probe"));
const OUT = path.join(ROOT, "artifacts", "probe-mp4");
fs.mkdirSync(OUT, { recursive: true });
const outBase = path.join(OUT, "sample");
const results = [];

function analyze(file) {
  const buf = fs.readFileSync(file);
  const r = { file, bytes: buf.length, top: [], moov: null, fragments: 0, mfra: null, duration: null };
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
  const moovBox = boxes.find(b => b.type === "moov");
  if (moovBox) {
    const m = buf.subarray(moovBox.off, moovBox.off + moovBox.size);
    const kids = [];
    let p = 8;
    while (p + 8 <= m.length) {
      let s = m.readUInt32BE(p); const t = m.toString("latin1", p + 4, p + 8);
      if (s < 8 || p + s > m.length) break;
      kids.push(t + ":" + s);
      p += s;
    }
    r.moov = { size: moovBox.size, children: kids };
    // mvhd
    let q = 8;
    while (q + 8 <= m.length) {
      let s = m.readUInt32BE(q); const t = m.toString("latin1", q + 4, q + 8);
      if (s < 8) break;
      if (t === "mvhd") {
        const ver = m[q + 8];
        r.mvhd = { version: ver, size: s, timescale: m.readUInt32BE(q + 8 + (ver === 1 ? 20 : 12)), duration: ver === 1 ? Number(m.readBigUInt64BE(q + 8 + 24)) : m.readUInt32BE(q + 8 + 16) };
      }
      if (t === "trak") {
        const tr = { size: s, kids: [] };
        let k = q + 8;
        while (k + 8 <= q + s) {
          const ks = m.readUInt32BE(k); const kt = m.toString("latin1", k + 4, k + 8);
          if (ks < 8) break;
          tr.kids.push(kt + ":" + ks);
          if (kt === "tkhd") { const v = m[k + 8]; tr.tkhd = { version: v, w: m.readUInt32BE(k + 8 + (v === 1 ? 88 : 76)) / 65536, h: m.readUInt32BE(k + 8 + (v === 1 ? 92 : 80)) / 65536, duration: v === 1 ? Number(m.readBigUInt64BE(k + 8 + 28)) : m.readUInt32BE(k + 8 + 20) }; }
          if (kt === "mdia") {
            let d = k + 8;
            while (d + 8 <= k + ks) {
              const ds = m.readUInt32BE(d); const dt = m.toString("latin1", d + 4, d + 8);
              if (ds < 8) break;
              if (dt === "mdhd") { const v = m[d + 8]; tr.mdhd = { version: v, timescale: m.readUInt32BE(d + 8 + (v === 1 ? 20 : 12)), duration: v === 1 ? Number(m.readBigUInt64BE(d + 8 + 24)) : m.readUInt32BE(d + 8 + 16) }; }
              if (dt === "hdlr") { tr.handler = m.toString("latin1", d + 16, d + 20); }
              d += ds;
            }
          }
          k += ks;
        }
        r.trak = r.trak || [];
        r.trak.push(tr);
      }
      q += s;
    }
  }
  r.fragments = boxes.filter(b => b.type === "moof").length;
  r.mfra = boxes.some(b => b.type === "mfra");
  return r;
}

app.whenReady().then(async function () {
  const win = new BrowserWindow({
    show: false, width: 480, height: 320,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false }
  });
  let saveTimer = null;
  ipcMain.on("capture:log", function (ev, p) { console.log("[cap] " + (p && p.message)); });
  ipcMain.on("capture:ready", function () {
    const sources = await0();
  });
  async function await0() {}
  ipcMain.on("capture:ready", async function () {
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
    } catch (e) { console.log("ERR " + e.message); }
  });
  ipcMain.on("capture:started", function (ev, info) {
    console.log("started " + JSON.stringify(info));
    setTimeout(function () { win.webContents.send("capture:stop", {}); }, 2500);
  });
  ipcMain.on("capture:stopped", function (ev, info) {
    console.log("stopped " + JSON.stringify(info));
    try {
      const r = analyze(info.tempPath);
      r.captureInfo = info;
      fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(r, null, 2));
      console.log("REPORT " + JSON.stringify(r));
    } catch (e) { console.log("analyze fail " + e.message); }
    setTimeout(function () { app.quit(); }, 300);
  });
  ipcMain.on("capture:error", function (ev, p) { console.log("capture error " + JSON.stringify(p)); });
  await win.loadFile(path.join(ROOT, "src", "capture", "capture.html"));
});
