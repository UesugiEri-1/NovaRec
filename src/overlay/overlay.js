"use strict";
// NovaRec 区域选择层：全屏透明窗口，拖拽框选。坐标按 CSS 像素上报，主进程换算为 DIP。
const { ipcRenderer } = require("electron");

const canvas = document.getElementById("dim");
const ctx = canvas.getContext("2d");
const sizeEl = document.getElementById("size");
const hintEl = document.getElementById("hint");

const state = { dragging: false, startX: 0, startY: 0, curX: 0, curY: 0, sel: null };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
  canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function selectionRect() {
  if (!state.sel) return null;
  const x = Math.min(state.sel.x1, state.sel.x2);
  const y = Math.min(state.sel.y1, state.sel.y2);
  const w = Math.abs(state.sel.x2 - state.sel.x1);
  const h = Math.abs(state.sel.y2 - state.sel.y1);
  return { x: x, y: y, width: w, height: h };
}

function draw() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(6, 8, 12, 0.45)";
  ctx.fillRect(0, 0, W, H);
  const r = selectionRect();
  if (r && r.width > 1 && r.height > 1) {
    ctx.clearRect(r.x, r.y, r.width, r.height);
    ctx.save();
    ctx.strokeStyle = "#17A24B";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.width - 1), Math.max(0, r.height - 1));
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.width + 3, r.height + 3);
    ctx.restore();
    const label = Math.round(r.width) + " × " + Math.round(r.height);
    sizeEl.textContent = label;
    sizeEl.style.display = "block";
    let lx = r.x;
    let ly = r.y - 30;
    if (ly < 6) ly = r.y + r.height + 8;
    sizeEl.style.left = Math.max(6, Math.min(W - 110, lx)) + "px";
    sizeEl.style.top = ly + "px";
    sizeEl.style.top = ly + "px";
  } else {
    sizeEl.style.display = "none";
  }
  hintEl.style.opacity = r ? "0.35" : "1";
}

function pointerPos(ev) {
  return { x: Math.max(0, Math.min(window.innerWidth, ev.clientX)), y: Math.max(0, Math.min(window.innerHeight, ev.clientY)) };
}

function onDown(ev) {
  if (ev.button !== 0) return;
  const p = pointerPos(ev);
  state.dragging = true;
  state.startX = p.x;
  state.startY = p.y;
  state.curX = p.x;
  state.curY = p.y;
  state.sel = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  draw();
}

function onMove(ev) {
  if (!state.dragging) return;
  const p = pointerPos(ev);
  state.curX = p.x;
  state.curY = p.y;
  state.sel = { x1: state.startX, y1: state.startY, x2: p.x, y2: p.y };
  draw();
}

function onUp(ev) {
  if (!state.dragging) return;
  state.dragging = false;
  const p = pointerPos(ev);
  state.sel = { x1: state.startX, y1: state.startY, x2: p.x, y2: p.y };
  const r = selectionRect();
  if (r && r.width < 8 && r.height < 8) {
    state.sel = null;
    draw();
    return;
  }
  draw();
}

function confirmSelection() {
  const r = selectionRect();
  if (!r || r.width < 8 || r.height < 8) return;
  ipcRenderer.send("overlay:done", {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    pageWidth: window.innerWidth,
    pageHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1
  });
}

function cancel() { ipcRenderer.send("overlay:cancelled", {}); }

canvas.addEventListener("mousedown", onDown);
canvas.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);
window.addEventListener("resize", resize);
window.addEventListener("keydown", function (ev) {
  if (ev.key === "Enter") { ev.preventDefault(); confirmSelection(); }
  else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key === "a") { ev.preventDefault(); state.sel = { x1: 0, y1: 0, x2: window.innerWidth, y2: window.innerHeight }; draw(); }
});
window.addEventListener("contextmenu", function (ev) { ev.preventDefault(); cancel(); });
window.addEventListener("blur", function () { /* 保持选择，不自动取消 */ });

resize();
ipcRenderer.send("overlay:ready", {});
window.focus();
