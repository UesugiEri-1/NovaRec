"use strict";
// 用 electron-builder 从打包好的便携版目录（prepackaged）生成 NSIS 中文安装包。
// 用法: node scripts/make-installer.mjs [--dir=artifacts/dist/NovaRec-win32-x64] [--out=artifacts/installer]
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
const OUT_DIR = path.resolve(ROOT, arg("out") || path.join("artifacts", "installer"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version || "1.0.0";

function log(s) { console.log("[" + new Date().toISOString() + "] " + s); }

// === 关键修复 ===
// 在 Git Bash 环境下 TEMP/TMP 会被设成 /tmp（Linux 风格路径）。electron-builder 生成
// 卸载器时需要直接执行刚编译出的 NSIS 桩程序，NSIS 读取 TEMP 写临时文件；/tmp 在
// Windows 上不可用 → 弹出 "NSIS Error: Error writing temporary file" 对话框并挂起，
// 最终被 120s 超时杀掉（ERR_ELECTRON_BUILDER_CANNOT_EXECUTE / Exit code: null）。
// 这里把临时目录环境变量全部规范成真实 Windows 路径（子进程会继承）。
// 实测：用户 Temp（C: 盘）下 NSIS 桩程序会报 "Error writing temporary file" 并失败；
// 改用项目内 D: 盘的独立临时目录后稳定成功（同盘、空目录、完全可控）。
const winTemp = path.join(ROOT, "artifacts", ".build-temp");
fs.rmSync(winTemp, { recursive: true, force: true });
fs.mkdirSync(winTemp, { recursive: true });
for (const k of ["TEMP", "TMP", "TMPDIR"]) process.env[k] = winTemp;
log("temp env normalized -> " + winTemp);

if (!fs.existsSync(path.join(APP_DIR, "NovaRec.exe")) || !fs.existsSync(path.join(APP_DIR, "resources", "app.asar"))) {
  log("FAIL: 未找到可打包的应用目录（需要 NovaRec.exe 与 resources/app.asar）: " + APP_DIR);
  process.exit(2);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

// 使用 npmmirror 镜像下载 NSIS / winCodeSign 构建工具（本机直连 GitHub 不可用）
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/";

const config = {
  appId: "com.novarec.screenrecorder",
  compression: "maximum", // NSIS 使用 LZMA 最大压缩（安装包体积显著下降）
  productName: "NovaRec",
  copyright: "Copyright \u00a9 2026 NovaRec",
  directories: { output: OUT_DIR, buildResources: path.join(ROOT, "assets") },
  win: {
    // 产物里的 NovaRec.exe 是 C# 启动器（见 scripts/build-launcher.mjs）。这里关掉 electron-builder 的
    // rcedit 图标/版本改写，避免动 .NET 程序集；图标与版本信息已由 csc 编译时写进启动器本身。
    signAndEditExecutable: false,
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: path.join(ROOT, "assets", "icon.ico"),
    legalTrademarks: "NovaRec",
    artifactName: "NovaRec-Setup-" + VERSION + "-x64.exe",
  },
  nsis: {
    oneClick: false,
    perMachine: false, // 当前会话无法弹 UAC，采用当前用户安装（无需管理员，安装到 %LOCALAPPDATA%\Programs）
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "NovaRec",
    uninstallDisplayName: "NovaRec \u5f55\u5c4f",
    installerIcon: path.join(ROOT, "assets", "icon.ico"),
    uninstallerIcon: path.join(ROOT, "assets", "icon.ico"),
    installerHeaderIcon: path.join(ROOT, "assets", "icon.ico"),
    multiLanguageInstaller: true,
    installerLanguages: ["zh_CN", "en_US"],
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
    differentialPackage: false,
    warningsAsErrors: false,
    // 自定义 .onInit 逻辑：默认安装目录（C:\Users\<用户>\AppData\Local\Programs\NovaRec）在
    // 带「未签名程序禁止写 C 盘」类策略的机器上不可写，会自动改用 D:\NovaRec。见 assets/installer.nsh。
    include: path.join(ROOT, "assets", "installer.nsh"),
  },
};

log("prepackaged=" + APP_DIR + " out=" + OUT_DIR + " version=" + VERSION);
const t0 = Date.now();
try {
  const artifacts = await build({
    prepackaged: APP_DIR,
    config: config,
    targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  });
  log("BUILD OK in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  log("artifacts=" + JSON.stringify(artifacts));
  for (const a of artifacts) {
    try { log("FILE " + a + " " + fs.statSync(a).size + "B"); } catch (e) {}
  }
  setTimeout(function () { process.exit(0); }, 100);
} catch (e) {
  log("BUILD ERROR " + ((e && e.stack) || e));
  process.exit(1);
}
