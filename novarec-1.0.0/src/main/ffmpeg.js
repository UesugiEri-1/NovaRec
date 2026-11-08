"use strict";
// ffmpeg 封装：转封装 / 兜底转码 / 生成封面。
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

let cachedPath = null;
function ffmpegPath() {
  if (cachedPath) return cachedPath;
  const candidates = [];
  if (process.env.NOVAREC_FFMPEG) candidates.push(process.env.NOVAREC_FFMPEG);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "ffmpeg.exe"));
  try {
    const installer = require("@ffmpeg-installer/ffmpeg");
    if (installer && installer.path) candidates.push(String(installer.path).replace("app.asar", "app.asar.unpacked"));
  } catch (e) {}
  candidates.push("ffmpeg.exe");
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === "ffmpeg.exe" || fs.existsSync(c)) { cachedPath = c; return c; }
  }
  cachedPath = "ffmpeg.exe";
  return cachedPath;
}

function run(args, timeoutMs) {
  return new Promise(function (resolve) {
    const child = execFile(ffmpegPath(), args, {
      windowsHide: true,
      timeout: timeoutMs || 300000,
      maxBuffer: 32 * 1024 * 1024
    }, function (err, stdout, stderr) {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
        stdout: stdout || "",
        stderr: stderr || ""
      });
    });
    // 收尾处理在后台线程之外还会抢 CPU：把 ffmpeg 进程降到「低于正常」优先级，老设备上界面不卡
    try {
      if (child && child.pid && os.setPriority) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (e) {}
  });
}

async function isAvailable() {
  try {
    const r = await run(["-hide_banner", "-version"], 15000);
    return r.ok;
  } catch (e) { return false; }
}

// 只做「解复用 + 容器完整性」校验（-c copy 不真正解码每一帧）。
// 原来全解码校验在 4 核老机器上收尾要几十秒，改成 demux 校验后接近 0，且仍能发现损坏的头部/分片。
async function validate(file) {
  const r = await run(["-hide_banner", "-v", "error", "-i", file, "-c", "copy", "-f", "null", "-"], 60000);
  return r.ok;
}

// 修复 Chromium MediaRecorder 生成的 fragmented mp4 的一个已知瑕疵：
// 结尾 fragment 里可能出现 sample_count=0 的 trun（空音轨分片），旧版 ffmpeg 会直接报
// "error reading header / Operation not permitted"。这里把这些空 traf 从 moof 中剥掉。
// 关键点：不能直接删掉这些 traf，否则 moof 变短、后面 mdat 的相对位置改变，
// 原有 trun 的 data_offset 会错位导致解码花屏；这里用同尺寸的 free box 原地占位，
// moof 总长度不变，所有偏移保持有效。
function sanitizeMp4(buffer) {
  try {
    const out = [];
    let changed = false;
    let off = 0;
    while (off + 8 <= buffer.length) {
      let size = buffer.readUInt32BE(off);
      const type = buffer.toString("latin1", off + 4, off + 8);
      if (size === 1) {
        if (off + 16 > buffer.length) return null;
        size = Number(buffer.readBigUInt64BE(off + 8));
      }
      if (!size || size < 8 || off + size > buffer.length) return null;
      if (type === "moof") {
        const moof = Buffer.from(buffer.subarray(off, off + size));
        let p = 8;
        while (p + 8 <= moof.length) {
          const childSize = moof.readUInt32BE(p);
          if (!childSize || p + childSize > moof.length) return null;
          const childType = moof.toString("latin1", p + 4, p + 8);
          if (childType === "traf") {
            let q = p + 8;
            let sawTrun = false;
            let emptyTrun = false;
            while (q + 8 <= p + childSize) {
              const s2 = moof.readUInt32BE(q);
              if (!s2 || q + s2 > p + childSize) return null;
              const t2 = moof.toString("latin1", q + 4, q + 8);
              if (t2 === "trun") {
                sawTrun = true;
                if (q + 16 <= p + childSize && moof.readUInt32BE(q + 12) === 0) emptyTrun = true;
              }
              q += s2;
            }
            if (sawTrun && emptyTrun) {
              moof.writeUInt32BE(childSize, p);
              moof.write("free", p + 4, "latin1");
              moof.fill(0, p + 8, p + childSize);
              changed = true;
            }
          }
          p += childSize;
        }
        out.push(moof);
      } else {
        out.push(Buffer.from(buffer.subarray(off, off + size)));
      }
      off += size;
    }
    if (!changed) return null;
    return out.length ? Buffer.concat(out) : null;
  } catch (e) { return null; }
}

// 返回修复后的新文件路径；不需要/失败返回 null
function repairFragmented(file) {
  try {
    const buf = fs.readFileSync(file);
    const fixed = sanitizeMp4(buf);
    if (!fixed || fixed.length === 0) return null;
    const out = file + ".fix" + path.extname(file);
    fs.writeFileSync(out, fixed);
    return out;
  } catch (e) { return null; }
}

// 把 MediaRecorder 输出的临时文件加工为最终文件；返回 {ok, outPath, mode, transcoded, error}
async function finalize(opts) {
  const tempPath = opts.tempPath;
  const format = opts.format === "webm" ? "webm" : "mp4";
  const outPath = opts.outPath;
  const tempExt = path.extname(tempPath).toLowerCase().replace(".", "");
  const tmpOut = outPath + ".tmp." + format;
  let srcPath = tempPath;
  let repaired = false;
  try { fs.unlinkSync(tmpOut); } catch (e) {}

  async function remux(src) {
    try { fs.unlinkSync(tmpOut); } catch (e) {}
    const args = ["-hide_banner", "-y", "-i", src, "-c", "copy", "-max_muxing_queue_size", "4096"];
    if (format === "mp4") args.push("-movflags", "+faststart");
    args.push(tmpOut);
    const r = await run(args, 180000);
    return r.ok && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 1024;
  }

  async function transcode(src) {
    try { fs.unlinkSync(tmpOut); } catch (e) {}
    const args = ["-hide_banner", "-y", "-i", src, "-max_muxing_queue_size", "4096"];
    if (format === "mp4") {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart");
    } else {
      args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k");
    }
    args.push(tmpOut);
    const r = await run(args, 1800000);
    return r.ok && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 1024;
  }

  let mode = "remux";
  let ok = false;
  if (tempExt === format) {
    ok = await remux(srcPath);
    if (!ok && format === "mp4") {
      const fixed = repairFragmented(tempPath);
      if (fixed) {
        repaired = true;
        srcPath = fixed;
        ok = await remux(srcPath);
      }
    }
    if (ok) ok = await validate(tmpOut);
  }
  if (!ok) {
    mode = "transcode";
    ok = await transcode(srcPath);
    if (!ok && srcPath !== tempPath) {
      srcPath = tempPath;
      ok = await transcode(srcPath);
    }
    if (ok) ok = await validate(tmpOut);
  }
  if (!ok) {
    try { fs.unlinkSync(tmpOut); } catch (e) {}
    return { ok: false, error: "视频处理失败（ffmpeg " + mode + "）", transcoded: mode === "transcode" };
  }
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
  fs.renameSync(tmpOut, outPath);
  return { ok: true, outPath: outPath, mode: mode, transcoded: mode === "transcode", repaired: repaired };
}

// 生成封面 jpg（width 480），失败返回 null
async function makePoster(videoPath, posterPath) {
  try { fs.unlinkSync(posterPath); } catch (e) {}
  const attempts = ["0.2", "0"];
  for (let i = 0; i < attempts.length; i++) {
    const r = await run(["-hide_banner", "-y", "-ss", attempts[i], "-i", videoPath, "-frames:v", "1", "-vf", "scale=400:-2", "-q:v", "6", posterPath], 60000);
    if (r.ok && fs.existsSync(posterPath) && fs.statSync(posterPath).size > 512) return posterPath;
  }
  return null;
}

function inspect(file) {
  return run(["-hide_banner", "-i", file], 60000);
}

module.exports = { ffmpegPath, run, isAvailable, validate, finalize, makePoster, inspect, sanitizeMp4, repairFragmented };
