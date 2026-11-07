// T3: 用 @electron/packager 打包 Windows x64 独立可运行版（不执行 npm install / rebuild）
// 运行: node scripts/package.mjs
import { packager } from "@electron/packager";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
// 支持 --out=DIR 指定输出目录（用于绕过被占用的旧产物目录）
const argOut = (function () {
  const a = process.argv.find(function (x) { return x.indexOf("--out=") === 0; });
  return a ? path.resolve(ROOT, a.slice("--out=".length)) : null;
})();
const DIST = argOut || path.join(ROOT, "artifacts", "dist");
const BUILD_DIR = path.join(ROOT, "artifacts", "build");
const REPORT = path.join(BUILD_DIR, "packaging-report.json");
const VERIFY_ONLY = process.argv.indexOf("--verify-only") >= 0;
const WANT_ZIP = process.argv.indexOf("--zip") >= 0;
// Windows 10 自带 bsdtar（System32\tar.exe）支持 -a 自动套 .zip；若 PATH 里是 GNU tar 会把它当远程主机解析，故优先绝对路径
const TAR_EXE = (function () {
  const cand = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(cand) ? cand : "tar";
})();

function log(s) { console.log("[" + new Date().toISOString() + "] " + s); }

// ---- 产物瘦身 ----
// 只保留中文/英文语言包（Electron 默认带 55 个 locales，占 ~49MB；应用 UI 仅需 zh-CN/en-US）
const LOCALES_KEEP = ["zh-CN.pak", "en-US.pak"];
// 运行时可选组件裁剪（默认生效）：
// - dxcompiler.dll（24.6MB）是 Chromium WebGPU/Dawn 的 DXIL 着色器编译器，NovaRec 不使用 WebGPU；
//   已用 scripts/verify-packaged-record.mjs 在裁剪后的产物上跑通全屏/区域/窗口三模式录制+系统声音回归。
// - 保留 vk_swiftshader.dll / vulkan-1.dll（6.1MB）：GPU 不可用/驱动异常机器上 Chromium 需要它们做软件光栅回退，
//   删掉可能导致部分机器界面起不来，属于功能风险，不做裁剪。
// - 保留 electron_wer.dll（0.4MB）：崩溃上报组件，收益可忽略。
const RUNTIME_PRUNE = ["dxcompiler.dll"];
// 额外可裁剪的顶层文件（实验/验证用，默认空）：例 NOVAREC_PRUNE_EXTRA="vk_swiftshader.dll"
const PRUNE_EXTRA = (process.env.NOVAREC_PRUNE_EXTRA || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
function pruneAppDir(appDir) {
  const removed = [];
  let freed = 0;
  const del = function (p) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) { fs.rmSync(p, { force: true }); removed.push(path.relative(appDir, p)); freed += st.size; }
    } catch (e) {}
  };
  // locales：白名单外全部删除
  const localesDir = path.join(appDir, "locales");
  const keptLocales = [];
  try {
    fs.readdirSync(localesDir, { withFileTypes: true }).forEach(function (ent) {
      if (!ent.isFile()) return;
      if (LOCALES_KEEP.indexOf(ent.name) >= 0) keptLocales.push(ent.name);
      else del(path.join(localesDir, ent.name));
    });
  } catch (e) {}
  // 运行时可选组件 + 实验性额外裁剪（按顶层文件名匹配，含子目录相对路径）
  const runtimeRemoved = [];
  RUNTIME_PRUNE.concat(PRUNE_EXTRA).forEach(function (name) {
    const abs = path.join(appDir, name);
    if (fs.existsSync(abs)) {
      const before = removed.length;
      del(abs);
      if (removed.length > before) runtimeRemoved.push(name);
    }
  });
  if (removed.length) log("PRUNE: removed " + removed.length + " files, freed " + (freed / 1048576).toFixed(2) + " MB; locales kept=" + JSON.stringify(keptLocales) + " runtime=" + JSON.stringify(runtimeRemoved));
  return { localesKept: keptLocales, runtimeRemoved: runtimeRemoved, removedFiles: removed.length, removedBytes: freed, removedSample: removed.slice(0, 12) };
}
function dirSize(dir) {
  let total = 0, files = 0;
  const walk = function (d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) { try { total += fs.statSync(p).size; files++; } catch (e) {} }
    }
  };
  walk(dir);
  return { bytes: total, files: files };
}

// 查找本地已有的 Electron win32-x64 zip，避免打包时联网下载
function findElectronZipDir(version) {
  const zipName = "electron-v" + version + "-win32-x64.zip";
  const candidates = [];
  const addCache = function (base, depth) {
    const walk = function (d, left) {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        const p = path.join(d, ent.name);
        if (fs.existsSync(path.join(p, zipName))) candidates.push(p);
        if (left > 0) walk(p, left - 1);
      }
    };
    if (base && fs.existsSync(base)) walk(base, depth);
  };
  addCache(path.join(ROOT, ".electron-cache"), 2);
  addCache(path.join(process.env.LOCALAPPDATA || "", "electron", "Cache"), 2);
  addCache(path.join(process.env.USERPROFILE || "", ".cache", "electron"), 2);
  return candidates.length ? candidates[0] : null;
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const electronVersion = (pkg.devDependencies && pkg.devDependencies.electron ? pkg.devDependencies.electron : "").replace(/^[^0-9]*/, "") || "45.2.1";
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const zipDir = findElectronZipDir(electronVersion);
  log("electron version=" + electronVersion + " localZipDir=" + zipDir);

  // ignore: 匹配绝对路径；排除测试产物/开发数据/缓存/文档脚本
  const IGNORE = [
    /[\\/]artifacts([\\/]|$)/i,
    /[\\/]\.data[^\\/]*([\\/]|$)/i,
    /[\\/]\.electron-cache([\\/]|$)/i,
    /[\\/]\.etmp([\\/]|$)/i,
    /[\\/]docs([\\/]|$)/i,
    /[\\/]scripts([\\/]|$)/i,
    /[\\/]\.git([\\/]|$)/i,
    /[\\/]nul$/i,
    // 多尺寸母版图标只给 scripts/make-icons-v2.mjs 生成用，运行期只读 assets/icon.png 与
    // assets/icon.ico（main.js:195/241），打包时排除可省约 1.2MB。
    /assets[\\/]icon-1024\.png$/i,
    /assets[\\/]icon-512\.png$/i,
    /assets[\\/]icon-128\.png$/i,
  ];

  const opts = {
    dir: ROOT,
    out: DIST,
    overwrite: true,
    platform: "win32",
    arch: "x64",
    name: "NovaRec",
    appVersion: pkg.version || "1.0.0",
    icon: path.join(ROOT, "assets", "icon.ico"),
    asar: true,
    ignore: IGNORE,
    prune: true,
    electronVersion: electronVersion,
  };
  if (zipDir) opts.electronZipDir = zipDir;

  let outDirs = [];
  if (VERIFY_ONLY) {
    log("verify-only 模式：跳过打包，直接校验现有产物 " + DIST);
    if (!fs.existsSync(DIST)) { log("FAIL: 产物目录不存在，无法校验"); process.exit(2); }
  } else {
    // packager 的 overwrite 在 Windows 上遇到句柄占用会 EBUSY；先自行清理旧产物目录并重试
    if (fs.existsSync(DIST)) {
      try {
        fs.rmSync(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
      } catch (e) {
        log("FAIL: 无法清理旧产物目录（可能被杀毒软件/资源管理器占用，请稍后重试）：" + ((e && e.message) || e));
        process.exit(3);
      }
    }
    log("packaging start opts=" + JSON.stringify({ dir: opts.dir, out: opts.out, platform: opts.platform, arch: opts.arch, name: opts.name, appVersion: opts.appVersion, electronVersion: opts.electronVersion, electronZipDir: opts.electronZipDir || null }));
    const t0 = Date.now();
    try {
      outDirs = await packager(opts);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // 首次打包需要下载 Electron 二进制；直连 GitHub 失败时，自动切到国内镜像重试一次
      if (!opts.electronZipDir && !process.env.ELECTRON_MIRROR && /fetch failed|ETIMEDOUT|ENOTFOUND|ECONNRESET/i.test(msg)) {
        process.env.ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
        log("WARN: 下载 Electron 失败（" + msg + "），改用镜像 " + process.env.ELECTRON_MIRROR + " 重试");
        outDirs = await packager(opts);
      } else {
        throw e;
      }
    }
    log("packaging done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s: " + JSON.stringify(outDirs));
  }

  const appDir = path.join(DIST, "NovaRec-win32-x64");
  const pruneInfo = pruneAppDir(appDir);
  const exe = path.join(appDir, "NovaRec.exe");
  const asar = path.join(appDir, "resources", "app.asar");

  const statOf = function (p) { try { const st = fs.statSync(p); return { exists: true, bytes: st.size }; } catch (e) { return { exists: false, bytes: 0 }; } };
  const exeStat = statOf(exe);
  const asarStat = statOf(asar);
  const distInfo = dirSize(appDir);

  // 校验 asar 内确实包含应用主进程/渲染层源码（避免 ignore 误伤）
  let asarEntries = [];
  let asarError = null;
  try {
    asarEntries = require("@electron/asar").listPackage(asar);
  } catch (e) { asarError = (e && e.message) || String(e); }
  const asarHasMain = asarEntries.some(function (x) { return /[\\/]src[\\/]main[\\/]main\.js$/.test(x); });
  const asarHasRenderer = asarEntries.some(function (x) { return /[\\/]src[\\/]renderer[\\/]index\.html$/.test(x); });
  // 关键：收尾不再依赖 ffmpeg.exe，必须确认纯 JS 重封装器随包分发。
  const asarHasRemuxer = ["mp4remux.js", "webmfix.js", "mediafix.js"].every(function (f) {
    return asarEntries.some(function (x) { return new RegExp("[\\\\/]src[\\\\/]main[\\\\/]" + f.replace(".", "\\.") + "$").test(x); });
  });

  const checks = {
    exeExists: exeStat.exists,
    asarExists: asarStat.exists && asarStat.bytes > 100 * 1024,
    asarHasMain: asarHasMain,
    asarHasRenderer: asarHasRenderer,
    asarHasRemuxer: asarHasRemuxer,
    noUnpackedFfmpeg: !fs.existsSync(path.join(appDir, "resources", "app.asar.unpacked")),
    noFfmpegDep: !fs.existsSync(path.join(appDir, "resources", "app.asar.unpacked", "node_modules")),
    // 体积裁剪：WebGPU 着色器编译器不随包分发（应用不使用 WebGPU）
    noDxcompiler: !fs.existsSync(path.join(appDir, "dxcompiler.dll")),
    // 健壮性：软件光栅回退组件必须留着（GPU 异常/远程桌面场景）
    hasSwiftShader: fs.existsSync(path.join(appDir, "vk_swiftshader.dll")) && fs.existsSync(path.join(appDir, "vulkan-1.dll")),
  };
  const ok = Object.keys(checks).every(function (k) { return checks[k] === true; });

  // 中文使用说明复制进产物目录（zip 内也会带上）
  let docCopied = null;
  const docSrc = path.join(ROOT, "docs", "使用说明.md");
  if (fs.existsSync(docSrc) && fs.existsSync(appDir)) {
    const docDst = path.join(appDir, "使用说明.md");
    try {
      fs.copyFileSync(docSrc, docDst);
      docCopied = { path: docDst, bytes: fs.statSync(docDst).size };
      log("使用说明.md copied -> " + docDst + " (" + docCopied.bytes + " bytes)");
    } catch (e) {
      docCopied = { error: (e && e.message) || String(e) };
      log("WARN: 使用说明.md 复制失败: " + docCopied.error);
    }
  } else {
    log("WARN: 未找到 docs/使用说明.md 或产物目录，跳过文档复制");
  }

  // 打 zip（tar -a 走系统 bsdtar，Windows 10 自带），并校验条目完整性
  let zip = null;
  if (WANT_ZIP && ok) {
    const zipPath = path.join(ROOT, "artifacts", "NovaRec-" + opts.appVersion + "-win32-x64.zip");
    try { if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true, maxRetries: 3, retryDelay: 500 }); } catch (e) {}
    const t0 = Date.now();
    const res = spawnSync(TAR_EXE, ["-a", "-c", "-f", zipPath, "-C", DIST, "NovaRec-win32-x64"], { cwd: ROOT, windowsHide: true, timeout: 900000 });
    const st = fs.existsSync(zipPath) ? fs.statSync(zipPath) : null;
    let entryCheck = { ok: false };
    if (st && st.size > 1024 * 1024) {
      const list = spawnSync(TAR_EXE, ["-t", "-f", zipPath], { cwd: ROOT, windowsHide: true, timeout: 180000, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
      const items = (list.stdout || "").split(/\r?\n/).filter(Boolean);
      entryCheck = {
        entries: items.length,
        hasExe: items.some(function (x) { return /NovaRec-win32-x64\/NovaRec\.exe$/.test(x); }),
        hasAsar: items.some(function (x) { return /NovaRec-win32-x64\/resources\/app\.asar$/.test(x); }),
        noUnpackedDir: !items.some(function (x) { return /app\.asar\.unpacked\//.test(x); }),
        hasDoc: items.some(function (x) { return /^NovaRec-win32-x64\/[^/]+\.md$/.test(x); }),
      };
      entryCheck.ok = !!(entryCheck.hasExe && entryCheck.hasAsar && entryCheck.noUnpackedDir && entryCheck.hasDoc);
    }
    zip = { path: zipPath, bytes: st ? st.size : 0, seconds: Math.round((Date.now() - t0) / 100) / 10, tarStatus: res.status, tarOk: res.status === 0, stderr: (res.stderr || "").slice(-400), entryCheck: entryCheck };
    log("ZIP " + JSON.stringify(zip));
  } else if (WANT_ZIP) {
    log("WARN: 打包校验未通过，跳过 zip");
  }
  const zipOk = !WANT_ZIP ? true : !!(zip && zip.entryCheck && zip.entryCheck.ok);
  const finalOk = ok && zipOk;

  const report = {
    ok: finalOk,
    packagingOk: ok,
    zipOk: zipOk,
    at: new Date().toISOString(),
    verifyOnly: VERIFY_ONLY,
    appDir: appDir,
    exe: { path: exe, bytes: exeStat.bytes },
    asar: { path: asar, bytes: asarStat.bytes },
    remuxer: "js (mp4remux/webmfix/mediafix, no ffmpeg binary)",
    dist: distInfo,
    electronVersion: electronVersion,
    electronZipDir: zipDir,
    appVersion: opts.appVersion,
    asarEntries: asarEntries.length,
    asarError: asarError,
    prune: pruneInfo,
    checks: checks,
    docCopied: docCopied,
    zip: zip,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  log("PACKAGE REPORT " + JSON.stringify({ ok: finalOk, packagingOk: ok, zipOk: zipOk, exeBytes: exeStat.bytes, asarBytes: asarStat.bytes, distBytes: distInfo.bytes, distFiles: distInfo.files, pruneFreedMB: Math.round(pruneInfo.removedBytes / 104857.6) / 10, checks: checks }));
  log("report -> " + REPORT);
  return finalOk ? 0 : 2;
}

main().then(function (code) { process.exitCode = code; }).catch(function (e) {
  log("PACKAGE ERROR " + ((e && e.stack) || e));
  process.exitCode = 1;
});
