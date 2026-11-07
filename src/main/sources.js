"use strict";
// desktopCapturer 采集源 / 显示器信息封装。
const { desktopCapturer, screen } = require("electron");

function imgToDataUrl(img) {
  try {
    if (!img || (typeof img.isEmpty === "function" && img.isEmpty())) return null;
    return img.toDataURL();
  } catch (e) { return null; }
}

function guessAppName(title) {
  if (!title) return "应用";
  const parts = String(title).split(/\u2014|\u2013| - |\uFF0D/);
  if (parts.length > 1) {
    const tail = parts[parts.length - 1].trim();
    if (tail && tail.length <= 40) return tail;
  }
  return "";
}

// 采集源枚举。thumbnails === false 时只取 id/name/display_id，不做窗口截图与 PNG 编码，
// 主进程几毫秒即可返回（带缩略图要几十到几百 ms，还有每个窗口一次同步 toDataURL）；
// 渲染层首屏先用轻量版拿到列表，首帧之后再补一轮带缩略图的。
async function listSources(opts) {
  const o = opts || {};
  const wantThumb = o.thumbnails !== false;
  const raw = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: wantThumb ? { width: 480, height: 270 } : { width: 0, height: 0 },
    fetchWindowIcons: wantThumb && o.icons !== false
  });
  const screens = [];
  const windows = [];
  raw.forEach(function (s) {
    if (s.id.indexOf("screen:") === 0) {
      screens.push({
        id: s.id,
        name: s.name || "整个屏幕",
        displayId: s.display_id || "",
        thumbnailDataUrl: imgToDataUrl(s.thumbnail),
        appIconDataUrl: null,
        appName: "",
        isScreen: true
      });
    } else if (s.id.indexOf("window:") === 0) {
      const name = (s.name || "").trim();
      if (!name) return;
      windows.push({
        id: s.id,
        name: name,
        displayId: "",
        thumbnailDataUrl: imgToDataUrl(s.thumbnail),
        appIconDataUrl: imgToDataUrl(s.appIcon),
        appName: guessAppName(name),
        isScreen: false
      });
    }
  });
  screens.sort(function (a, b) { return String(a.id).localeCompare(String(b.id)); });
  windows.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return { screens: screens, windows: windows };
}

function unionBounds(list) {
  if (!list.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  list.forEach(function (d) {
    x1 = Math.min(x1, d.bounds.x);
    y1 = Math.min(y1, d.bounds.y);
    x2 = Math.max(x2, d.bounds.x + d.bounds.width);
    y2 = Math.max(y2, d.bounds.y + d.bounds.height);
  });
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
}

function getDisplayInfo() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const displays = all.map(function (d) {
    return {
      id: String(d.id),
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      scaleFactor: d.scaleFactor || 1,
      primary: primary && d.id === primary.id
    };
  });
  return { displays: displays, virtualBounds: unionBounds(all) };
}

function displayForPoint(displays, x, y) {
  for (let i = 0; i < displays.length; i++) {
    const b = displays[i].bounds;
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return displays[i];
  }
  return displays[0] || null;
}

// 依次尝试：display_id 精确匹配 -> 序号匹配
function screenForDisplay(sources, displays, display) {
  if (!display) return sources[0] || null;
  const byId = sources.find(function (s) { return s.displayId && s.displayId === display.id; });
  if (byId) return byId;
  const idx = displays.findIndex(function (d) { return d.id === display.id; });
  if (idx >= 0 && sources[idx]) return sources[idx];
  return sources[0] || null;
}

module.exports = { listSources, getDisplayInfo, displayForPoint, screenForDisplay, guessAppName };
