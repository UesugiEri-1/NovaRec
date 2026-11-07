// NovaRec 自动更新模块单元测试（纯 Node，无第三方依赖）
// 运行：node scripts/test-updater.mjs
// 覆盖：语义化版本比较、渠道降级顺序与解析、version.json 解析、资产选择、
//       URL 白名单与镜像改写、下载校验（大小/扩展名/content-type）、安装确认流程。
// 所有网络都用注入的 fetch 模拟，不真实联网；下载写到系统临时目录，跑完清理。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const updater = require("../src/main/updater.js");

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "novarec-updater-test-"));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function fileResponse(buffer, headers = {}) {
  return new Response(buffer, {
    status: 200,
    headers: Object.assign({ "content-type": "application/octet-stream" }, headers)
  });
}

function notFound() {
  return jsonResponse({ message: "Not Found" }, 404);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* =========================================================================
   1. 模块加载 / 导出
   ========================================================================= */

test("模块可被纯 Node 加载（不 require electron），并导出核心 API", () => {
  assert.equal(typeof updater.init, "function");
  assert.equal(typeof updater.checkForUpdates, "function");
  assert.equal(typeof updater.downloadUpdate, "function");
  assert.equal(typeof updater.installDownloaded, "function");
  assert.ok(Array.isArray(updater.CHECK_CHANNELS));
  assert.equal(updater.CHECK_CHANNELS.length, 5);
  // 5 个渠道顺序必须与需求一致
  assert.deepEqual(updater.CHECK_CHANNELS.map((c) => c.id), [
    "github-api",
    "gh-proxy-api",
    "version-json",
    "gh-proxy-json",
    "jsdelivr-json"
  ]);
  assert.equal(
    updater.CHECK_CHANNELS[0].url,
    "https://api.github.com/repos/UesugiEri-1/NovaRec/releases/latest"
  );
  assert.equal(
    updater.CHECK_CHANNELS[1].url,
    "https://gh-proxy.com/https://api.github.com/repos/UesugiEri-1/NovaRec/releases/latest"
  );
  assert.equal(
    updater.CHECK_CHANNELS[2].url,
    "https://raw.githubusercontent.com/UesugiEri-1/NovaRec/main/version.json"
  );
  assert.equal(
    updater.CHECK_CHANNELS[3].url,
    "https://gh-proxy.com/https://raw.githubusercontent.com/UesugiEri-1/NovaRec/main/version.json"
  );
  assert.equal(
    updater.CHECK_CHANNELS[4].url,
    "https://cdn.jsdelivr.net/gh/UesugiEri-1/NovaRec@main/version.json"
  );
});

/* =========================================================================
   2. 语义化版本
   ========================================================================= */

test("parseVersion 解析 x.y.z、前导 v、预发布与 build 元数据", () => {
  assert.deepEqual(updater.parseVersion("1.2.3"), [1, 2, 3, ""]);
  assert.deepEqual(updater.parseVersion("v1.2.3"), [1, 2, 3, ""]);
  assert.deepEqual(updater.parseVersion("V2.0.10"), [2, 0, 10, ""]);
  assert.deepEqual(updater.parseVersion("1.2.3-beta.1"), [1, 2, 3, "beta.1"]);
  assert.deepEqual(updater.parseVersion("1.2.3+build.7"), [1, 2, 3, ""]);
  assert.deepEqual(updater.parseVersion("1.0"), [1, 0, 0, ""]);
  assert.equal(updater.parseVersion("abc"), null);
  assert.equal(updater.parseVersion(""), null);
  assert.equal(updater.parseVersion(null), null);
});

test("cleanVersion 统一成 x.y.z", () => {
  assert.equal(updater.cleanVersion("v1.2.3"), "1.2.3");
  assert.equal(updater.cleanVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(updater.cleanVersion("1.2"), "1.2.0");
  assert.equal(updater.cleanVersion("bad"), "");
});

test("compareVersions 比较主次补丁号", () => {
  assert.equal(updater.compareVersions("1.1.0", "1.1.0"), 0);
  assert.equal(updater.compareVersions("v1.1.0", "1.1.0"), 0);
  assert.equal(updater.compareVersions("1.2.0", "1.1.0"), 1);
  assert.equal(updater.compareVersions("1.0.9", "1.1.0"), -1);
  assert.equal(updater.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(updater.compareVersions("2.0.0", "10.0.0"), -1);
});

test("compareVersions 处理预发布版（正式版 > 同号 beta）", () => {
  assert.equal(updater.compareVersions("1.1.0", "1.1.0-beta.1"), 1);
  assert.equal(updater.compareVersions("1.1.0-beta.1", "1.1.0"), -1);
  assert.equal(updater.compareVersions("1.1.0-beta.2", "1.1.0-beta.1"), 1);
  assert.equal(updater.compareVersions("1.1.0-alpha", "1.1.0-beta"), -1);
  assert.equal(updater.compareVersions("1.1.0-beta", "1.1.0-beta"), 0);
});

test("isNewerVersion 只有更高版本才提示更新", () => {
  assert.equal(updater.isNewerVersion("1.2.0", "1.1.0"), true);
  assert.equal(updater.isNewerVersion("1.1.0", "1.1.0"), false);
  assert.equal(updater.isNewerVersion("1.0.0", "1.1.0"), false);
  assert.equal(updater.isNewerVersion("1.1.0-beta", "1.1.0"), false);
  assert.equal(updater.isNewerVersion("v1.1.1", "1.1.0"), true);
});

/* =========================================================================
   3. 渠道降级顺序
   ========================================================================= */

test("渠道按顺序降级：前 4 个失败后命中第 5 个 version.json", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.indexOf("jsdelivr") >= 0) {
      return jsonResponse({ version: "1.2.0", notes: "修复若干问题", url: "https://github.com/UesugiEri-1/NovaRec/releases/tag/v1.2.0" });
    }
    return notFound();
  };
  const result = await updater.checkForUpdates({ fetchImpl, currentVersion: "1.1.0", timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.channel, "jsdelivr-json");
  assert.equal(result.currentVersion, "1.1.0");
  assert.equal(result.latestVersion, "1.2.0");
  assert.equal(result.hasUpdate, true);
  assert.equal(result.notes, "修复若干问题");
  assert.equal(result.releaseUrl, "https://github.com/UesugiEri-1/NovaRec/releases/tag/v1.2.0");
  assert.equal(result.error, "");
  assert.deepEqual(calls, updater.CHECK_CHANNELS.map((c) => c.url));
});

test("第二个渠道（gh-proxy 镜像）成功时不再请求后续渠道", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === updater.CHECK_CHANNELS[1].url) {
      return jsonResponse({
        tag_name: "v1.3.0",
        body: "新增功能",
        html_url: "https://github.com/UesugiEri-1/NovaRec/releases/tag/v1.3.0",
        assets: [
          { name: "NovaRec-Setup-1.3.0-x64.exe", browser_download_url: "https://github.com/UesugiEri-1/NovaRec/releases/download/v1.3.0/NovaRec-Setup-1.3.0-x64.exe", size: 12345 }
        ]
      });
    }
    return notFound();
  };
  const result = await updater.checkForUpdates({ fetchImpl, currentVersion: "1.1.0", timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.channel, "gh-proxy-api");
  assert.equal(result.latestVersion, "1.3.0");
  assert.equal(result.hasUpdate, true);
  assert.equal(result.asset.name, "NovaRec-Setup-1.3.0-x64.exe");
  assert.equal(calls.length, 2);
});

test("单渠道超时后自动切下一个渠道", async () => {
  const fetchImpl = async (url) => {
    if (url === updater.CHECK_CHANNELS[0].url) {
      return new Promise(() => {}); // 永不返回，模拟网络挂起
    }
    return jsonResponse({ version: "1.2.0" });
  };
  const started = Date.now();
  const result = await updater.checkForUpdates({ fetchImpl, currentVersion: "1.1.0", timeoutMs: 30 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.equal(result.channel, "gh-proxy-api");
  assert.ok(elapsed < 2000, "超时降级耗时应远小于默认 8s，实际 " + elapsed + "ms");
});

test("所有渠道 404 时给出「还没有 Release / version.json」的中文提示", async () => {
  const result = await updater.checkForUpdates({
    fetchImpl: async () => notFound(),
    currentVersion: "1.1.0",
    timeoutMs: 200
  });
  assert.equal(result.ok, false);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latestVersion, "");
  assert.match(result.error, /Release/);
  assert.match(result.error, /version\.json/);
  assert.equal(result.errorDetails.length, 5);
  assert.ok(result.errorDetails.every((item) => item.status === 404));
});

test("网络错误（非 HTTP 状态）给出网络检查提示", async () => {
  const result = await updater.checkForUpdates({
    fetchImpl: async () => { throw new Error("fetch failed"); },
    currentVersion: "1.1.0",
    timeoutMs: 200
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /网络/);
  assert.equal(result.errorDetails.length, 5);
});

test("checkForUpdates 不会 reject（缺少 fetch 也返回结构化错误）", async () => {
  const result = await updater.checkForUpdates({ fetchImpl: null, currentVersion: "1.1.0" });
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch/);
});

test("Release 解析：tag_name/body/html_url 与安装包资产", async () => {
  const fetchImpl = async () => jsonResponse({
    tag_name: "v2.0.0",
    body: "更新说明正文",
    html_url: "https://github.com/UesugiEri-1/NovaRec/releases/tag/v2.0.0",
    assets: [
      { name: "source.zip", browser_download_url: "https://github.com/UesugiEri-1/NovaRec/archive/source.zip", size: 1 },
      { name: "NovaRec-Setup-2.0.0-x64.exe", browser_download_url: "https://github.com/UesugiEri-1/NovaRec/releases/download/v2.0.0/NovaRec-Setup-2.0.0-x64.exe", size: 999 }
    ]
  });
  const result = await updater.checkForUpdates({ fetchImpl, currentVersion: "1.1.0", timeoutMs: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.latestVersion, "2.0.0");
  assert.equal(result.notes, "更新说明正文");
  assert.equal(result.releaseUrl, "https://github.com/UesugiEri-1/NovaRec/releases/tag/v2.0.0");
  assert.equal(result.asset.name, "NovaRec-Setup-2.0.0-x64.exe");
  assert.equal(result.asset.size, 999);
});

/* =========================================================================
   4. version.json 解析
   ========================================================================= */

test("version.json 解析：version/notes/url/assets", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === updater.CHECK_CHANNELS[2].url) {
      return jsonResponse({
        version: "1.2.0",
        notes: "1. 优化录制性能\n2. 修复托盘图标",
        url: "https://github.com/UesugiEri-1/NovaRec/releases/tag/v1.2.0",
        assets: [
          { name: "NovaRec-Setup-1.2.0-x64.exe", browser_download_url: "https://github.com/UesugiEri-1/NovaRec/releases/download/v1.2.0/NovaRec-Setup-1.2.0-x64.exe" }
        ]
      });
    }
    return notFound();
  };
  const result = await updater.checkForUpdates({ fetchImpl, currentVersion: "1.1.0", timeoutMs: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.channel, "version-json");
  assert.equal(result.latestVersion, "1.2.0");
  assert.match(result.notes, /优化录制性能/);
  assert.equal(result.releaseUrl, "https://github.com/UesugiEri-1/NovaRec/releases/tag/v1.2.0");
  assert.equal(result.asset.name, "NovaRec-Setup-1.2.0-x64.exe");
  assert.equal(calls.length, 3);
});

test("version.json 无 assets 但 url 是 exe 直链时自动补成资产", () => {
  const info = updater.normalizeVersionJson({
    version: "1.2.0",
    notes: "n",
    url: "https://github.com/UesugiEri-1/NovaRec/releases/download/v1.2.0/NovaRec-Setup-1.2.0-x64.exe"
  });
  assert.equal(info.version, "1.2.0");
  assert.equal(info.assets.length, 1);
  assert.equal(info.assets[0].name, "NovaRec-Setup-1.2.0-x64.exe");
});

test("normalizeVersionJson / normalizeReleaseJson 拒绝非法数据", () => {
  assert.equal(updater.normalizeVersionJson(null), null);
  assert.equal(updater.normalizeVersionJson({ version: "not-a-version" }), null);
  assert.equal(updater.normalizeReleaseJson({ tag_name: "latest" }), null);
  assert.equal(updater.normalizeReleaseJson({ tag_name: "v1.0.0" }).version, "1.0.0");
});

test("当前版本更高时不提示更新", async () => {
  const fetchImpl = async () => jsonResponse({ tag_name: "v1.0.0" });
  const result = await updater.checkForUpdates({ fetchImpl, currentVersion: "1.1.0", timeoutMs: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.latestVersion, "1.0.0");
});

/* =========================================================================
   5. 资产选择
   ========================================================================= */

test("selectAsset 优先 NovaRec-Setup-*-x64.exe", () => {
  const assets = [
    { name: "readme.txt", url: "https://github.com/a/readme.txt" },
    { name: "NovaRec-Setup-1.2.0-x64.exe", url: "https://github.com/a/setup.exe" },
    { name: "NovaRec-Setup-1.2.0-arm64.exe", url: "https://github.com/a/arm.exe" }
  ];
  assert.equal(updater.selectAsset(assets).name, "NovaRec-Setup-1.2.0-x64.exe");
  assert.equal(updater.selectAsset(assets.slice(0, 2)).name, "NovaRec-Setup-1.2.0-x64.exe");
  assert.equal(updater.selectAsset([{ name: "random.exe", url: "https://github.com/a/random.exe" }]).name, "random.exe");
  assert.equal(updater.selectAsset([{ name: "readme.txt", url: "https://github.com/a/readme.txt" }]), null);
  assert.equal(updater.selectAsset(null), null);
});

/* =========================================================================
   6. URL 白名单 / 镜像
   ========================================================================= */

test("isAllowedDownloadUrl 只放行 https + 白名单 host", () => {
  assert.equal(updater.isAllowedDownloadUrl("https://github.com/x/y.exe"), true);
  assert.equal(updater.isAllowedDownloadUrl("https://objects.githubusercontent.com/x/y.exe"), true);
  assert.equal(updater.isAllowedDownloadUrl("https://gh-proxy.com/https://github.com/x"), true);
  assert.equal(updater.isAllowedDownloadUrl("https://cdn.jsdelivr.net/gh/x/y.exe"), true);
  assert.equal(updater.isAllowedDownloadUrl("http://github.com/x/y.exe"), false);
  assert.equal(updater.isAllowedDownloadUrl("https://evil.example.com/y.exe"), false);
  assert.equal(updater.isAllowedDownloadUrl("ftp://github.com/y.exe"), false);
  assert.equal(updater.isAllowedDownloadUrl("not a url"), false);
  assert.equal(updater.isAllowedDownloadUrl(""), false);
});

test("buildDownloadUrls：github.com 直链追加 gh-proxy 镜像", () => {
  const direct = "https://github.com/UesugiEri-1/NovaRec/releases/download/v1.2.0/NovaRec-Setup-1.2.0-x64.exe";
  const urls = updater.buildDownloadUrls(direct);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], direct);
  assert.equal(urls[1], "https://gh-proxy.com/" + direct);
  assert.equal(updater.mirrorGithubUrl(direct), "https://gh-proxy.com/" + direct);
  assert.equal(updater.mirrorGithubUrl("https://objects.githubusercontent.com/a.exe"), "");
  // 已经是镜像地址 / 非白名单：不重复改写
  assert.deepEqual(updater.buildDownloadUrls("https://gh-proxy.com/https://github.com/a.exe"), ["https://gh-proxy.com/https://github.com/a.exe"]);
  assert.deepEqual(updater.buildDownloadUrls("https://evil.example.com/a.exe"), []);
});

/* =========================================================================
   7. 下载安装包
   ========================================================================= */

test("downloadUpdate 下载成功、进度回调、大小校验", async () => {
  const payload = Buffer.from("FAKE-INSTALLER-BYTES");
  const dir = path.join(TMP_ROOT, "download-ok");
  const progress = [];
  const asset = {
    name: "NovaRec-Setup-1.2.0-x64.exe",
    url: "https://github.com/UesugiEri-1/NovaRec/releases/download/v1.2.0/NovaRec-Setup-1.2.0-x64.exe"
  };
  const fetchImpl = async () => fileResponse(payload, { "content-length": String(payload.length) });
  const result = await updater.downloadUpdate({ fetchImpl, asset, updatesDir: dir, onProgress: (p) => progress.push(p) });
  assert.equal(result.ok, true);
  assert.equal(result.size, payload.length);
  assert.equal(fs.existsSync(result.filePath), true);
  assert.equal(fs.readFileSync(result.filePath).toString(), payload.toString());
  assert.equal(path.basename(result.filePath), "NovaRec-Setup-1.2.0-x64.exe");
  assert.ok(progress.includes(100), "进度回调应包含 100，实际 " + JSON.stringify(progress));
});

test("downloadUpdate 直连失败后自动用 gh-proxy 镜像重试", async () => {
  const payload = Buffer.from("MIRRORED-BYTES");
  const dir = path.join(TMP_ROOT, "download-mirror");
  const calls = [];
  const asset = {
    name: "NovaRec-Setup-1.2.0-x64.exe",
    url: "https://github.com/UesugiEri-1/NovaRec/releases/download/v1.2.0/NovaRec-Setup-1.2.0-x64.exe"
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.indexOf("gh-proxy.com") < 0) throw new Error("fetch failed");
    return fileResponse(payload, { "content-length": String(payload.length) });
  };
  const result = await updater.downloadUpdate({ fetchImpl, asset, updatesDir: dir });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^https:\/\/gh-proxy\.com\/https:\/\/github\.com\//);
  assert.match(result.url, /^https:\/\/gh-proxy\.com\//);
  assert.equal(fs.readFileSync(result.filePath).toString(), "MIRRORED-BYTES");
});

test("downloadUpdate 校验 Content-Length 不一致时报「下载不完整」", async () => {
  const dir = path.join(TMP_ROOT, "download-short");
  const asset = { name: "NovaRec-Setup-1.2.0-x64.exe", url: "https://github.com/a/NovaRec-Setup-1.2.0-x64.exe" };
  const fetchImpl = async () => fileResponse(Buffer.from("12345"), { "content-length": "100" });
  const result = await updater.downloadUpdate({ fetchImpl, asset, updatesDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.error, /下载不完整/);
  assert.equal(fs.existsSync(path.join(dir, asset.name)), false);
});

test("downloadUpdate 拒绝 text/html 响应", async () => {
  const dir = path.join(TMP_ROOT, "download-html");
  const asset = { name: "NovaRec-Setup-1.2.0-x64.exe", url: "https://github.com/a/NovaRec-Setup-1.2.0-x64.exe" };
  const fetchImpl = async () => new Response("<html><body>oops</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
  const result = await updater.downloadUpdate({ fetchImpl, asset, updatesDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.error, /不是安装包/);
});

test("downloadUpdate 拒绝非白名单 host，且不发起请求", async () => {
  const dir = path.join(TMP_ROOT, "download-host");
  const asset = { name: "NovaRec-Setup-1.2.0-x64.exe", url: "https://evil.example.com/NovaRec-Setup-1.2.0-x64.exe" };
  let calls = 0;
  const fetchImpl = async () => { calls++; return fileResponse(Buffer.from("x")); };
  const result = await updater.downloadUpdate({ fetchImpl, asset, updatesDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.error, /白名单/);
  assert.equal(calls, 0);
});

test("downloadUpdate 拒绝非 .exe 文件", async () => {
  const dir = path.join(TMP_ROOT, "download-ext");
  const asset = { name: "NovaRec-Setup-x64.zip", url: "https://github.com/a/NovaRec-Setup-x64.zip" };
  const fetchImpl = async () => fileResponse(Buffer.from("x"));
  const result = await updater.downloadUpdate({ fetchImpl, asset, updatesDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.error, /\.exe/);
});

test("downloadUpdate 无资产时给出「到发布页手动下载」提示", async () => {
  const result = await updater.downloadUpdate({
    fetchImpl: async () => fileResponse(Buffer.from("x")),
    asset: null,
    updatesDir: path.join(TMP_ROOT, "download-none")
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /发布页/);
});

test("sanitizeFileName 去掉路径分隔符等非法字符", () => {
  assert.equal(updater.sanitizeFileName("../../evil/NovaRec.exe"), "_.._evil_NovaRec.exe");
  assert.equal(updater.sanitizeFileName("NovaRec-Setup-1.2.0-x64.exe"), "NovaRec-Setup-1.2.0-x64.exe");
  assert.equal(updater.sanitizeFileName(""), "NovaRec-Setup-x64.exe");
});

/* =========================================================================
   8. 安装确认流程
   ========================================================================= */

function fakeInstallEnv(buttonIndex) {
  const calls = { quit: 0, openPath: [] };
  const exePath = path.join(TMP_ROOT, "install", "NovaRec-Setup-1.2.0-x64.exe");
  fs.mkdirSync(path.dirname(exePath), { recursive: true });
  fs.writeFileSync(exePath, "fake installer");
  return {
    exePath,
    calls,
    deps: {
      app: { quit: () => { calls.quit++; } },
      shell: { openPath: async (p) => { calls.openPath.push(p); return ""; } },
      dialog: { showMessageBox: async () => ({ response: buttonIndex }) },
      window: null
    }
  };
}

test("installDownloaded：确认后 shell.openPath + app.quit", async () => {
  const env = fakeInstallEnv(0);
  const result = await updater.installDownloaded(Object.assign({ filePath: env.exePath }, env.deps));
  assert.equal(result.ok, true);
  assert.deepEqual(env.calls.openPath, [env.exePath]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(env.calls.quit, 1);
});

test("installDownloaded：取消时不打开安装包也不退出", async () => {
  const env = fakeInstallEnv(1);
  const result = await updater.installDownloaded(Object.assign({ filePath: env.exePath }, env.deps));
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
  assert.equal(env.calls.openPath.length, 0);
  assert.equal(env.calls.quit, 0);
});

test("installDownloaded：安装包不存在时报错", async () => {
  const env = fakeInstallEnv(0);
  const result = await updater.installDownloaded(Object.assign({ filePath: path.join(TMP_ROOT, "nope.exe") }, env.deps));
  assert.equal(result.ok, false);
  assert.match(result.error, /不存在/);
});

test("installDownloaded：非 .exe 路径被拒绝", async () => {
  const env = fakeInstallEnv(0);
  const result = await updater.installDownloaded(Object.assign({ filePath: env.exePath.replace(/\.exe$/, ".zip") }, env.deps));
  assert.equal(result.ok, false);
  assert.match(result.error, /无效/);
});

/* =========================================================================
   9. 发布页 URL 白名单
   ========================================================================= */

test("isAllowedReleaseUrl 只放行 https 白名单 host", () => {
  assert.equal(updater.isAllowedReleaseUrl("https://github.com/UesugiEri-1/NovaRec/releases"), true);
  assert.equal(updater.isAllowedReleaseUrl("https://gh-proxy.com/https://github.com/x"), true);
  assert.equal(updater.isAllowedReleaseUrl("http://github.com/x"), false);
  assert.equal(updater.isAllowedReleaseUrl("https://evil.example.com/x"), false);
  assert.equal(updater.isAllowedReleaseUrl("javascript:alert(1)"), false);
});

/* =========================================================================
   执行
   ========================================================================= */

let passed = 0;
const failures = [];
console.log("NovaRec 更新模块测试");
console.log("=".repeat(56));
for (const item of tests) {
  try {
    await item.fn();
    passed++;
    console.log("PASS  " + item.name);
  } catch (err) {
    failures.push({ name: item.name, error: err });
    console.log("FAIL  " + item.name);
    console.log("      " + (err && err.message ? err.message.split("\n")[0] : String(err)));
  }
}
console.log("=".repeat(56));
console.log(passed + " passed, " + failures.length + " failed, " + tests.length + " total");
if (failures.length) {
  console.log("");
  for (const item of failures) {
    console.log("--- " + item.name + " ---");
    console.log(item.error && item.error.stack ? item.error.stack : String(item.error));
  }
}

try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (err) {}
if (failures.length) process.exitCode = 1;
