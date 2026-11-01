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

  listSources: function () { return invoke("sources:list"); },
  getDisplayInfo: function () { return invoke("display:info"); },
  selectRegion: function () { return invoke("region:select"); },

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

  window: {
    minimize: function () { return invoke("win:minimize"); },
    toggleMaximize: function () { return invoke("win:toggleMaximize"); },
    close: function () { return invoke("win:close"); },
    isMaximized: function () { return invoke("win:isMaximized"); },
    onMaximizedChange: function (cb) { return subscribe("win:maximized", cb); }
  }
};

contextBridge.exposeInMainWorld("novarec", api);
