"use strict";
// 构建 NovaRec 启动器（C# / .NET Framework 4.x，用 Windows 自带 csc 编译，无需任何额外依赖）
//
// 为什么需要启动器：
//   本机（以及可能同类环境）Chromium 的沙箱在创建子进程之前就 STATUS_BREAKPOINT(0x80000003) 静默崩溃，
//   崩溃发生在主进程 JS 执行之前 —— 所以 app.commandLine.appendSwitch("no-sandbox") 根本来不及生效，
//   只有把 --no-sandbox 写进**进程启动参数**才有效（已用 electron 33/45 + 新建最小 main 双重验证）。
//   于是产物目录里 NovaRec.exe 换成这个 ~100KB 的启动器，真正的 Electron 程序改名 NovaRecApp.exe，
//   启动器带上 --no-sandbox 拉起它并等待退出（单文件便携版的自解压桩依赖子进程退出码来清理临时目录）。
//   启动器用 C# 编写：.NET Framework 4.x 在 Win10 及以上系统内置，不引入任何运行时依赖，体积可忽略。
//
// 运行: node scripts/build-launcher.mjs [--out=assets/NovaRecLauncher.exe]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const arg = function (name) {
  const a = process.argv.find(function (x) { return x.indexOf("--" + name + "=") === 0; });
  return a ? a.slice(name.length + 3) : null;
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version || "1.0.0";
const VER4 = VERSION.split(".").concat(["0", "0", "0"]).slice(0, 4).join(".").replace(/[^0-9.]/g, "") || "1.0.0.0";
const OUT = path.resolve(ROOT, arg("out") || path.join("assets", "NovaRecLauncher.exe"));
const SRC = path.join(ROOT, "scripts", "launcher", "NovaRecLauncher.cs");
const ICON = path.join(ROOT, "assets", "icon.ico");

function log(s) { console.log("[" + new Date().toISOString() + "] " + s); }

// 找 .NET Framework 的 csc.exe（64 位优先）
const CSC_CANDIDATES = [
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const CSC = CSC_CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!CSC) {
  log("FAIL: 找不到 csc.exe（.NET Framework 4.x 未安装？）: " + CSC_CANDIDATES.join(" | "));
  process.exit(2);
}
if (!fs.existsSync(SRC)) {
  log("FAIL: 缺少启动器源码 " + SRC);
  process.exit(2);
}

// 1) 把 package.json 的版本号注入 C# 程序集版本（源码里的数值只是占位）
let src = fs.readFileSync(SRC, "utf8");
const srcVersion = (src.match(/AssemblyVersion\("([^"]*)"\)/) || [])[1] || "(none)";
src = src.replace(/AssemblyVersion\("[^"]*"\)/, 'AssemblyVersion("' + VER4 + '")');
src = src.replace(/AssemblyFileVersion\("[^"]*"\)/, 'AssemblyFileVersion("' + VER4 + '")');

// 2) 写入临时源码再编译（UTF-8 BOM + /codepage:65001，保证中文元数据不乱码）
const TMP_DIR = path.join(ROOT, "artifacts", ".launcher");
fs.mkdirSync(TMP_DIR, { recursive: true });
const tmpSrc = path.join(TMP_DIR, "NovaRecLauncher.cs");
fs.writeFileSync(tmpSrc, "\uFEFF" + src, "utf8");

// 3) 编译：winexe（无控制台窗口）、优化、图标、版本元数据
const cscArgs = ["/nologo", "/target:winexe", "/optimize+", "/codepage:65001", "/out:" + OUT];
if (fs.existsSync(ICON)) cscArgs.push("/win32icon:" + ICON);
cscArgs.push(tmpSrc);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
try { fs.rmSync(OUT, { force: true }); } catch (e) {}

const t0 = Date.now();
let out = "", err = "";
try {
  execFileSync(CSC, cscArgs, { cwd: ROOT, timeout: 120000, windowsHide: true, encoding: "utf8" });
} catch (e) {
  out = (e && e.stdout) || "";
  err = (e && e.stderr) || (e && e.message) || String(e);
}

if (!fs.existsSync(OUT)) {
  log("FAIL: csc 编译失败\nSTDOUT: " + out.slice(-1500) + "\nSTDERR: " + err.slice(-1500));
  process.exit(1);
}
const st = fs.statSync(OUT);
const bytes = st.size;
const okSize = bytes > 20 * 1024 && bytes < 4 * 1024 * 1024;
log("LAUNCHER " + JSON.stringify({
  ok: okSize,
  exe: OUT,
  bytes: bytes,
  version: VER4,
  sourceVersion: srcVersion,
  icon: fs.existsSync(ICON),
  seconds: Math.round((Date.now() - t0) / 100) / 10,
  compiler: CSC,
}));
if (!okSize) { log("FAIL: 启动器体积异常（" + bytes + "B）"); process.exit(1); }
