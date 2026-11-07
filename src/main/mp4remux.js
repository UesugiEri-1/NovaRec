"use strict";
// 纯 JS 的 fMP4(MediaRecorder 输出) → 标准 MP4 重封装器（流式版）。
// 目标：替代内置 ffmpeg 的 remux 步骤（体积 -61MB、收尾耗时从 1~3s 降到毫秒级），
// 产出带完整样本表/faststart/正确时长的标准 MP4，任何播放器与剪辑软件都能直接使用。
//
// 内存策略：只为「样本表 + 分片元数据」建对象（每小时约几十 MB），媒体数据用定长缓冲
// 从输入文件按块拷贝到输出文件，不把整段录像读进内存（长录制也不会 OOM）。
//
// 输入结构（Electron/Chromium MediaRecorder 实测）：
//   ftyp + moov(含 mvex/trex) + (moof + mdat)* [+ mfra]
// 输出结构：
//   ftyp + moov(完整 stbl 表，moov 在 mdat 前) + mdat

const fs = require("fs");

/* ---------------- 基础工具 ---------------- */
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n >>> 0, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n | 0, 0); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(n))), 0); return b; }
function fourcc(s) { return Buffer.from(s, "latin1"); }
function box(type, parts) {
  const body = parts ? Buffer.concat(parts) : Buffer.alloc(0);
  return Buffer.concat([u32(8 + body.length), fourcc(type), body]);
}
function fullBox(type, version, flags, parts) {
  const vf = Buffer.alloc(4);
  vf[0] = version & 0xff;
  vf[1] = (flags >> 16) & 0xff; vf[2] = (flags >> 8) & 0xff; vf[3] = flags & 0xff;
  return box(type, [vf].concat(parts || []));
}
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
const LANGUAGE_UND = 0x55c4;

function readBoxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    out.push({ type, start: off, size, header, bodyStart: off + header, end: off + size });
    off += size;
  }
  return out;
}
function findChild(buf, parent, type) {
  return readBoxes(buf, parent.bodyStart, parent.end).find(function (b) { return b.type === type; }) || null;
}
function readU32(buf, off) { return buf.readUInt32BE(off); }
function readI32(buf, off) { return buf.readInt32BE(off); }

// 定长读取（不足则返回实际读到的字节）
function readAt(fd, offset, len) {
  const b = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    let n = 0;
    try { n = fs.readSync(fd, b, got, len - got, offset + got); } catch (e) { break; }
    if (!n) break;
    got += n;
  }
  return got === len ? b : b.subarray(0, got);
}

/* ---------------- moov 解析 ---------------- */
function parseInit(moovBuf) {
  const moovBox = { bodyStart: 8, end: moovBuf.length };
  const init = { tracks: [], trex: {}, movieTimescale: 1000 };
  const mvhd = findChild(moovBuf, moovBox, "mvhd");
  if (mvhd) {
    const v = moovBuf[mvhd.bodyStart];
    init.movieTimescale = v === 1 ? readU32(moovBuf, mvhd.bodyStart + 20) : readU32(moovBuf, mvhd.bodyStart + 12);
  }
  readBoxes(moovBuf, moovBox.bodyStart, moovBox.end).forEach(function (b) {
    if (b.type === "trak") {
      const t = { trackId: 0, width: 0, height: 0, timescale: 0, duration: 0, language: LANGUAGE_UND, handler: "", stsd: null };
      const tkhd = findChild(moovBuf, b, "tkhd");
      if (tkhd) {
        const v = moovBuf[tkhd.bodyStart];
        t.trackId = readU32(moovBuf, tkhd.bodyStart + (v === 1 ? 20 : 12));
        t.width = readU32(moovBuf, tkhd.end - 8) / 65536;
        t.height = readU32(moovBuf, tkhd.end - 4) / 65536;
      }
      const mdia = findChild(moovBuf, b, "mdia");
      if (mdia) {
        const mdhd = findChild(moovBuf, mdia, "mdhd");
        if (mdhd) {
          const v = moovBuf[mdhd.bodyStart];
          t.timescale = readU32(moovBuf, mdhd.bodyStart + (v === 1 ? 20 : 12));
          t.duration = v === 1 ? Number(moovBuf.readBigUInt64BE(mdhd.bodyStart + 24)) : readU32(moovBuf, mdhd.bodyStart + 16);
          t.language = mdhd.end - 4 >= mdhd.bodyStart ? moovBuf.readUInt16BE(mdhd.end - 4) : LANGUAGE_UND;
        }
        const hdlr = findChild(moovBuf, mdia, "hdlr");
        if (hdlr) t.handler = moovBuf.toString("latin1", hdlr.bodyStart + 8, hdlr.bodyStart + 12).trim();
        const minf = findChild(moovBuf, mdia, "minf");
        if (minf) {
          const stbl = findChild(moovBuf, minf, "stbl");
          if (stbl) {
            const stsd = findChild(moovBuf, stbl, "stsd");
            if (stsd) t.stsd = Buffer.from(moovBuf.subarray(stsd.start, stsd.end));
          }
        }
      }
      init.tracks.push(t);
    }
    if (b.type === "mvex") {
      readBoxes(moovBuf, b.bodyStart, b.end).forEach(function (x) {
        if (x.type !== "trex") return;
        const trackId = readU32(moovBuf, x.bodyStart + 4);
        init.trex[trackId] = {
          descIndex: readU32(moovBuf, x.bodyStart + 8) || 1,
          duration: readU32(moovBuf, x.bodyStart + 12),
          size: readU32(moovBuf, x.bodyStart + 16),
          flags: readU32(moovBuf, x.bodyStart + 20)
        };
      });
    }
  });
  return init;
}

/* ---------------- 扫描顶层盒（只读盒子头，跳过 mdat 大块） ---------------- */
function scanTop(fd, fileSize) {
  const res = { moov: null, moofs: [] };
  let off = 0;
  while (off + 8 <= fileSize) {
    const head = readAt(fd, off, Math.min(16, fileSize - off));
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = fileSize - off;
    }
    if (size < header || off + size > fileSize) break;
    if (type === "moov") {
      res.moov = readAt(fd, off, size);
      res.moovStart = off;
    } else if (type === "moof") {
      res.moofs.push({ start: off, buf: readAt(fd, off, size) });
    }
    off += size;
  }
  return res;
}

/* ---------------- 从 moof 抽取样本元数据 ---------------- */
function extractFragments(moofs, init, fileSize) {
  const chunks = [];
  let lastDataEnd = 0;
  moofs.forEach(function (moofInfo) {
    const buf = moofInfo.buf;
    const moofStart = moofInfo.start;
    const moof = { bodyStart: 8, end: buf.length };
    const trafs = readBoxes(buf, moof.bodyStart, moof.end).filter(function (b) { return b.type === "traf"; });
    trafs.forEach(function (traf) {
      const tboxes = readBoxes(buf, traf.bodyStart, traf.end);
      const tfhd = tboxes.find(function (b) { return b.type === "tfhd"; });
      if (!tfhd) return;
      const tfFlags = readU32(buf, tfhd.bodyStart) & 0xffffff;
      let p = tfhd.bodyStart + 4;
      const trackId = readU32(buf, p); p += 4;
      let baseDataOffset = 0;
      if (tfFlags & 0x000001) { baseDataOffset = Number(buf.readBigUInt64BE(p)); p += 8; }
      let defDur = 0, defSize = 0, defFlags = 0;
      let defDurSet = false, defSizeSet = false, defFlagsSet = false;
      if (tfFlags & 0x000008) { defDur = readU32(buf, p); p += 4; defDurSet = true; }
      if (tfFlags & 0x000010) { p += 4; }
      if (tfFlags & 0x000020) { defFlags = readU32(buf, p); p += 4; defFlagsSet = true; }
      const trex = init.trex[trackId] || {};
      if (!defDurSet) defDur = trex.duration || 0;
      if (!defSizeSet) defSize = trex.size || 0;
      if (!defFlagsSet) defFlags = trex.flags || 0;
      const tfdt = tboxes.find(function (b) { return b.type === "tfdt"; });
      let dts = tfdt ? (buf[tfdt.bodyStart] === 1 ? Number(buf.readBigUInt64BE(tfdt.bodyStart + 4)) : readU32(buf, tfdt.bodyStart + 4)) : 0;
      const dataBase = (tfFlags & 0x000001) ? baseDataOffset : moofStart;
      let cursor = null;
      tboxes.filter(function (b) { return b.type === "trun"; }).forEach(function (trun) {
        const trFlags = readU32(buf, trun.bodyStart) & 0xffffff;
        const count = readU32(buf, trun.bodyStart + 4);
        let q = trun.bodyStart + 8;
        let dataOffset = null;
        if (trFlags & 0x000001) { dataOffset = readI32(buf, q); q += 4; }
        let firstFlags = null;
        if (trFlags & 0x000004) { firstFlags = readU32(buf, q); q += 4; }
        const hasDur = !!(trFlags & 0x000100);
        const hasSize = !!(trFlags & 0x000200);
        const hasFlags = !!(trFlags & 0x000400);
        const hasCts = !!(trFlags & 0x000800);
        const samples = [];
        let total = 0;
        for (let i = 0; i < count; i++) {
          let dur = defDur, size = defSize, sflags = defFlags, cts = 0;
          if (hasDur) { dur = readU32(buf, q); q += 4; }
          if (hasSize) { size = readU32(buf, q); q += 4; }
          if (hasFlags) { sflags = readU32(buf, q); q += 4; } else if (i === 0 && firstFlags !== null) { sflags = firstFlags; }
          if (hasCts) { cts = readI32(buf, q); q += 4; }
          if (!size) throw new Error("mp4 remux: sample size 0 (track " + trackId + ")");
          samples.push({ dts: dts, dur: dur, size: size, sync: !(sflags & 0x00010000), cts: cts });
          dts += dur;
          total += size;
        }
        const start = dataOffset === null ? (cursor === null ? dataBase : cursor) : dataBase + dataOffset;
        chunks.push({ trackId: trackId, samples: samples, dataStart: start, dataEnd: start + total });
        cursor = start + total;
        lastDataEnd = cursor;
      });
    });
  });
  chunks.sort(function (a, b) { return a.dataStart - b.dataStart; });
  chunks.forEach(function (c) {
    if (c.dataStart < 0 || c.dataEnd > fileSize) throw new Error("mp4 remux: sample data out of range (" + c.dataStart + "-" + c.dataEnd + " / " + fileSize + ")");
  });
  return chunks;
}

/* ---------------- 输出 stbl 表 ---------------- */
function makeStts(samples) {
  const runs = [];
  samples.forEach(function (s) {
    const last = runs[runs.length - 1];
    if (last && last.dur === s.dur) last.count++;
    else runs.push({ count: 1, dur: s.dur });
  });
  return fullBox("stts", 0, 0, [u32(runs.length), Buffer.concat(runs.map(function (r) { return Buffer.concat([u32(r.count), u32(r.dur)]); }))]);
}
function makeCtts(samples) {
  if (!samples.some(function (s) { return s.cts !== 0; })) return null;
  const neg = samples.some(function (s) { return s.cts < 0; });
  const runs = [];
  samples.forEach(function (s) {
    const last = runs[runs.length - 1];
    if (last && last.cts === s.cts) last.count++;
    else runs.push({ count: 1, cts: s.cts });
  });
  return fullBox("ctts", neg ? 1 : 0, 0, [u32(runs.length), Buffer.concat(runs.map(function (r) {
    return Buffer.concat([u32(r.count), neg ? i32(r.cts) : u32(r.cts)]);
  }))]);
}
function makeStss(samples) {
  if (samples.every(function (s) { return s.sync; })) return null;
  const list = [];
  samples.forEach(function (s, i) { if (s.sync) list.push(i + 1); });
  if (!list.length) list.push(1);
  return fullBox("stss", 0, 0, [u32(list.length), Buffer.concat(list.map(u32))]);
}
function makeStsz(samples) {
  return fullBox("stsz", 0, 0, [u32(0), u32(samples.length), Buffer.concat(samples.map(function (s) { return u32(s.size); }))]);
}
function makeStsc(chunkSizes) {
  const entries = [];
  chunkSizes.forEach(function (n) {
    const last = entries[entries.length - 1];
    if (last && last.count === n) last.runLen++;
    else entries.push({ count: n, runLen: 1 });
  });
  const parts = [];
  let first = 1;
  entries.forEach(function (e) {
    parts.push(Buffer.concat([u32(first), u32(e.count), u32(1)]));
    first += e.runLen;
  });
  return fullBox("stsc", 0, 0, [u32(entries.length), Buffer.concat(parts)]);
}
function makeTrak(track, chunkSizes, offsets, movieTimescale) {
  const samples = track.samples;
  const mdhdDur = samples.reduce(function (a, s) { return a + s.dur; }, 0);
  const tkhdDur = Math.round(mdhdDur / track.timescale * movieTimescale);
  return box("trak", [
    fullBox("tkhd", 1, 7, [
      u64(0), u64(0), u32(track.trackId), u32(0), u64(tkhdDur),
      u32(0), u32(0), u16(0), u16(0),
      u16(track.handler === "soun" ? 0x0100 : 0), u16(0),
      MATRIX,
      u32(Math.round(track.width * 65536)), u32(Math.round(track.height * 65536))
    ]),
    box("mdia", [
      fullBox("mdhd", 1, 0, [u64(0), u64(0), u32(track.timescale), u64(mdhdDur), u16(track.language), u16(0)]),
      fullBox("hdlr", 0, 0, [u32(0), fourcc(track.handler === "soun" ? "soun" : "vide"), u32(0), u32(0), u32(0), Buffer.from(track.handler === "soun" ? "SoundHandler\0" : "VideoHandler\0", "latin1")]),
      box("minf", [
        track.handler === "soun"
          ? fullBox("smhd", 0, 0, [i32(0)])
          : fullBox("vmhd", 0, 1, [u16(0), u16(0), u16(0), u16(0)]),
        box("dinf", [fullBox("dref", 0, 0, [u32(1), fullBox("url ", 0, 1, [])])]),
        box("stbl", [
          track.stsd || box("stsd", [u32(0)]),
          makeStts(samples),
          makeCtts(samples) || Buffer.alloc(0),
          makeStss(samples) || Buffer.alloc(0),
          makeStsc(chunkSizes),
          makeStsz(samples),
          fullBox("stco", 0, 0, [u32(offsets.length), Buffer.concat(offsets.map(u32))])
        ])
      ])
    ])
  ]);
}
function buildMoov(tracks, movieTimescale, oss) {
  const movieDur = Math.max.apply(null, tracks.map(function (t) {
    return Math.round(t.samples.reduce(function (a, s) { return a + s.dur; }, 0) / t.timescale * movieTimescale);
  }));
  const traks = tracks.map(function (t) {
    return makeTrak(t, t.chunkSizes, oss[t.trackId] || [], movieTimescale);
  });
  return box("moov", [
    fullBox("mvhd", 1, 0, [
      u64(0), u64(0), u32(movieTimescale), u64(movieDur),
      i32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(tracks.length + 1)
    ]),
    Buffer.concat(traks)
  ]);
}

/* ---------------- 流式复制媒体数据 ---------------- */
const COPY_BUF = 1024 * 1024;
function copyRange(fdIn, fdOut, start, end, buf) {
  let off = start;
  while (off < end) {
    const n = Math.min(COPY_BUF, end - off);
    let got = 0;
    while (got < n) {
      let r = 0;
      try { r = fs.readSync(fdIn, buf, got, n - got, off + got); } catch (e) { throw new Error("读取录像数据失败：" + e.message); }
      if (!r) throw new Error("读取录像数据失败：文件提前结束");
      got += r;
    }
    let written = 0;
    while (written < got) {
      written += fs.writeSync(fdOut, buf, written, got - written);
    }
    off += got;
  }
}

/* ---------------- 对外 API ---------------- */
function remux(inputPath, outPath) {
  const fileSize = fs.statSync(inputPath).size;
  const fdIn = fs.openSync(inputPath, "r");
  try {
    const top = scanTop(fdIn, fileSize);
    if (!top.moov) throw new Error("mp4 remux: 缺少 moov");
    if (!top.moofs.length) return { ok: false, reason: "not_fragmented" };
    const init = parseInit(top.moov);
    const chunks = extractFragments(top.moofs, init, fileSize);
    const used = new Set();
    chunks.forEach(function (c) { used.add(c.trackId); });
    const tracks = init.tracks.filter(function (t) { return used.has(t.trackId); });
    if (!tracks.length) throw new Error("mp4 remux: 未找到轨道");
    // 每轨的 chunk 列表与样本序列
    tracks.forEach(function (t) {
      t.chunkSizes = [];
      t.samples = [];
      chunks.forEach(function (c) {
        if (c.trackId !== t.trackId) return;
        t.chunkSizes.push(c.samples.length);
        c.samples.forEach(function (s) { t.samples.push(s); });
      });
    });
    const totalData = chunks.reduce(function (a, c) { return a + (c.dataEnd - c.dataStart); }, 0);
    const ftyp = box("ftyp", [fourcc("isom"), u32(512), fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41")]);
    // 两遍：先求 moov 尺寸（stco 用等长占位值），再算真实 stco 偏移
    const zeroOffsets = {};
    tracks.forEach(function (t) { zeroOffsets[t.trackId] = new Array(t.chunkSizes.length).fill(0); });
    let moov = buildMoov(tracks, init.movieTimescale || 1000, zeroOffsets);
    const base = ftyp.length + moov.length + 8;
    const offsets = {};
    let cursor = base;
    chunks.forEach(function (c) {
      (offsets[c.trackId] = offsets[c.trackId] || []).push(cursor);
      cursor += c.dataEnd - c.dataStart;
    });
    moov = buildMoov(tracks, init.movieTimescale || 1000, offsets);

    const fdOut = fs.openSync(outPath, "w");
    try {
      fs.writeSync(fdOut, ftyp);
      fs.writeSync(fdOut, moov);
      const mdatHeader = Buffer.alloc(8);
      mdatHeader.writeUInt32BE(8 + totalData, 0);
      mdatHeader.write("mdat", 4, "latin1");
      fs.writeSync(fdOut, mdatHeader);
      const copyBuf = Buffer.allocUnsafe(COPY_BUF);
      chunks.forEach(function (c) {
        copyRange(fdIn, fdOut, c.dataStart, c.dataEnd, copyBuf);
      });
    } finally {
      fs.closeSync(fdOut);
    }
    return {
      ok: true,
      info: probeFile(outPath),
      source: { chunks: chunks.length, samples: tracks.reduce(function (a, t) { return a + t.samples.length; }, 0), bytes: base + totalData }
    };
  } finally {
    fs.closeSync(fdIn);
  }
}

/* ---------------- 探测（只读文件头，不读媒体数据） ---------------- */
function probeFile(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const top = scanTop(fd, size);
    if (!top.moov) throw new Error("probe: 缺少 moov");
    return probeMoovBuffer(top.moov);
  } finally {
    fs.closeSync(fd);
  }
}

function probeMoovBuffer(moovBuf) {
  const moovBox = { bodyStart: 8, end: moovBuf.length };
  const mvhd = findChild(moovBuf, moovBox, "mvhd");
  let movieTs = 1000, movieDur = 0;
  if (mvhd) {
    const v = moovBuf[mvhd.bodyStart];
    movieTs = readU32(moovBuf, mvhd.bodyStart + (v === 1 ? 20 : 12));
    movieDur = v === 1 ? Number(moovBuf.readBigUInt64BE(mvhd.bodyStart + 24)) : readU32(moovBuf, mvhd.bodyStart + 16);
  }
  const tracks = [];
  readBoxes(moovBuf, moovBox.bodyStart, moovBox.end).forEach(function (b) {
    if (b.type !== "trak") return;
    const tkhd = findChild(moovBuf, b, "tkhd");
    const mdia = findChild(moovBuf, b, "mdia");
    const mdhd = mdia ? findChild(moovBuf, mdia, "mdhd") : null;
    const hdlr = mdia ? findChild(moovBuf, mdia, "hdlr") : null;
    const minf = mdia ? findChild(moovBuf, mdia, "minf") : null;
    const stbl = minf ? findChild(moovBuf, minf, "stbl") : null;
    const info = {
      trackId: tkhd ? readU32(moovBuf, tkhd.bodyStart + (moovBuf[tkhd.bodyStart] === 1 ? 20 : 12)) : 0,
      width: tkhd ? readU32(moovBuf, tkhd.end - 8) / 65536 : 0,
      height: tkhd ? readU32(moovBuf, tkhd.end - 4) / 65536 : 0,
      handler: hdlr ? moovBuf.toString("latin1", hdlr.bodyStart + 8, hdlr.bodyStart + 12).trim() : "",
      timescale: mdhd ? readU32(moovBuf, mdhd.bodyStart + (moovBuf[mdhd.bodyStart] === 1 ? 20 : 12)) : 0,
      duration: mdhd ? (moovBuf[mdhd.bodyStart] === 1 ? Number(moovBuf.readBigUInt64BE(mdhd.bodyStart + 24)) : readU32(moovBuf, mdhd.bodyStart + 16)) : 0,
      sampleCount: 0, chunkCount: 0
    };
    if (stbl) {
      const stsz = findChild(moovBuf, stbl, "stsz");
      const stco = findChild(moovBuf, stbl, "stco");
      if (stsz) info.sampleCount = readU32(moovBuf, stsz.bodyStart + 8);
      if (stco) info.chunkCount = readU32(moovBuf, stco.bodyStart + 4);
    }
    tracks.push(info);
  });
  return { movieTimescale: movieTs, durationMs: Math.round(movieDur / movieTs * 1000), tracks: tracks };
}

module.exports = { remux, probeFile, probeMoovBuffer };
