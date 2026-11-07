"use strict";
// 性能剖面：面向老设备/低配硬件的采集参数限制。
// 由主进程在每次开始录制前计算，随 capture:start payload 下发给隐藏采集窗口；
// 采集端只按上限执行（分辨率 / 帧率 / 码率 / 分片间隔 / WebM 编码器偏好）。
const os = require("node:os");

// 画质档位排序：性能模式只做「向下封顶」，不会把用户选的低画质调高
const QUALITY_RANK = { low: 1, medium: 2, standard: 2, high: 3, ultra: 4 };
const RANK_QUALITY = { 1: "low", 2: "standard", 3: "high", 4: "ultra" };

let hardwareCache = null;

function getHardware() {
  if (hardwareCache) return hardwareCache;
  let cores = 1;
  let memGB = 0;
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length) cores = cpus.length;
  } catch (e) {}
  try {
    memGB = Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;
  } catch (e) {}
  // 低配判定：4 线程及以下，或内存 8GB 及以下（老设备/入门本常见）
  let lowEnd = cores <= 4 || memGB <= 8;
  // 允许用环境变量强制开关（自动化测试、用户排障）
  if (process.env.NOVAREC_PERF_FORCE === "1") lowEnd = true;
  if (process.env.NOVAREC_PERF_FORCE === "0") lowEnd = false;
  hardwareCache = { cores: cores, memGB: memGB, lowEnd: lowEnd };
  return hardwareCache;
}

function normalizeMode(mode) {
  if (mode === "on" || mode === "off") return mode;
  return "auto";
}

// 返回当前应生效的性能剖面（enabled=false 时各上限为 0，采集端按原样执行）
function resolve(settings) {
  settings = settings || {};
  const hw = getHardware();
  const mode = normalizeMode(settings.performanceMode);
  const enabled = mode === "on" || (mode === "auto" && hw.lowEnd);
  const base = {
    mode: mode,
    enabled: enabled,
    lowEnd: hw.lowEnd,
    cores: hw.cores,
    memGB: hw.memGB
  };
  if (!enabled) {
    return Object.assign(base, {
      maxHeight: 0,
      maxWidth: 0,
      fpsCap: 60,
      qualityCap: null,
      bitrateCap: 0,
      audioBitrate: 128000,
      chunkMs: 1000,
      progressMs: 1000,
      preferVp8: false,
      label: "原生画质"
    });
  }
  // 流畅优先：720p 上限 / 30fps 上限 / 画质最高 standard / 码率封顶约 4.5Mbps /
  // 分片 2s（写盘与 IPC 次数减半）/ WebM 时优先 VP8（软件编码比 VP9 轻很多）
  const profile = Object.assign(base, {
    maxHeight: 720,
    maxWidth: 1280,
    fpsCap: 30,
    qualityCap: "standard",
    bitrateCap: 4500000,
    audioBitrate: 96000,
    chunkMs: 2000,
    progressMs: 2000,
    preferVp8: true,
    label: "720p · 30fps · 约 4.5 Mbps"
  });
  return profile;
}

function capFps(profile, fps) {
  const n = Math.round(Number(fps) || 30);
  const cap = (profile && profile.fpsCap) || 60;
  return Math.max(10, Math.min(cap, n));
}

function capQuality(profile, quality) {
  if (!profile || !profile.qualityCap) return quality;
  const rank = QUALITY_RANK[quality] || QUALITY_RANK.high;
  const capRank = QUALITY_RANK[profile.qualityCap] || 3;
  if (rank <= capRank) return quality;
  return RANK_QUALITY[capRank] || profile.qualityCap;
}

// 采集端 payload 片段（字段名与 capture.js 中的读取保持一致）
function toCaptureOptions(profile) {
  return {
    enabled: !!(profile && profile.enabled),
    maxHeight: (profile && profile.maxHeight) || 0,
    maxWidth: (profile && profile.maxWidth) || 0,
    bitrateCap: (profile && profile.bitrateCap) || 0,
    audioBitrate: (profile && profile.audioBitrate) || 128000,
    chunkMs: (profile && profile.chunkMs) || 1000,
    progressMs: (profile && profile.progressMs) || 1000,
    preferVp8: !!(profile && profile.preferVp8)
  };
}

module.exports = {
  getHardware: getHardware,
  resolve: resolve,
  capFps: capFps,
  capQuality: capQuality,
  toCaptureOptions: toCaptureOptions
};
