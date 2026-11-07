"use strict";
// 媒体收尾调度器：把 MediaRecorder 写出的「直播式」容器重封装成可直接播放/拖动进度的标准文件。
//
// 为什么需要它：MediaRecorder 写出的 MP4 是分片结构（mvhd duration=0、无 mfra），WebM 则没有
// Duration/Cues 且 Cluster 不一定从关键帧开始——播放器会显示 0:00、无法拖动、部分播放器直接报错。
// 老版本用内置 ffmpeg 子进程做 remux（多 3~4 次进程启动 + 61MB 安装体积）。现在改成纯 JS：
//   读文件头嗅探容器 → mp4remux（moov 前置 + 完整样本表）/ webmfix（重切关键帧簇 + Cues + Duration）
// 纯 JS 只搬字节、不转码，实测 8s 1080p 文件耗时几十毫秒，且内存占用恒定（1MB 拷贝缓冲）。

const fs = require("fs");
const mp4remux = require("./mp4remux");
const webmfix = require("./webmfix");

const FTYP = "ftyp";
const EBML_MAGIC = 0x1a45dfa3;

// 只读前 16 字节判断容器：MP4 的 ftyp 在偏移 4；WebM 开头 4 字节是 EBML magic。
function sniff(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    if (n >= 8 && head.toString("latin1", 4, 8) === FTYP) return "mp4";
    if (n >= 4 && head.readUInt32BE(0) === EBML_MAGIC) return "webm";
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

function removeQuietly(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
}

// 重封装一个录制临时文件。成功时 outPath 已写好；失败时不会留下半成品。
function finalize(opts) {
  const tempPath = opts && opts.tempPath;
  const outPath = opts && opts.outPath;
  if (!tempPath || !fs.existsSync(tempPath)) return { ok: false, error: "临时文件不存在" };
  if (!outPath) return { ok: false, error: "缺少输出路径" };
  const kind = (opts && opts.kind) || sniff(tempPath);
  if (kind !== "mp4" && kind !== "webm") return { ok: false, error: "无法识别的容器格式" };
  removeQuietly(outPath);
  const t0 = Date.now();
  try {
    const res = kind === "mp4" ? mp4remux.remux(tempPath, outPath) : webmfix.fix(tempPath, outPath);
    if (!res || res.ok === false) throw new Error((res && res.error) || "重封装失败");
    const size = fs.statSync(outPath).size;
    if (size < 512) throw new Error("重封装输出为空");
    return { ok: true, path: outPath, format: kind, mode: "remux", info: res.info || null, ms: Date.now() - t0 };
  } catch (e) {
    removeQuietly(outPath);
    return { ok: false, error: e.message, format: kind, ms: Date.now() - t0 };
  }
}

// 只探测（给自检/素材库用），不写文件。
function probe(filePath) {
  const kind = sniff(filePath);
  try {
    if (kind === "mp4") return { ok: true, format: "mp4", info: mp4remux.probeFile(filePath) };
    if (kind === "webm") return { ok: true, format: "webm", info: webmfix.probeFile(filePath) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: false, error: "无法识别的容器格式" };
}

module.exports = { sniff, finalize, probe };
