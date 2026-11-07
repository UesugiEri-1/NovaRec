"use strict";
// 用 electron-builder 从打包好的便携版目录（prepackaged）生成单文件便携版（portable，7z 自解压）。
// 用法: node scripts/make-portable.mjs [--dir=artifacts/dist/NovaRec-win32-x64] [--out=artifacts/portable]
// 说明：portable 目标把整个应用目录用 LZMA/7z 压进一个 exe，体积接近安装包（约 95-100MB），
// 双击即用、不写注册表；启动时自解压到 %TEMP%，因此首次启动比解压好的 zip 慢 1~3s。
import { build, Platform, Arch } from "electron-builder";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const arg = function (name) {
  const a = process.argv.find(function (x) { return x.indexOf("--" + name + "=") === 0; });
  return a ? a.slice(name.length + 3) : null;
};
const APP_DIR = path.resolve(ROOT, arg("dir") || path.join("artifacts", "dist", "NovaRec-win32-x64"));
const OUT_DIR = path.resolve(ROOT, arg("out") || path.join("artifacts", "portable"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version || "1.0.0";

function log(s) { console.log("[" + new Date().toISOString() + "] " + s); }

// 与 make-installer.mjs 同样的问题：Git Bash 下 TEMP/TMP 是 /tmp，NSIS/7z 桩程序会失败。
const winTemp = path.join(ROOT, "artifacts", ".build-temp-portable");
fs.rmSync(winTemp, { recursive: true, force: true });
fs.mkdirSync(winTemp, { recursive: true });
for (const k of ["TEMP", "TMP", "TMPDIR"]) process.env[k] = winTemp;
log("temp env normalized -> " + winTemp);

if (!fs.existsSync(path.join(APP_DIR, "NovaRec.exe")) || !fs.existsSync(path.join(APP_DIR, "resources", "app.asar"))) {
  log("FAIL: 未找到可打包的应用目录（需要 NovaRec.exe 与 resources/app.asar）: " + APP_DIR);
  process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

process.env.ELECTRON_BUILDER_BINARIES_MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/";

const config = {
  appId: "com.novarec.screenrecorder",
  compression: "maximum",
  productName: "NovaRec",
  copyright: "Copyright \u00a9 2026 NovaRec",
  directories: { output: OUT_DIR, buildResources: path.join(ROOT, "assets") },
  win: {
    target: [{ target: "portable", arch: ["x64"] }],
    icon: path.join(ROOT, "assets", "icon.ico"),
    legalTrademarks: "NovaRec",
    artifactName: "NovaRec-Portable-" + VERSION + "-x64.exe",
  },
  portable: {
    artifactName: "NovaRec-Portable-" + VERSION + "-x64.exe",
    unicode: true,
    requestExecutionLevel: "user",
  },
};

log("prepackaged=" + APP_DIR + " out=" + OUT_DIR + " version=" + VERSION);
const t0 = Date.now();
try {
  const artifacts = await build({
    prepackaged: APP_DIR,
    config: config,
    targets: Platform.WINDOWS.createTarget(["portable"], Arch.x64),
  });
  log("BUILD OK in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  for (const a of artifacts) {
    try { log("FILE " + a + " " + fs.statSync(a).size + "B"); } catch (e) {}
  }
  setTimeout(function () { process.exit(0); }, 100);
} catch (e) {
  log("BUILD ERROR " + ((e && e.stack) || e));
  process.exit(1);
}
