"use strict";
// 探针：分别录 mp4(8s) 与 webm(4s)，输出结构分析（mp4 box / webm EBML），保留样本文件供后续 remux 模块测试。
const { app, BrowserWindow, ipcMain, desktopCapturer } = require("electron");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
app.setPath("userData", path.join(ROOT, ".data-probe"));
process.on("uncaughtException", function (e) { console.log("UNCAUGHT " + ((e && e.stack) || e)); app.exit(3); });
const OUT = path.join(ROOT, "artifacts", "probe-formats");
fs.mkdirSync(OUT, { recursive: true });
const report = {};

function kids(buf, start, end) {
  const out = []; let p = start;
  while (p + 8 <= end) { const s = buf.readUInt32BE(p); const t = buf.toString("latin1", p + 4, p + 8); if (s < 8 || p + s > end) break; out.push({ type: t, off: p, size: s }); p += s; }
  return out;
}
function analyzeMp4(file) {
  const buf = fs.readFileSync(file); const r = { bytes: buf.length, top: [] };
  let off = 0; const boxes = [];
  while (off + 8 <= buf.length) { let s = buf.readUInt32BE(off); const t = buf.toString("latin1", off + 4, off + 8); if (s === 1) s = Number(buf.readBigUInt64BE(off + 8)); if (!s || s < 8 || off + s > buf.length) { r.badBox = { off, s, t }; break; } boxes.push({ type: t, off, size: s }); off += s; }
  r.top = boxes.map(b => b.type + ":" + b.size);
  r.fragments = boxes.filter(b => b.type === "moof").length;
  r.mfra = boxes.some(b => b.type === "mfra");
  const moov = boxes.find(b => b.type === "moov");
  if (moov) {
    const m = buf.subarray(moov.off, moov.off + moov.size);
    r.moovKids = kids(m, 8, m.length).map(k => k.type + ":" + k.size);
    kids(m, 8, m.length).forEach(function (k) {
      if (k.type === "mvhd") { const v = m[k.off + 8]; r.mvhd = { ts: m.readUInt32BE(k.off + 8 + (v === 1 ? 20 : 12)), dur: v === 1 ? Number(m.readBigUInt64BE(k.off + 8 + 24)) : m.readUInt32BE(k.off + 8 + 16) }; }
      if (k.type === "trak") {
        const tr = { kids: kids(m, k.off + 8, k.off + k.size).map(x => x.type + ":" + x.size) };
        kids(m, k.off + 8, k.off + k.size).forEach(function (x) {
          if (x.type === "mdia") kids(m, x.off + 8, x.off + x.size).forEach(function (d) {
            if (d.type === "mdhd") { const v = m[d.off + 8]; tr.mdhd = { ts: m.readUInt32BE(d.off + 8 + (v === 1 ? 20 : 12)), dur: v === 1 ? Number(m.readBigUInt64BE(d.off + 8 + 24)) : m.readUInt32BE(d.off + 8 + 16) }; }
            if (d.type === "hdlr") tr.handler = m.toString("latin1", d.off + 16, d.off + 20).trim();
          });
        });
        (r.traks = r.traks || []).push(tr);
      }
    });
  }
  // 每个 moof 的 traf 统计（样本数/时长）
  r.fragInfo = boxes.filter(b => b.type === "moof").slice(0, 4).map(function (b) {
    const m = buf.subarray(b.off, b.off + b.size); const info = { off: b.off, size: b.size, trafs: [] };
    kids(m, 8, m.length).forEach(function (t) {
      if (t.type !== "traf") return;
      const ti = { kids: [], tfhdFlags: null, samples: [] };
      kids(m, t.off + 8, t.off + t.size).forEach(function (x) {
        ti.kids.push(x.type + ":" + x.size);
        if (x.type === "tfhd") { const fl = m.readUInt32BE(x.off + 8) & 0xffffff; ti.tfhdFlags = fl; ti.trackId = m.readUInt32BE(x.off + 12); }
        if (x.type === "trun") {
          const fl = m.readUInt32BE(x.off + 8) & 0xffffff; const cnt = m.readUInt32BE(x.off + 12);
          let p = x.off + 16; let dataOffset = null;
          if (fl & 0x1) { dataOffset = m.readInt32BE(p); p += 4; }
          if (fl & 0x4) p += 4;
          ti.samples.push({ count: cnt, flags: fl, dataOffset });
        }
      });
      info.trafs.push(ti);
    });
    return info;
  });
  return r;
}

// --- EBML ---
function readVint(buf, off, keepMarker) {
  const b = buf[off]; if (!b) return null;
  let len = 0; for (let i = 7; i >= 0; i--) { if (b & (1 << i)) { len = 8 - i; break; } }
  if (!len || off + len > buf.length) return null;
  let val = keepMarker ? b : (b & ((1 << (8 - len)) - 1));
  if (!keepMarker) { for (let i = 1; i < len; i++) val = val * 256 + buf[off + i]; }
  else { for (let i = 1; i < len; i++) val = val * 256 + buf[off + i]; }
  return { value: val, length: len };
}
function hexId(id) { return "0x" + id.toString(16).toUpperCase(); }
const NAMES = { 0x1A45DFA3: "EBML", 0x18538067: "Segment", 0x114D9B74: "SeekHead", 0x1549A966: "Info", 0x1654AE6B: "Tracks", 0x1F43B675: "Cluster", 0x1C53BB6B: "Cues", 0x4489: "Duration", 0x2AD7B1: "TimecodeScale", 0x4D80: "MuxingApp", 0x5741: "WritingApp", 0xE7: "Timecode", 0xA3: "SimpleBlock", 0x1654AE6B: "Tracks", 0xAE: "TrackEntry", 0xD7: "TrackNumber", 0x1C53BB6B: "Cues", 0xEC: "Void", 0x1254C367: "Tags", 0x1043A770: "Chapters" };
function analyzeWebm(file) {
  const buf = fs.readFileSync(file);
  const r = { bytes: buf.length, top: [], segmentKids: [], unknownSizeClusters: 0, clusters: 0, hasDuration: false, hasCues: false, hasSeekHead: false };
  // EBML header
  let off = 0;
  const e = readVint(buf, off, true); const eSize = readVint(buf, off + e.length, false);
  off += e.length + eSize.length + eSize.value;
  r.ebmlHeader = { id: hexId(e.value), size: eSize.value };
  // Segment
  if (off + 4 > buf.length) return r;
  const seg = readVint(buf, off, true); const segSize = readVint(buf, off + seg.length, false);
  r.segment = { id: hexId(seg.value), sizeRaw: segSize.value, unknown: segSize.value === Math.pow(2, 56) - 1, headerLen: seg.length + segSize.length };
  let p = off + seg.length + segSize.length;
  const end = buf.length;
  while (p + 2 <= end) {
    const id = readVint(buf, p, true); if (!id) break;
    const size = readVint(buf, p + id.length, false); if (!size) break;
    const dataStart = p + id.length + size.length;
    const name = NAMES[id.value] || hexId(id.value);
    r.top.push(name + ":" + size.value);
    if (id.value === 0x1F43B675) {
      r.clusters++;
      if (size.value === Math.pow(2, 56) - 1) {
        r.unknownSizeClusters++;
        // 扫描下一个 Cluster 起点：按 SimpleBlock/BlockGroup/Timecode 解析子元素
        let q = dataStart;
        while (q + 2 <= end) {
          const cid = readVint(buf, q, true); if (!cid) break;
          if (cid.value === 0x1F43B675) break; // 下一个 Cluster
          const csz = readVint(buf, q + cid.length, false);
          if (!csz && csz.value !== 0) break;
          if (csz.value === Math.pow(2, 56) - 1) { r.badClusterChild = true; break; }
          q = q + cid.length + csz.length + csz.value;
        }
        p = q;
        continue;
      }
    } else if (id.value === 0x1549A966 && size.value < 4096) {
      r.hasDuration = buf.subarray(dataStart, dataStart + size.value).indexOf(Buffer.from([0x44, 0x89])) >= 0;
      r.infoSize = size.value;
    } else if (id.value === 0x1C53BB6B) { r.hasCues = true; r.cuesSize = size.value; }
    else if (id.value === 0x114D9B74) { r.hasSeekHead = true; r.seekHeadSize = size.value; }
    p = dataStart + size.value;
  }
  return r;
}

let seq = [
  { key: "mp4-8s", format: "mp4", ms: 8000 },
  { key: "webm-4s", format: "webm", ms: 4000 }
];
let idx = 0;
app.whenReady().then(async function () {
  const killTimer = setTimeout(function () { console.log("TIMEOUT-HARD"); app.exit(4); }, 90000);
  const win = new BrowserWindow({ show: false, width: 480, height: 320, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  let started = false, stopping = false;
  ipcMain.on("capture:log", function (ev, p) { const s = String(p && p.message || ""); if (/error|fail|warning/i.test(s)) console.log("[cap] " + s); });
  function startNext() {
    if (idx >= seq.length) { clearTimeout(killTimer); fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2)); console.log("ALLDONE " + JSON.stringify(report).slice(0, 1200)); setTimeout(function () { app.exit(0); }, 300); return; }
    const item = seq[idx];
    desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).then(function (sources) {
      const screenId = (sources[0] && sources[0].id) || "screen:0:0";
      started = true; stopping = false;
      console.log("--- recording " + item.key + " source=" + screenId);
      win.webContents.send("capture:start", {
        sessionId: item.key, mode: "screen", sourceId: screenId, screenId: screenId,
        format: item.format, fps: 30, quality: "high", systemAudio: true, microphone: false,
        region: null, displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, perf: {}, outBasePath: path.join(OUT, item.key)
      });
    });
  }
  ipcMain.on("capture:ready", function () { if (!started) startNext(); });
  ipcMain.on("capture:started", function (ev, info) {
    console.log("started " + info.mime + " " + info.width + "x" + info.height);
    setTimeout(function () { stopping = true; win.webContents.send("capture:stop", {}); }, seq[idx].ms);
  });
  ipcMain.on("capture:stopped", function (ev, info) {
    try {
      const r = seq[idx].format === "mp4" ? analyzeMp4(info.tempPath) : analyzeWebm(info.tempPath);
      r.file = info.tempPath; r.capture = info;
      report[seq[idx].key] = r;
      console.log("RESULT " + seq[idx].key + " " + JSON.stringify(r).slice(0, 900));
    } catch (e) { console.log("analyze fail " + e.message); }
    idx++;
    setTimeout(startNext, 500);
  });
  ipcMain.on("capture:error", function (ev, p) { console.log("capture error " + JSON.stringify(p)); idx++; setTimeout(startNext, 500); });
  await win.loadFile(path.join(ROOT, "src", "capture", "capture.html"));
  console.log("loaded capture.html");
});
