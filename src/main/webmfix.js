"use strict";
// 纯 JS 的 WebM 修复器（流式版）：把 MediaRecorder 生成的「直播式」WebM 重写成标准 WebM。
// 输入（实测 Chrome/Electron MediaRecorder）：EBML header + Segment(尺寸未知) + Info(无 Duration)
//        + 若干 Cluster(尺寸未知，按 1s 切，不保证从关键帧开始) + 无 Cues/SeekHead。
// 输出：EBML header + Segment(已知尺寸) + SeekHead + Info(含 Duration) + Tracks(原样)
//        + Cluster*(按视频关键帧重新切簇，尺寸已知) + Cues(每个关键帧簇一个 CuePoint)。
//
// 内存策略：只保存 Block 的元数据（轨道/时间/载荷文件偏移/长度/头字节），载荷在写出时
// 从输入文件按块拷贝，不把整段录像读进内存（1 小时录像内存占用仍只有几十 MB）。

const fs = require("fs");

/* ---------------- EBML 基础 ---------------- */
const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const SEEKHEAD_ID = 0x114d9b74;
const INFO_ID = 0x1549a966;
const TRACKS_ID = 0x1654ae6b;
const CLUSTER_ID = 0x1f43b675;
const CUES_ID = 0x1c53bb6b;
const TIMECODE_ID = 0xe7;
const SIMPLEBLOCK_ID = 0xa3;
const BLOCKGROUP_ID = 0xa0;
const BLOCK_ID = 0xa1;
const BLOCKDURATION_ID = 0x9b;
const TIMECODESCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const TRACKNUMBER_ID = 0xd7;
const TRACKTYPE_ID = 0x83;
const TRACKENTRY_ID = 0xae;
const VOID_ID = 0xec;
const POSITION_ID = 0xa7;
const PREVSIZE_ID = 0xab;
const SILENTTRACKS_ID = 0x5854;
const BIT_SEEKID = 0x53ab;
const BIT_SEEKPOS = 0x53ac;
const CUEPOINT_ID = 0xbb;
const CUETIME_ID = 0xb3;
const CUETRACKPOS_ID = 0xb7;
const CUETRACK_ID = 0xf7;
const CUECLUSTERPOS_ID = 0xf1;
const CLUSTER_CHILDREN = new Set([TIMECODE_ID, SIMPLEBLOCK_ID, BLOCKGROUP_ID, POSITION_ID, PREVSIZE_ID, VOID_ID, SILENTTRACKS_ID, 0xaf]);
const MAX_SMALL = 8 * 1024 * 1024;

function readVint(buf, off, isId) {
  const first = buf[off];
  if (first === undefined) throw new Error("webm: 越界读取 vint");
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || off + len > buf.length) throw new Error("webm: 非法 vint");
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + buf[off + i];
  let unknown = false;
  if (!isId) {
    unknown = (first & (mask - 1)) === (mask - 1);
    for (let i = 1; i < len; i++) if (buf[off + i] !== 0xff) unknown = false;
    value = first & (mask - 1);
    for (let i = 1; i < len; i++) value = value * 256 + buf[off + i];
  }
  return { value, length: len, unknown };
}
function parseHeaderAt(buf) {
  const id = readVint(buf, 0, true);
  const size = readVint(buf, id.length, false);
  return {
    id: id.value, idLen: id.length, size: size.value, sizeLen: size.length, unknown: size.unknown,
    bodyStart: id.length + size.length
  };
}
function encIdBytes(id) {
  const bytes = [];
  let n = id;
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from(bytes);
}
function encSize(n) {
  let len = 1;
  while (len < 8 && n >= Math.pow(2, 7 * len) - 1) len++;
  const out = Buffer.alloc(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  out[0] |= 1 << (8 - len);
  return out;
}
function sizeLenOf(n) { return encSize(n).length; }
function encUint(id, value) {
  const body = [];
  let v = value;
  do { body.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  const b = Buffer.from(body);
  return Buffer.concat([encIdBytes(id), encSize(b.length), b]);
}
function encFloat64(id, value) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(value, 0);
  return Buffer.concat([encIdBytes(id), encSize(8), b]);
}
function encBinary(id, bytes) { return Buffer.concat([encIdBytes(id), encSize(bytes.length), bytes]); }
function encMaster(id, parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([encIdBytes(id), encSize(body.length), body]);
}
function elemTotalSize(id, bodyLen) { return encIdBytes(id).length + encSize(bodyLen).length + bodyLen; }
function uintOfBytes(buf) {
  let v = 0;
  for (const x of buf) v = v * 256 + x;
  return v;
}

/* ---------------- 文件读取辅助 ---------------- */
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
function readSmallElement(fd, off, fileSize) {
  const head = readAt(fd, off, Math.min(16, fileSize - off));
  if (head.length < 2) return null;
  const h = parseHeaderAt(head);
  if (h.unknown) throw new Error("webm: 不支持未知尺寸的小元素 0x" + h.id.toString(16));
  const total = h.bodyStart + h.size;
  if (total > MAX_SMALL) throw new Error("webm: 元素过大 0x" + h.id.toString(16));
  return { header: h, buf: readAt(fd, off, total), start: off, end: off + total };
}

/* ---------------- 解析文档结构（不读媒体数据） ---------------- */
function parseDoc(fd, fileSize) {
  const ebml = readSmallElement(fd, 0, fileSize);
  if (!ebml || ebml.header.id !== EBML_ID) throw new Error("webm: 缺少 EBML header");
  const segHead = readAt(fd, ebml.end, Math.min(16, fileSize - ebml.end));
  const sh = parseHeaderAt(segHead);
  if (sh.id !== SEGMENT_ID) throw new Error("webm: 缺少 Segment");
  const seg = { id: sh.id, bodyStart: ebml.end + sh.bodyStart, size: sh.size, unknown: sh.unknown };
  const segEnd = seg.unknown ? fileSize : seg.bodyStart + seg.size;
  const elements = [];
  let off = seg.bodyStart;
  while (off + 2 <= segEnd) {
    const head = readAt(fd, off, Math.min(16, segEnd - off));
    if (head.length < 2) break;
    const h = parseHeaderAt(head);
    if (h.unknown) {
      if (h.id !== CLUSTER_ID) throw new Error("webm: 未知尺寸元素 0x" + h.id.toString(16));
      const end = scanUnknownCluster(fd, off + h.bodyStart, segEnd);
      elements.push({ id: h.id, start: off, bodyStart: off + h.bodyStart, end: end, unknownCluster: true });
      off = end;
      continue;
    }
    elements.push({ id: h.id, start: off, bodyStart: off + h.bodyStart, end: off + h.bodyStart + h.size });
    off += h.bodyStart + h.size;
  }
  return { ebml, seg, segEnd, elements };
}
function scanUnknownCluster(fd, start, limit) {
  let off = start;
  while (off + 2 <= limit) {
    const head = readAt(fd, off, Math.min(16, limit - off));
    if (head.length < 2) break;
    const h = parseHeaderAt(head);
    if (!CLUSTER_CHILDREN.has(h.id) || h.unknown) break;
    off += h.bodyStart + h.size;
  }
  return off;
}

/* ---------------- 解析 Tracks 轨道信息 ---------------- */
function parseTracks(fd, tracksEl, buf) {
  const trackNumbers = [];
  const trackTypes = {};
  let off = tracksEl.bodyStart;
  while (off < tracksEl.end) {
    const head = readAt(fd, off, Math.min(16, tracksEl.end - off));
    const h = parseHeaderAt(head);
    const total = h.bodyStart + h.size;
    if (off + total > tracksEl.end) break;
    if (h.id === TRACKENTRY_ID) {
      const entry = readAt(fd, off, total);
      let p = h.bodyStart, num = 0, type = 0;
      while (p < total) {
        const k = parseHeaderAt(entry.subarray(p));
        const kEnd = p + k.bodyStart + k.size;
        if (k.id === TRACKNUMBER_ID) num = uintOfBytes(entry.subarray(p + k.bodyStart, kEnd));
        if (k.id === TRACKTYPE_ID) type = uintOfBytes(entry.subarray(p + k.bodyStart, kEnd));
        p = kEnd;
      }
      if (num) { trackNumbers.push(num); trackTypes[num] = type; }
    }
    off += total;
  }
  return { trackNumbers, trackTypes };
}

/* ---------------- 抽取 Block 事件（只保存元数据） ---------------- */
function collectEvents(fd, elements) {
  const events = [];
  let sourceClusters = 0;
  elements.forEach(function (el) {
    if (el.id !== CLUSTER_ID) return;
    sourceClusters++;
    let off = el.bodyStart;
    let tc = 0;
    while (off + 2 <= el.end) {
      const head = readAt(fd, off, Math.min(16, el.end - off));
      if (head.length < 2) break;
      const h = parseHeaderAt(head);
      if (!CLUSTER_CHILDREN.has(h.id) || h.unknown) break;
      const bodyStart = off + h.bodyStart;
      const bodyEnd = bodyStart + h.size;
      if (h.id === TIMECODE_ID) {
        tc = uintOfBytes(readAt(fd, bodyStart, h.size));
      } else if (h.id === SIMPLEBLOCK_ID) {
        const prefix = readAt(fd, bodyStart, Math.min(h.size, 16));
        const tn = readVint(prefix, 0, false);
        const relOff = tn.length;
        const rel = prefix.readInt16BE(relOff);
        const flags = prefix[relOff + 2];
        const headLen = tn.length + 3;
        events.push({
          track: tn.value, time: tc + rel, keyframe: !!(flags & 0x80), simple: true,
          prefix: Buffer.from(prefix.subarray(0, headLen)),
          payloadStart: bodyStart + headLen, payloadLen: h.size - headLen
        });
      } else if (h.id === BLOCKGROUP_ID) {
        // BlockGroup：Block（大）+ 其他小元素（BlockDuration/ReferenceBlock 等）
        let p = bodyStart;
        let block = null;
        const extras = [];
        while (p + 2 <= bodyEnd) {
          const kh = readAt(fd, p, Math.min(16, bodyEnd - p));
          const k = parseHeaderAt(kh);
          const kTotal = k.bodyStart + k.size;
          if (p + kTotal > bodyEnd) break;
          if (k.id === BLOCK_ID) {
            const prefix = readAt(fd, p + k.bodyStart, Math.min(k.size, 16));
            const tn = readVint(prefix, 0, false);
            const relOff = tn.length;
            const rel = prefix.readInt16BE(relOff);
            const headLen = tn.length + 2;
            block = {
              track: tn.value, time: tc + rel, keyframe: false, simple: false,
              prefix: Buffer.from(prefix.subarray(0, headLen)),
              payloadStart: p + k.bodyStart + headLen, payloadLen: k.size - headLen
            };
          } else {
            extras.push(readAt(fd, p, kTotal));
          }
          p += kTotal;
        }
        if (block) { block.extras = extras; events.push(block); }
      }
      off = bodyEnd;
    }
  });
  return { events, sourceClusters };
}

/* ---------------- 主流程 ---------------- */
function fix(inputPath, outPath) {
  const fileSize = fs.statSync(inputPath).size;
  const fdIn = fs.openSync(inputPath, "r");
  try {
    const doc = parseDoc(fdIn, fileSize);
    const ebmlEl = doc.elements.length ? null : null;
    const infoEl = doc.elements.find(function (e) { return e.id === INFO_ID; });
    const tracksEl = doc.elements.find(function (e) { return e.id === TRACKS_ID; });
    const clusterCount = doc.elements.filter(function (e) { return e.id === CLUSTER_ID; }).length;
    if (!infoEl) throw new Error("webm: 缺少 Info");
    if (!tracksEl) throw new Error("webm: 缺少 Tracks");
    if (!clusterCount) throw new Error("webm: 缺少 Cluster");

    const infoBuf = readAt(fdIn, infoEl.start, infoEl.end - infoEl.start);
    const tracksBuf = readAt(fdIn, tracksEl.start, tracksEl.end - tracksEl.start);
    const timecodeScale = (function () {
      let p = parseHeaderAt(infoBuf).bodyStart;
      while (p < infoBuf.length) {
        const c = parseHeaderAt(infoBuf.subarray(p));
        const end = p + c.bodyStart + c.size;
        if (c.id === TIMECODESCALE_ID) return uintOfBytes(infoBuf.subarray(p + c.bodyStart, end));
        p = end;
      }
      return 1000000;
    })();
    const { trackNumbers, trackTypes } = parseTracks(fdIn, tracksEl);
    const videoTrack = trackNumbers.find(function (n) { return trackTypes[n] === 1; }) || 0;
    const { events, sourceClusters } = collectEvents(fdIn, doc.elements);
    if (!events.length) throw new Error("webm: 没有找到 Block");
    const DEFAULT_DELTA = timecodeScale === 1000000 ? 33 : 100;

    // 按视频关键帧重新切簇（与缓冲版同一算法）
    const rawClusters = [];
    let current = null;
    events.forEach(function (ev) {
      const isVideoKey = ev.keyframe && ev.track === videoTrack;
      if (!current || (isVideoKey && current.events.length > 0)) { current = { events: [] }; rawClusters.push(current); }
      current.events.push(ev);
    });
    const splitClusters = [];
    rawClusters.forEach(function (cl) {
      let group = [];
      let base = cl.events[0].time;
      cl.events.forEach(function (ev) {
        if (group.length && (ev.time - base) > 30000) { splitClusters.push({ events: group }); group = []; base = ev.time; }
        group.push(ev);
      });
      if (group.length) splitClusters.push({ events: group });
    });

    // 计算每个新簇的字节布局：Timecode + (元素头 + Block 头 + 载荷)
    const newClusters = splitClusters.map(function (cl) {
      const base = Math.floor(Math.min.apply(null, cl.events.map(function (e) { return e.time; })));
      const blocks = cl.events.map(function (ev) {
        const rel = ev.time - base;
        if (rel < -32768 || rel > 32767) throw new Error("webm: 相对时间戳溢出");
        const bodyHead = Buffer.from(ev.prefix);
        bodyHead.writeInt16BE(rel, bodyHead.length - (ev.simple ? 3 : 2));
        if (ev.simple) {
          const bodyLen = bodyHead.length + ev.payloadLen;
          return { head: Buffer.concat([encIdBytes(SIMPLEBLOCK_ID), encSize(bodyLen)]), bodyHead, payloadStart: ev.payloadStart, payloadLen: ev.payloadLen, extraLen: encIdBytes(SIMPLEBLOCK_ID).length + encSize(bodyLen).length };
        }
        const blockBodyLen = bodyHead.length + ev.payloadLen;
        const blockElHead = Buffer.concat([encIdBytes(BLOCK_ID), encSize(blockBodyLen)]);
        const extras = ev.extras || [];
        const extrasLen = extras.reduce(function (a, x) { return a + x.length; }, 0);
        const groupBodyLen = blockElHead.length + blockBodyLen + extrasLen;
        return { head: Buffer.concat([encIdBytes(BLOCKGROUP_ID), encSize(groupBodyLen), blockElHead]), bodyHead, payloadStart: ev.payloadStart, payloadLen: ev.payloadLen, extras: extras, extraLen: 0 };
      });
      const tcEl = encUint(TIMECODE_ID, base);
      const bodyLen = tcEl.length + blocks.reduce(function (a, b) { return a + b.head.length + b.bodyHead.length + b.payloadLen + (b.extras ? b.extras.reduce(function (x, y) { return x + y.length; }, 0) : 0); }, 0);
      const head = Buffer.concat([encIdBytes(CLUSTER_ID), encSize(bodyLen)]);
      return { head, tcEl, blocks, bodyLen, timecode: base };
    });

    // 时长
    const stats = {};
    events.forEach(function (ev) {
      const st = stats[ev.track] = stats[ev.track] || { min: Infinity, max: -Infinity, count: 0 };
      if (ev.time < st.min) st.min = ev.time;
      if (ev.time > st.max) st.max = ev.time;
      st.count++;
    });
    let durationTicks = 0;
    Object.keys(stats).forEach(function (k) {
      const st = stats[k];
      const delta = st.count > 1 ? (st.max - st.min) / (st.count - 1) : DEFAULT_DELTA;
      durationTicks = Math.max(durationTicks, st.max + delta);
    });
    durationTicks = Math.ceil(durationTicks);

    // Info：原有子元素（去 Duration）+ 新 Duration
    const infoHeader = parseHeaderAt(infoBuf);
    const infoParts = [];
    let p = infoHeader.bodyStart;
    while (p < infoBuf.length) {
      const c = parseHeaderAt(infoBuf.subarray(p));
      const end = p + c.bodyStart + c.size;
      if (c.id !== DURATION_ID) infoParts.push(Buffer.from(infoBuf.subarray(p, end)));
      p = end;
    }
    infoParts.push(encFloat64(DURATION_ID, durationTicks));
    const infoNew = encMaster(INFO_ID, infoParts);
    const tracksRaw = Buffer.from(tracksBuf);

    // SeekHead / Cues（位置相对 Segment 数据起点）
    const seekEntries = [{ id: INFO_ID, pos: 0 }, { id: TRACKS_ID, pos: 0 }, { id: CUES_ID, pos: 0 }];
    function buildSeekHead() {
      return encMaster(SEEKHEAD_ID, seekEntries.map(function (e) {
        return encMaster(0x4dbb, [encBinary(BIT_SEEKID, encIdBytes(e.id)), encUint(BIT_SEEKPOS, e.pos)]);
      }));
    }
    let seekHead = buildSeekHead();
    let clusterPositions = [];
    let cues = null;
    const cueTrack = videoTrack || trackNumbers[0] || 1;
    for (let pass = 0; pass < 2; pass++) {
      const infoPos = seekHead.length;
      const tracksPos = infoPos + infoNew.length;
      let cursor = tracksPos + tracksRaw.length;
      clusterPositions = newClusters.map(function (c) { cursor += c.head.length + c.bodyLen; return cursor - c.head.length - c.bodyLen; });
      const cuesPos = cursor;
      cues = encMaster(CUES_ID, newClusters.map(function (c, i) {
        return encMaster(CUEPOINT_ID, [
          encUint(CUETIME_ID, c.timecode),
          encMaster(CUETRACKPOS_ID, [encUint(CUETRACK_ID, cueTrack), encUint(CUECLUSTERPOS_ID, clusterPositions[i])])
        ]);
      }));
      seekEntries[0].pos = infoPos;
      seekEntries[1].pos = tracksPos;
      seekEntries[2].pos = cuesPos;
      seekHead = buildSeekHead();
    }
    const segBodyLen = seekHead.length + infoNew.length + tracksRaw.length + newClusters.reduce(function (a, c) { return a + c.head.length + c.bodyLen; }, 0) + cues.length;

    const fdOut = fs.openSync(outPath, "w");
    try {
      fs.writeSync(fdOut, readAt(fdIn, 0, doc.ebml.end));
      fs.writeSync(fdOut, Buffer.concat([encIdBytes(SEGMENT_ID), encSize(segBodyLen)]));
      fs.writeSync(fdOut, seekHead);
      fs.writeSync(fdOut, infoNew);
      fs.writeSync(fdOut, tracksRaw);
      const copyBuf = Buffer.allocUnsafe(1024 * 1024);
      newClusters.forEach(function (c) {
        fs.writeSync(fdOut, c.head);
        fs.writeSync(fdOut, c.tcEl);
        c.blocks.forEach(function (b) {
          fs.writeSync(fdOut, b.head);
          fs.writeSync(fdOut, b.bodyHead);
          let off = b.payloadStart;
          let left = b.payloadLen;
          while (left > 0) {
            const n = Math.min(copyBuf.length, left);
            let got = 0;
            while (got < n) {
              const r = fs.readSync(fdIn, copyBuf, got, n - got, off + got);
              if (!r) throw new Error("webm: 读取载荷失败");
              got += r;
            }
            let written = 0;
            while (written < got) written += fs.writeSync(fdOut, copyBuf, written, got - written);
            off += got;
            left -= got;
          }
          if (b.extras) b.extras.forEach(function (x) { fs.writeSync(fdOut, x); });
        });
      });
      fs.writeSync(fdOut, cues);
    } finally {
      fs.closeSync(fdOut);
    }
    return {
      ok: true,
      info: probeFile(outPath),
      source: { timecodeScale, events: events.length, sourceClusters, newClusters: newClusters.length, durationTicks }
    };
  } finally {
    fs.closeSync(fdIn);
  }
}

/* ---------------- 探测 ---------------- */
function probeFile(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const doc = parseDoc(fd, size);
    const infoEl = doc.elements.find(function (e) { return e.id === INFO_ID; });
    if (!infoEl) throw new Error("probe: 缺少 Info");
    const infoBuf = readAt(fd, infoEl.start, infoEl.end - infoEl.start);
    const h = parseHeaderAt(infoBuf);
    let p = h.bodyStart, durationTicks = 0, timecodeScale = 1000000;
    while (p < infoBuf.length) {
      const c = parseHeaderAt(infoBuf.subarray(p));
      const end = p + c.bodyStart + c.size;
      if (c.id === DURATION_ID) durationTicks = infoBuf.readDoubleBE(p + c.bodyStart);
      if (c.id === TIMECODESCALE_ID) timecodeScale = uintOfBytes(infoBuf.subarray(p + c.bodyStart, end));
      p = end;
    }
    const clusters = doc.elements.filter(function (e) { return e.id === CLUSTER_ID; }).length;
    const cues = doc.elements.filter(function (e) { return e.id === CUES_ID; }).length;
    const hasSeekHead = doc.elements.some(function (e) { return e.id === SEEKHEAD_ID; });
    return { ok: true, timecodeScale, durationMs: Math.round(durationTicks * timecodeScale / 1e6), clusters, cues, hasSeekHead, bytes: size };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { fix, probeFile };
