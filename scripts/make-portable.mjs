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

// === 便携版关键修复：解压目录改到 exe 同目录，避开 %TEMP%（C 盘）写入限制 ===
// electron-builder 的 portable 目标默认把应用解压到 $PLUGINSDIR（= %TEMP%\nsx*.tmp）。在本机
// （未签名程序被安全策略禁止写 C 盘用户目录）解压会直接报 “NSIS Error: Error writing temporary
// file” 并卡死。这里在打包前修改 node_modules 里的 portable.nsi 模板：解压到 portable exe 所在
// 目录下的 .novarec-portable；若该目录也不可写（例如 exe 放在 C 盘），再回退 D:\NovaRecPortable-tmp。
function patchPortableTemplate() {
  const file = path.join(ROOT, "node_modules", "app-builder-lib", "templates", "nsis", "portable.nsi");
  if (!fs.existsSync(file)) {
    log("WARN: 未找到 portable.nsi 模板，跳过后退路径修补（新版本 electron-builder 模板位置可能变化）");
    return false;
  }
  let src = fs.readFileSync(file, "utf8");
  if (src.indexOf("NOVAREC_EXTRACT_DIR_PATCH") >= 0) { log("portable.nsi 模板已修补，跳过"); return true; }
  const needle = 'StrCpy $INSTDIR "$PLUGINSDIR' + String.fromCharCode(92) + 'app"';
  const start = src.indexOf(needle);
  const end = start >= 0 ? src.indexOf("RMDir /r $INSTDIR", start) : -1;
  if (start < 0 || end < 0) {
    log("FAIL: portable.nsi 结构与预期不符，找不到解压目录设置，拒绝继续打包（先人工检查模板）");
    process.exit(3);
  }
  const bs = String.fromCharCode(92);
  const replacement = [
    "; NOVAREC_EXTRACT_DIR_PATCH 解压到 exe 同目录，避开 %TEMP%（C 盘）写入限制",
    '  StrCpy $INSTDIR "$EXEDIR' + bs + '.novarec-portable"',
    "  ClearErrors",
    '  CreateDirectory "$INSTDIR"',
    "  IfErrors novarecExtractDirFallback 0",
    "  Goto novarecExtractDirOk",
    "  novarecExtractDirFallback:",
    '    StrCpy $INSTDIR "D:' + bs + 'NovaRecPortable-tmp"',
    "  novarecExtractDirOk:",
    ""
  ].join("\n");
  src = src.slice(0, start) + replacement + src.slice(end);
  fs.writeFileSync(file, src, "utf8");
  log("portable.nsi 已修补：解压目录 = exe 同目录 .novarec-portable（不可写时回退 D:\\NovaRecPortable-tmp）");
  return true;
}
patchPortableTemplate();

const config = {
  appId: "com.novarec.screenrecorder",
  compression: "maximum",
  productName: "NovaRec",
  copyright: "Copyright \u00a9 2026 NovaRec",
  directories: { output: OUT_DIR, buildResources: path.join(ROOT, "assets") },
  win: {
    // 产物里的 NovaRec.exe 是 C# 启动器（见 scripts/build-launcher.mjs）。这里关掉 electron-builder 的
    // rcedit 图标/版本改写，避免动 .NET 程序集；图标与版本信息已由 csc 编译时写进启动器本身。
    signAndEditExecutable: false,
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
