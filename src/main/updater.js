"use strict";
// NovaRec 自动更新（主进程）
// ---------------------------------------------------------------------------
// 检查顺序（每个渠道 8s 超时，失败自动降级到下一个）：
//   1. GitHub Release API 直连
//   2. GitHub Release API（gh-proxy 镜像）
//   3. 仓库 version.json（raw.githubusercontent.com 直连）
//   4. version.json（gh-proxy 镜像）
//   5. version.json（jsDelivr CDN）
// 下载：优先 release assets 中 NovaRec-Setup-*-x64.exe，github.com 直连失败
// 自动改写为 gh-proxy 镜像重试；只允许 https + 白名单 host；写到 userData/updates/。
// 设计说明：
//   - 只用 Node 内置能力（fetch / fs / path），不引入任何第三方依赖；
//   - electron 相关 API 全部由 init() 注入（或调用时才 require），因此
//     scripts/test-updater.mjs 可以纯 Node 加载本模块做单元测试；
//   - fetch 与下载目录都可注入，单测不需要真实联网、也不写用户目录。
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const REPO = "UesugiEri-1/NovaRec";
const GH_PROXY_PREFIX = "https://gh-proxy.com/";
const CHECK_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const AUTO_CHECK_DELAY_MS = 10000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 安装包资产名（不区分大小写）：NovaRec-Setup-1.2.0-x64.exe
const SETUP_ASSET_PATTERN = /NovaRec-Setup-.*x64\.exe$/i;

// 允许下载的 host（含 GitHub Release 资产 CDN 与镜像站）
const ALLOWED_DOWNLOAD_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "gh-proxy.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net"
];

// 检查更新渠道（顺序即优先级）
const CHECK_CHANNELS = [
  {
    id: "github-api",
    kind: "release",
    url: "https://api.github.com/repos/" + REPO + "/releases/latest"
  },
  {
    id: "gh-proxy-api",
    kind: "release",
    url: GH_PROXY_PREFIX + "https://api.github.com/repos/" + REPO + "/releases/latest"
  },
  {
    id: "version-json",
    kind: "version-json",
    url: "https://raw.githubusercontent.com/" + REPO + "/main/version.json"
  },
  {
    id: "gh-proxy-json",
    kind: "version-json",
    url: GH_PROXY_PREFIX + "https://raw.githubusercontent.com/" + REPO + "/main/version.json"
  },
  {
    id: "jsdelivr-json",
    kind: "version-json",
    url: "https://cdn.jsdelivr.net/gh/" + REPO + "@main/version.json"
  }
];

const IPC = {
  check: "update:check",
  download: "update:download",
  install: "update:install",
  skip: "update:skip",
  openRelease: "update:openRelease",
  currentVersion: "update:currentVersion",
  progress: "update:progress",
  available: "update:available"
};

function log(logger, message) {
  if (typeof logger === "function") {
    try { logger("[updater] " + message); return; } catch (e) { /* 忽略日志失败 */ }
  }
  try { console.log("[updater] " + message); } catch (e) {}
}

function errorMessage(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  return String(err.message || err);
}

/* =========================================================================
   语义化版本
   ========================================================================= */

// 解析 x.y.z（可带前导 v、可带 -beta.1 预发布标识、+build 元数据忽略）。
// 解析失败返回 null；宽松兼容 "1.2" / "1" 这类写法。
function parseVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim().replace(/^[vV]/, "");
  if (!raw) return null;
  const strict = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (strict) {
    return [Number(strict[1]), Number(strict[2]), Number(strict[3]), strict[4] || ""];
  }
  const loose = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
  if (!loose) return null;
  return [Number(loose[1]) || 0, Number(loose[2]) || 0, Number(loose[3]) || 0, ""];
}

// 去掉前导 v，统一成 1.2.3 形式；无法识别时返回空串
function cleanVersion(value) {
  const parsed = parseVersion(value);
  if (!parsed) return "";
  return parsed[0] + "." + parsed[1] + "." + parsed[2] + (parsed[3] ? "-" + parsed[3] : "");
}

function comparePrerelease(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
      continue;
    }
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// 返回 -1 / 0 / 1（a 小于 / 等于 / 大于 b）；无法解析的值按 0.0.0 处理
function compareVersions(a, b) {
  const va = parseVersion(a) || [0, 0, 0, ""];
  const vb = parseVersion(b) || [0, 0, 0, ""];
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  const preA = va[3];
  const preB = vb[3];
  if (!preA && !preB) return 0;
  // 正式版高于同号预发布版（1.0.0 > 1.0.0-beta）
  if (!preA) return 1;
  if (!preB) return -1;
  return comparePrerelease(preA, preB);
}

// latest 是否比 current 更新（只有更高才提示更新）
function isNewerVersion(latest, current) {
  return compareVersions(latest, current) > 0;
}

/* =========================================================================
   响应解析 / 资产选择
   ========================================================================= */

function normalizeAssets(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const url = typeof item.browser_download_url === "string"
      ? item.browser_download_url.trim()
      : (typeof item.url === "string" ? item.url.trim() : "");
    if (!url) continue;
    out.push({
      name: typeof item.name === "string" ? item.name.trim() : "",
      url: url,
      size: Number(item.size) || 0
    });
  }
  return out;
}

// 解析 GitHub Release API 返回（tag_name / body / html_url / assets）
function normalizeReleaseJson(json) {
  if (!json || typeof json !== "object") return null;
  const version = cleanVersion(json.tag_name || json.version || json.name || "");
  if (!version) return null;
  return {
    version: version,
    notes: typeof json.body === "string" ? json.body : (typeof json.notes === "string" ? json.notes : ""),
    releaseUrl: typeof json.html_url === "string" ? json.html_url : "",
    assets: normalizeAssets(json.assets),
    source: "release"
  };
}

// 解析仓库 version.json：{ version, notes, url, assets:[{name,browser_download_url}] }
function normalizeVersionJson(json) {
  if (!json || typeof json !== "object") return null;
  const version = cleanVersion(json.version || json.tag_name || "");
  if (!version) return null;
  const releaseUrl = typeof json.url === "string" ? json.url.trim() : "";
  let assets = normalizeAssets(json.assets);
  // version.json 里 url 也可能是安装包直链，此时补成一个资产项
  if (!assets.length && /\.exe(?:\?|$)/i.test(releaseUrl)) {
    assets = [{ name: fileNameFromUrl(releaseUrl), url: releaseUrl, size: 0 }];
  }
  return {
    version: version,
    notes: typeof json.notes === "string" ? json.notes : "",
    releaseUrl: releaseUrl,
    assets: assets,
    source: "version-json"
  };
}

function fileNameFromUrl(raw) {
  try {
    const pathname = new URL(String(raw)).pathname;
    const name = pathname.split("/").pop() || "";
    return decodeURIComponent(name);
  } catch (e) {
    return "";
  }
}

// 选择安装包：优先 NovaRec-Setup-*-x64.exe，其次任意 .exe 资产
function selectAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const exact = [];
  const fallback = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item.url !== "string" || !item.url) continue;
    const name = String(item.name || "");
    if (SETUP_ASSET_PATTERN.test(name)) exact.push(item);
    else if (/\.exe$/i.test(name) || /\.exe(?:\?|$)/i.test(item.url)) fallback.push(item);
  }
  if (exact.length) return exact[0];
  if (fallback.length) return fallback[0];
  return null;
}

/* =========================================================================
   URL 白名单 / 镜像改写
   ========================================================================= */

function isAllowedDownloadUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch (err) {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_DOWNLOAD_HOSTS.indexOf(host) >= 0;
}

// github.com 直链 → gh-proxy 镜像；其他 host 返回空串
function mirrorGithubUrl(raw) {
  const value = String(raw || "");
  if (!/^https:\/\/github\.com\//i.test(value)) return "";
  return GH_PROXY_PREFIX + value;
}

// 下载候选地址：直连优先，失败再用镜像（仅在白名单内）
function buildDownloadUrls(raw) {
  const urls = [];
  if (!isAllowedDownloadUrl(raw)) return urls;
  urls.push(raw);
  const mirror = mirrorGithubUrl(raw);
  if (mirror && isAllowedDownloadUrl(mirror)) urls.push(mirror);
  return urls;
}

function sanitizeFileName(name) {
  const base = String(name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return base || "NovaRec-Setup-x64.exe";
}

/* =========================================================================
   网络请求（可注入 fetch，带超时）
   ========================================================================= */

function fetchWithTimeout(fetchImpl, url, timeoutMs, init) {
  const options = Object.assign({}, init || {});
  let controller = null;
  if (typeof AbortController === "function") {
    controller = new AbortController();
    options.signal = controller.signal;
  }
  let timer = null;
  const timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      try { if (controller) controller.abort(); } catch (e) {}
      reject(new Error("请求超时（" + Math.round(timeoutMs / 1000) + "s）"));
    }, timeoutMs);
  });
  const request = Promise.resolve().then(function () { return fetchImpl(url, options); });
  return Promise.race([request, timeout]).then(function (res) {
    clearTimeout(timer);
    return res;
  }, function (err) {
    clearTimeout(timer);
    throw err;
  });
}

function isHttpError(res) {
  if (!res || typeof res !== "object") return true;
  const status = Number(res.status) || 0;
  if (res.ok === false) return true;
  if (status && (status < 200 || status >= 300)) return true;
  return false;
}

async function requestJson(fetchImpl, url, timeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, url, timeoutMs, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "NovaRec-Updater"
    }
  });
  if (isHttpError(res)) {
    const status = Number(res && res.status) || 0;
    const err = new Error("HTTP " + (status || "错误"));
    err.status = status;
    throw err;
  }
  let text = "";
  if (typeof res.text === "function") {
    text = await res.text();
  } else if (typeof res.json === "function") {
    return await res.json();
  } else {
    throw new Error("响应内容无法读取");
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error("返回内容不是合法 JSON");
  }
}

/* =========================================================================
   检查更新
   ========================================================================= */

function checkFailure(currentVersion, errors) {
  const list = Array.isArray(errors) ? errors : [];
  const allNotFound = list.length > 0 && list.every(function (e) { return e.status === 404; });
  const hasHttp = list.some(function (e) { return e.status > 0; });
  let message;
  if (allNotFound) {
    message = "未找到发布版本信息：GitHub 仓库还没有 Release，也没有 version.json";
  } else if (hasHttp) {
    message = "检查更新失败：更新服务器返回异常（已尝试 GitHub 直连、镜像与备用源）";
  } else {
    message = "检查更新失败：无法连接更新服务器，请检查网络后重试";
  }
  return {
    ok: false,
    currentVersion: currentVersion,
    latestVersion: "",
    hasUpdate: false,
    notes: "",
    releaseUrl: "",
    asset: null,
    channel: "",
    checkedAt: Date.now(),
    error: message,
    errorDetails: list
  };
}

function resolveFetchImpl(opts) {
  if (opts && typeof opts.fetchImpl === "function") return opts.fetchImpl;
  if (opts && opts.fetchImpl === null) return null; // 显式传 null：禁用网络（单测/离线场景）
  return typeof fetch === "function" ? fetch : null;
}

// 依次尝试各渠道，返回统一结果；不会 reject（失败时 ok:false + error）
async function checkForUpdates(options) {
  const opts = options || {};
  const fetchImpl = resolveFetchImpl(opts);
  const currentVersion = cleanVersion(opts.currentVersion || "0.0.0") || "0.0.0";
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : CHECK_TIMEOUT_MS;
  if (typeof fetchImpl !== "function") {
    return Object.assign(checkFailure(currentVersion, []), { error: "当前运行环境不支持网络请求（缺少 fetch）" });
  }

  const channels = Array.isArray(opts.channels) && opts.channels.length ? opts.channels : CHECK_CHANNELS;
  const errors = [];

  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    try {
      const json = await requestJson(fetchImpl, channel.url, timeoutMs);
      const info = channel.kind === "release" ? normalizeReleaseJson(json) : normalizeVersionJson(json);
      if (!info) throw new Error("版本信息格式不正确");
      const hasUpdate = isNewerVersion(info.version, currentVersion);
      log(opts.logger, "检查成功 channel=" + channel.id + " current=" + currentVersion + " latest=" + info.version + " hasUpdate=" + hasUpdate);
      return {
        ok: true,
        currentVersion: currentVersion,
        latestVersion: info.version,
        hasUpdate: hasUpdate,
        notes: info.notes || "",
        releaseUrl: info.releaseUrl || "",
        asset: selectAsset(info.assets),
        assets: info.assets || [],
        channel: channel.id,
        checkedAt: Date.now(),
        error: ""
      };
    } catch (err) {
      const status = Number(err && err.status) || 0;
      errors.push({ channel: channel.id, message: errorMessage(err), status: status });
      log(opts.logger, "检查渠道失败 " + channel.id + ": " + errorMessage(err));
    }
  }

  const failure = checkFailure(currentVersion, errors);
  log(opts.logger, "所有更新渠道均失败：" + failure.error);
  return failure;
}

/* =========================================================================
   下载安装包
   ========================================================================= */

function reportProgress(onProgress, received, expected) {
  if (typeof onProgress !== "function") return;
  let percent;
  if (expected > 0) percent = Math.max(0, Math.min(100, Math.round((received / expected) * 100)));
  else percent = received > 0 ? 1 : 0;
  try { onProgress(percent); } catch (e) { /* 忽略回调异常 */ }
}

async function writeBodyToFile(res, tmpPath, expectedSize, onProgress) {
  if (!res.body) throw new Error("响应内容为空");
  await fs.promises.mkdir(path.dirname(tmpPath), { recursive: true });
  const handle = await fs.promises.open(tmpPath, "w");
  let received = 0;
  let lastPercent = -1;
  const tick = function () {
    const percent = expectedSize > 0 ? Math.max(0, Math.min(100, Math.round((received / expectedSize) * 100))) : 0;
    if (percent !== lastPercent) {
      lastPercent = percent;
      reportProgress(onProgress, received, expectedSize);
    }
  };
  try {
    const body = res.body;
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (!chunk || chunk.done) break;
        if (chunk.value) {
          const buf = Buffer.isBuffer(chunk.value) ? chunk.value : Buffer.from(chunk.value);
          await handle.write(buf);
          received += buf.length;
          tick();
        }
      }
    } else if (typeof body[Symbol.asyncIterator] === "function") {
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await handle.write(buf);
        received += buf.length;
        tick();
      }
    } else if (typeof res.arrayBuffer === "function") {
      const buf = Buffer.from(await res.arrayBuffer());
      await handle.write(buf);
      received += buf.length;
      tick();
    } else {
      throw new Error("响应内容无法读取");
    }
  } finally {
    try { await handle.close(); } catch (e) {}
  }
  if (received <= 0) throw new Error("下载内容为空");
  if (expectedSize > 0 && received !== expectedSize) {
    throw new Error("下载不完整（" + received + " / " + expectedSize + " 字节）");
  }
  reportProgress(onProgress, received, expectedSize || received);
  return received;
}

function headerValue(res, name) {
  const headers = res && res.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") {
    try { return String(headers.get(name) || ""); } catch (e) { return ""; }
  }
  const lower = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) return String(headers[keys[i]] || "");
  }
  return "";
}

async function downloadOne(fetchImpl, url, filePath, options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DOWNLOAD_TIMEOUT_MS;
  const tmpPath = filePath + ".part";
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, url, timeoutMs, {
      headers: { "User-Agent": "NovaRec-Updater", "Accept": "application/octet-stream, */*" }
    });
  } catch (err) {
    throw new Error(errorMessage(err));
  }
  if (isHttpError(res)) {
    const status = Number(res && res.status) || 0;
    const err = new Error("HTTP " + (status || "错误"));
    err.status = status;
    throw err;
  }
  const contentType = headerValue(res, "content-type");
  if (/text\/html/i.test(contentType)) throw new Error("服务器返回的不是安装包（HTML 页面）");
  const contentLength = Number(headerValue(res, "content-length")) || 0;
  const assetSize = Number(opts.asset && opts.asset.size) || 0;
  const expected = contentLength || assetSize;
  let received;
  try {
    received = await writeBodyToFile(res, tmpPath, expected, opts.onProgress);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch (e) {}
    throw err;
  }
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch (e) {}
    throw new Error("保存安装包失败：" + errorMessage(err));
  }
  return { ok: true, filePath: filePath, size: received, url: url };
}

// 下载更新安装包；返回 { ok:true, filePath, size } 或 { ok:false, error }
async function downloadUpdate(options) {
  const opts = options || {};
  const fetchImpl = resolveFetchImpl(opts);
  const asset = opts.asset || null;
  const updatesDir = opts.updatesDir;
  if (typeof fetchImpl !== "function") return { ok: false, error: "当前运行环境不支持网络请求（缺少 fetch）" };
  if (!asset || !asset.url) return { ok: false, error: "未找到可下载的安装包，请到发布页手动下载" };
  if (!updatesDir) return { ok: false, error: "缺少下载目录配置" };

  const candidates = buildDownloadUrls(asset.url);
  if (!candidates.length) return { ok: false, error: "安装包下载地址不在可信白名单内，已阻止下载" };

  const fileName = sanitizeFileName(asset.name || fileNameFromUrl(asset.url));
  if (!/\.exe$/i.test(fileName)) return { ok: false, error: "安装包文件名必须以 .exe 结尾" };
  const filePath = path.join(updatesDir, fileName);

  const errors = [];
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    try {
      log(opts.logger, "开始下载 " + url);
      return await downloadOne(fetchImpl, url, filePath, {
        asset: asset,
        onProgress: opts.onProgress,
        timeoutMs: opts.timeoutMs,
        logger: opts.logger
      });
    } catch (err) {
      errors.push(errorMessage(err));
      log(opts.logger, "下载失败 " + url + "：" + errorMessage(err));
    }
  }
  const detail = errors.length ? "（" + errors[errors.length - 1] + "）" : "";
  return { ok: false, error: "下载安装包失败" + detail + "，请检查网络或到发布页手动下载" };
}

/* =========================================================================
   安装（shell.openPath + 退出）
   ========================================================================= */

function isExePath(filePath) {
  return typeof filePath === "string" && /\.exe$/i.test(filePath);
}

// 用户确认后打开安装包并退出应用；依赖注入的 electron API，便于主进程复用
async function installDownloaded(options) {
  const opts = options || {};
  const filePath = opts.filePath;
  if (!isExePath(filePath)) return { ok: false, canceled: false, error: "安装包路径无效" };
  if (!fs.existsSync(filePath)) return { ok: false, canceled: false, error: "安装包不存在，请重新下载" };

  const dialog = opts.dialog;
  const shell = opts.shell;
  const app = opts.app;
  if (!dialog || !shell || !app) return { ok: false, canceled: false, error: "主进程未就绪，无法安装更新" };

  let response = 0;
  try {
    const result = await dialog.showMessageBox(opts.window || null, {
      type: "question",
      buttons: ["立即安装并退出", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "安装更新",
      message: "安装包已下载完成",
      detail: "点击「立即安装并退出」后 NovaRec 会关闭并启动安装程序，安装完成后可重新打开。"
    });
    response = result && typeof result.response === "number" ? result.response : 1;
  } catch (err) {
    return { ok: false, canceled: false, error: "无法显示安装确认框：" + errorMessage(err) };
  }
  if (response !== 0) return { ok: false, canceled: true, error: "" };

  try {
    const openError = await shell.openPath(filePath);
    if (openError) return { ok: false, canceled: false, error: "无法启动安装程序：" + openError };
  } catch (err) {
    return { ok: false, canceled: false, error: "无法启动安装程序：" + errorMessage(err) };
  }
  log(opts.logger, "已启动安装程序，应用即将退出");
  setTimeout(function () {
    try { app.quit(); } catch (e) {}
  }, 400);
  return { ok: true, canceled: false, error: "" };
}

/* =========================================================================
   主进程集成（IPC + 启动后静默检查 + 设置持久化）
   ========================================================================= */

const OPEN_RELEASE_HOSTS = [
  "github.com",
  "gh-proxy.com",
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "api.github.com"
];

function isAllowedReleaseUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch (e) { return false; }
  if (url.protocol !== "https:") return false;
  return OPEN_RELEASE_HOSTS.indexOf(url.hostname.toLowerCase()) >= 0;
}

function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

function writeJsonSafe(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

var singleton = null;

// 初始化更新模块。依赖全部从主进程传入（app / ipcMain / shell / dialog / 设置读写 / 广播）。
function init(options) {
  if (singleton) return singleton;
  const opts = options || {};
  const electron = opts.app ? null : require("electron");
  const app = opts.app || electron.app;
  const ipcMain = opts.ipcMain || electron.ipcMain;
  const shell = opts.shell || electron.shell;
  const dialog = opts.dialog || electron.dialog;
  const logger = typeof opts.log === "function" ? opts.log : function (msg) { log(null, msg); };
  const broadcast = typeof opts.broadcast === "function" ? opts.broadcast : function () {};
  const getSettings = typeof opts.getSettings === "function" ? opts.getSettings : function () { return {}; };
  const saveSettings = typeof opts.saveSettings === "function" ? opts.saveSettings : function () { return {}; };
  const userDataPath = opts.userDataPath || (app && typeof app.getPath === "function" ? app.getPath("userData") : process.cwd());
  const updatesDir = path.join(userDataPath, "updates");
  const stateFile = path.join(updatesDir, "state.json");
  const fetchImpl = typeof opts.fetch === "function" ? opts.fetch : (typeof fetch === "function" ? fetch : null);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : CHECK_TIMEOUT_MS;

  const memory = {
    checking: false,
    downloading: false,
    lastResult: null,
    downloadedPath: "",
    installed: false
  };

  function currentVersion() {
    try { return app.getVersion(); } catch (e) { return "0.0.0"; }
  }

  function readState() {
    return readJsonSafe(stateFile);
  }

  function writeState(patch) {
    const next = Object.assign({}, readState(), patch || {});
    writeJsonSafe(stateFile, next);
    return next;
  }

  async function doCheck(options2) {
    const manual = !options2 || options2.manual !== false;
    const settings = getSettings() || {};
    const result = await checkForUpdates({
      fetchImpl: fetchImpl,
      currentVersion: currentVersion(),
      timeoutMs: timeoutMs,
      logger: logger
    });
    if (result.ok) {
      memory.lastResult = result;
      writeState({ lastCheckAt: result.checkedAt, latestVersion: result.latestVersion });
      if (result.hasUpdate && settings.skippedVersion === result.latestVersion) result.skipped = true;
      if (!manual && result.hasUpdate && !result.skipped && result.latestVersion) {
        broadcast(IPC.available, {
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          notes: result.notes,
          releaseUrl: result.releaseUrl
        });
      }
    }
    log(logger, "检查更新完成 manual=" + manual + " ok=" + result.ok + " latest=" + (result.latestVersion || "-") + (result.error ? " error=" + result.error : ""));
    return result;
  }

  async function doDownload() {
    if (memory.downloading) return { ok: false, error: "正在下载中，请稍候" };
    const result = memory.lastResult;
    if (!result || !result.ok) return { ok: false, error: "请先检查更新" };
    if (!result.hasUpdate) return { ok: false, error: "当前已是最新版本" };
    if (!result.asset) return { ok: false, error: "未找到可下载的安装包，请到发布页手动下载" };
    memory.downloading = true;
    try {
      const downloaded = await downloadUpdate({
        fetchImpl: fetchImpl,
        asset: result.asset,
        updatesDir: updatesDir,
        timeoutMs: Number(opts.downloadTimeoutMs) > 0 ? Number(opts.downloadTimeoutMs) : DOWNLOAD_TIMEOUT_MS,
        logger: logger,
        onProgress: function (percent) {
          broadcast(IPC.progress, { percent: percent });
        }
      });
      if (downloaded.ok) {
        memory.downloadedPath = downloaded.filePath;
        writeState({ downloadedPath: downloaded.filePath, downloadedVersion: result.latestVersion });
        broadcast(IPC.progress, { percent: 100 });
      }
      return downloaded;
    } finally {
      memory.downloading = false;
    }
  }

  async function doInstall() {
    const result = memory.lastResult;
    if (!memory.downloadedPath) return { ok: false, canceled: false, error: "请先下载安装包" };
    const installed = await installDownloaded({
      filePath: memory.downloadedPath,
      app: app,
      shell: shell,
      dialog: dialog,
      window: opts.getMainWindow ? opts.getMainWindow() : null,
      logger: logger
    });
    if (installed.ok) memory.installed = true;
    return installed;
  }

  function doSkip(version) {
    const value = typeof version === "string" && cleanVersion(version) ? cleanVersion(version) : "";
    saveSettings({ skippedVersion: value });
    log(logger, "跳过版本：" + (value || "（已清除）"));
    return { ok: true, skippedVersion: value };
  }

  function openRelease(url) {
    const target = typeof url === "string" && url ? url : (memory.lastResult && memory.lastResult.releaseUrl) || "https://github.com/" + REPO + "/releases";
    if (!isAllowedReleaseUrl(target)) return { ok: false, error: "发布页地址不在白名单内" };
    try {
      shell.openExternal(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "无法打开浏览器：" + errorMessage(err) };
    }
  }

  function registerIpc() {
    if (!ipcMain || typeof ipcMain.handle !== "function") return;
    try { ipcMain.handle(IPC.currentVersion, function () { return currentVersion(); }); } catch (e) {}
    try { ipcMain.handle(IPC.check, function () { return doCheck({ manual: true }); }); } catch (e) {}
    try { ipcMain.handle(IPC.download, function () { return doDownload(); }); } catch (e) {}
    try { ipcMain.handle(IPC.install, function () { return doInstall(); }); } catch (e) {}
    try { ipcMain.handle(IPC.skip, function (event, version) { return doSkip(version); }); } catch (e) {}
    try { ipcMain.handle(IPC.openRelease, function (event, url) { return openRelease(url); }); } catch (e) {}
  }

  function scheduleAutoCheck() {
    const timer = setTimeout(function () {
      runAutoCheck().catch(function (err) {
        log(logger, "自动检查更新异常：" + errorMessage(err));
      });
    }, Number(opts.autoCheckDelayMs) > 0 ? Number(opts.autoCheckDelayMs) : AUTO_CHECK_DELAY_MS);
    // 主进程长期驻留（托盘常驻），定时器不需要 unref
    void timer;
  }

  async function runAutoCheck() {
    const settings = getSettings() || {};
    if (settings.autoCheckUpdates === false) {
      log(logger, "自动检查更新已关闭");
      return;
    }
    const state = readState();
    const last = Number(state.lastCheckAt) || 0;
    const interval = Number(opts.autoCheckIntervalMs) > 0 ? Number(opts.autoCheckIntervalMs) : AUTO_CHECK_INTERVAL_MS;
    if (last && Date.now() - last < interval) {
      log(logger, "距上次检查不足 24 小时，跳过自动检查");
      return;
    }
    log(logger, "启动后自动检查更新");
    // 无论成功失败都记录本次尝试时间，避免用户频繁重启时反复请求更新服务器（失败细节仍写 dev.log）
    writeState({ lastCheckAt: Date.now() });
    try {
      await doCheck({ manual: false });
    } catch (err) {
      log(logger, "自动检查更新失败：" + errorMessage(err));
    }
  }

  registerIpc();
  scheduleAutoCheck();
  log(logger, "更新模块已初始化 userData=" + userDataPath);

  singleton = {
    currentVersion: currentVersion,
    check: function () { return doCheck({ manual: true }); },
    download: doDownload,
    install: doInstall,
    skip: doSkip,
    openRelease: openRelease,
    getState: function () { return Object.assign({}, memory); },
    channels: CHECK_CHANNELS
  };
  return singleton;
}

module.exports = {
  // 常量
  REPO: REPO,
  GH_PROXY_PREFIX: GH_PROXY_PREFIX,
  CHECK_TIMEOUT_MS: CHECK_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS: DOWNLOAD_TIMEOUT_MS,
  AUTO_CHECK_DELAY_MS: AUTO_CHECK_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS: AUTO_CHECK_INTERVAL_MS,
  CHECK_CHANNELS: CHECK_CHANNELS,
  ALLOWED_DOWNLOAD_HOSTS: ALLOWED_DOWNLOAD_HOSTS,
  SETUP_ASSET_PATTERN: SETUP_ASSET_PATTERN,
  IPC: IPC,

  // 纯函数
  parseVersion: parseVersion,
  cleanVersion: cleanVersion,
  compareVersions: compareVersions,
  isNewerVersion: isNewerVersion,
  normalizeReleaseJson: normalizeReleaseJson,
  normalizeVersionJson: normalizeVersionJson,
  normalizeAssets: normalizeAssets,
  selectAsset: selectAsset,
  isAllowedDownloadUrl: isAllowedDownloadUrl,
  mirrorGithubUrl: mirrorGithubUrl,
  buildDownloadUrls: buildDownloadUrls,
  sanitizeFileName: sanitizeFileName,
  isAllowedReleaseUrl: isAllowedReleaseUrl,
  fileNameFromUrl: fileNameFromUrl,

  // 网络操作（fetch 可注入）
  checkForUpdates: checkForUpdates,
  downloadUpdate: downloadUpdate,
  installDownloaded: installDownloaded,

  // 主进程入口
  init: init
};
