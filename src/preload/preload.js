"use strict";
// 主窗口 preload：把主进程能力以 window.novarec 暴露给渲染进程。
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb) {
  if (typeof cb !== "function") return function () {};
  const handler = function (event, payload) {
    try { cb(payload); } catch (e) { console.error("[novarec preload] listener error", e); }
  };
  ipcRenderer.on(channel, handler);
  return function () { try { ipcRenderer.removeListener(channel, handler); } catch (e) {} };
}

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

const api = {
  platform: process.platform,
  version: process.env.NOVAREC_VERSION || "",
  getSettings: function () { return invoke("settings:get"); },
  setSettings: function (patch) { return invoke("settings:set", patch); },
  onSettingsChanged: function (cb) { return subscribe("settings:changed", cb); },
  chooseOutputDir: function () { return invoke("settings:chooseDir"); },
  openOutputDir: function () { return invoke("settings:openDir"); },
  getAppInfo: function () { return invoke("app:info"); },
  getAudioDevices: function () { return invoke("audio:devices"); },

  // opts: { fast: true } 只取 id/name（不生成缩略图）；省略=带缩略图/图标的完整列表
  listSources: function (opts) { return invoke("sources:list", opts || undefined); },
  getDisplayInfo: function () { return invoke("display:info"); },
  selectRegion: function () { return invoke("region:select"); },

  prewarmCapture: function () { return invoke("capture:prewarm"); },
  startRecording: function (req) { return invoke("recording:start", req || {}); },
  stopRecording: function () { return invoke("recording:stop"); },
  togglePause: function () { return invoke("recording:togglePause"); },
  getRecordingState: function () { return invoke("recording:state"); },
  onRecordingState: function (cb) { return subscribe("recording:state", cb); },
  onRecordingSaved: function (cb) { return subscribe("recording:saved", cb); },
  onRecordingError: function (cb) { return subscribe("recording:error", cb); },
  onToast: function (cb) { return subscribe("toast", cb); },

  listRecordings: function () { return invoke("library:list"); },
  deleteRecording: function (id) { return invoke("library:delete", id); },
  revealRecording: function (id) { return invoke("library:reveal", id); },
  openRecording: function (id) { return invoke("library:open", id); },

  // 自动更新：检查 → 下载 → 安装；进度通过 update:progress 推送
  updates: {
    check: function () { return invoke("update:check"); },
    download: function () { return invoke("update:download"); },
    install: function () { return invoke("update:install"); },
    skip: function (version) { return invoke("update:skip", version); },
    openRelease: function (url) { return invoke("update:openRelease", url); },
    onProgress: function (cb) { return subscribe("update:progress", cb); },
    onAvailable: function (cb) { return subscribe("update:available", cb); },
    getCurrentVersion: function () { return invoke("update:currentVersion"); }
  },

  window: {
    minimize: function () { return invoke("win:minimize"); },
    toggleMaximize: function () { return invoke("win:toggleMaximize"); },
    close: function () { return invoke("win:close"); },
    isMaximized: function () { return invoke("win:isMaximized"); },
    onMaximizedChange: function (cb) { return subscribe("win:maximized", cb); }
  }
};

contextBridge.exposeInMainWorld("novarec", api);
// 更新能力同时挂一份到 window.nova.updates（契约见 docs/ipc-contract.md）
contextBridge.exposeInMainWorld("nova", { updates: api.updates });
