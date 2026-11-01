"use strict";
// NovaRec 应用图标生成：SVG 矢量源 -> Electron 渲染进程按目标尺寸精确栅格化 -> PNG + ICO。
// 图标：绿色 squircle + 白色准星标记（断口圆环 + 四向刻度 + 中心点），与 UI 品牌标记一致。
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const ART = path.join(ROOT, "artifacts");
fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(ART, { recursive: true });
const DEV_DATA = path.join(ROOT, ".data-icons");
fs.mkdirSync(DEV_DATA, { recursive: true });
app.setPath("userData", DEV_DATA);
app.setPath("sessionData", DEV_DATA);
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-gpu");

const LOGF = path.join(ART, "make-icons.log");
try { fs.writeFileSync(LOGF, ""); } catch (e) {}
function log(m) { const line = "[" + new Date().toISOString() + "] " + m; try { fs.appendFileSync(LOGF, line + String.fromCharCode(10)); } catch (e) {} console.log(line); }

const CX = 512, CY = 512;
const R = 238;          // 准星环半径
const RING_W = 36;      // 环线宽
const GAP = 15;         // 每个断口角度
const TICK_IN = 226;    // 刻度起点半径
const TICK_OUT = 302;   // 刻度终点半径
const TICK_W = 34;
const DOT_R = 72;

function pt(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arcPath(r, from, to) {
  const a = pt(r, from), b = pt(r, to);
  return "M" + a[0].toFixed(1) + " " + a[1].toFixed(1) + "A" + r + " " + r + " 0 0 1 " + b[0].toFixed(1) + " " + b[1].toFixed(1);
}

function rings() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const center = i * 90;
    const from = center - 90 / 2 + GAP / 2;
    const to = center + 90 / 2 - GAP / 2;
    out.push('  <path d="' + arcPath(R, from, to) + '" fill="none" stroke="' + "COLOR" + '" stroke-width="' + RING_W + '" stroke-linecap="butt"/>');
  }
  return out.join("\n");
}

function ticks() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const deg = i * 90;
    const a = pt(TICK_IN, deg), b = pt(TICK_OUT, deg);
    out.push('  <path d="M' + a[0].toFixed(1) + " " + a[1].toFixed(1) + "L" + b[0].toFixed(1) + " " + b[1].toFixed(1) + '" stroke="' + "COLOR" + '" stroke-width="' + TICK_W + '" stroke-linecap="butt"/>');
  }
  return out.join("\n");
}

function markSvg(color, dotColor, bold) {
  // bold：托盘图标用更粗的线稿，保证 32px 下仍清晰
  const b = bold || 1;
  const ring = [];
  for (let i = 0; i < 4; i++) {
    const from = i * 90 - 45 + (GAP + (b - 1) * 6) / 2;
    const to = i * 90 + 45 - (GAP + (b - 1) * 6) / 2;
    ring.push('  <path d="' + arcPath(R, from, to) + '" fill="none" stroke="' + color + '" stroke-width="' + (RING_W * b) + '" stroke-linecap="butt"/>');
  }
  const bars = [];
  for (let i = 0; i < 4; i++) {
    const a = pt(TICK_IN - (b - 1) * 30, i * 90), c = pt(TICK_OUT + (b - 1) * 10, i * 90);
    bars.push('  <path d="M' + a[0].toFixed(1) + " " + a[1].toFixed(1) + "L" + c[0].toFixed(1) + " " + c[1].toFixed(1) + '" stroke="' + color + '" stroke-width="' + (TICK_W * b) + '" stroke-linecap="butt"/>');
  }
  return ring.join("\n") + "\n" + bars.join("\n") + "\n" +
    '  <circle cx="' + CX + '" cy="' + CY + '" r="' + (DOT_R + (b - 1) * 34) + '" fill="' + dotColor + '"/>';
}

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n' +
' <defs>\n' +
'  <linearGradient id="bg" x1="140" y1="70" x2="890" y2="960" gradientUnits="userSpaceOnUse">\n' +
'   <stop offset="0" stop-color="#3ACB74"/>\n' +
'   <stop offset="0.52" stop-color="#20B45C"/>\n' +
'   <stop offset="1" stop-color="#0B8A42"/>\n' +
'  </linearGradient>\n' +
'  <linearGradient id="sheen" x1="512" y1="32" x2="512" y2="560" gradientUnits="userSpaceOnUse">\n' +
'   <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.12"/>\n' +
'   <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>\n' +
'  </linearGradient>\n' +
' </defs>\n' +
' <rect x="32" y="32" width="960" height="960" rx="224" fill="url(#bg)"/>\n' +
' <rect x="32" y="32" width="960" height="960" rx="224" fill="url(#sheen)"/>\n' +
' <rect x="33.5" y="33.5" width="957" height="957" rx="222.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="3"/>\n' +
markSvg("#FFFFFF", "#FFFFFF") + "\n" +
'</svg>';

const TRAY_IDLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n' +
markSvg("#FFFFFF", "#FFFFFF", 1.9) + "\n</svg>";

const TRAY_REC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n' +
markSvg("#FFFFFF", "#FF4D6D", 1.9) + "\n" +
'  <circle cx="' + CX + '" cy="' + CY + '" r="' + (DOT_R + 12) + '" fill="none" stroke="#FF4D6D" stroke-opacity="0.45" stroke-width="14"/>\n' +
'</svg>';

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  pngs.forEach(function (p) {
    const s = p.size;
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.png.length;
    entries.push(e);
  });
  return Buffer.concat([header].concat(entries).concat(pngs.map(function (p) { return p.png; })));
}

function drawSrc(svg, size) {
  return "(async function(){ var svg=" + JSON.stringify(svg) + "; var size=" + size + ";" +
    "var img=new Image(); img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg); await img.decode();" +
    "var c=document.createElement('canvas'); c.width=size; c.height=size; var ctx=c.getContext('2d');" +
    "ctx.clearRect(0,0,size,size); ctx.imageSmoothingQuality='high'; ctx.drawImage(img,0,0,size,size);" +
    "return c.toDataURL('image/png'); })()";
}

async function render(win, svg, size) {
  const dataUrl = await win.webContents.executeJavaScript(drawSrc(svg, size), true);
  return Buffer.from(String(dataUrl).split(",")[1], "base64");
}

async function main() {
  await app.whenReady();
  log("electron ready; rasterizing icons");
  fs.writeFileSync(path.join(ART, "icon-src.svg"), ICON_SVG);
  const win = new BrowserWindow({ width: 64, height: 64, show: false, transparent: true, webPreferences: { offscreen: false, backgroundThrottling: false } });
  await win.loadURL("about:blank");
  const ICON_SIZES = [1024, 512, 256, 128, 64, 48, 32, 16];
  const out = {};
  for (const size of ICON_SIZES) {
    out["icon-" + size] = await render(win, ICON_SVG, size);
  }
  out["tray-32"] = await render(win, TRAY_IDLE_SVG, 32);
  out["trayrec-32"] = await render(win, TRAY_REC_SVG, 32);
  log("rendered " + ICON_SIZES.length + " icon sizes + tray");
  fs.writeFileSync(path.join(ASSETS, "icon-1024.png"), out["icon-1024"]);
  fs.writeFileSync(path.join(ASSETS, "icon-512.png"), out["icon-512"]);
  fs.writeFileSync(path.join(ASSETS, "icon.png"), out["icon-256"]);
  fs.writeFileSync(path.join(ASSETS, "icon-128.png"), out["icon-128"]);
  fs.writeFileSync(path.join(ASSETS, "tray.png"), out["tray-32"]);
  fs.writeFileSync(path.join(ASSETS, "tray-recording.png"), out["trayrec-32"]);
  const icoSizes = [256, 128, 64, 48, 32, 16];
  const ico = buildIco(icoSizes.map(function (s) { return { size: s, png: out["icon-" + s] }; }));
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), ico);
  log("written: icon.png=" + out["icon-256"].length + "B icon.ico=" + ico.length + "B tray.png=" + out["tray-32"].length + "B");
  log("done");
  setTimeout(function () { app.exit(0); }, 200);
}

main().catch(function (e) {
  log("ERROR: " + ((e && e.stack) || e));
  try { app.exit(1); } catch (_) {}
});