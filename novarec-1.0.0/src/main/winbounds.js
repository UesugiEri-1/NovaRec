"use strict";
// 通过 PowerShell + user32/dwmapi 读取第三方窗口的物理像素边界（窗口录制降级路径用）。
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// PowerShell 脚本（base64 保存，避免多层转义问题）。
const PS_SCRIPT = Buffer.from("cGFyYW0oW2xvbmddJEh3bmQsIFtzdHJpbmddJEFjdGlvbiA9ICJyZWN0IikNCkFkZC1UeXBlIC1UeXBlRGVmaW5pdGlvbiBAIg0KdXNpbmcgU3lzdGVtOw0KdXNpbmcgU3lzdGVtLlJ1bnRpbWUuSW50ZXJvcFNlcnZpY2VzOw0KcHVibGljIGNsYXNzIE5SV2luMzIgew0KICBbU3RydWN0TGF5b3V0KExheW91dEtpbmQuU2VxdWVudGlhbCldIHB1YmxpYyBzdHJ1Y3QgUkVDVCB7IHB1YmxpYyBpbnQgTGVmdDsgcHVibGljIGludCBUb3A7IHB1YmxpYyBpbnQgUmlnaHQ7IHB1YmxpYyBpbnQgQm90dG9tOyB9DQogIFtEbGxJbXBvcnQoInVzZXIzMi5kbGwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBTZXRQcm9jZXNzRHBpQXdhcmVuZXNzQ29udGV4dChJbnRQdHIgdmFsdWUpOw0KICBbRGxsSW1wb3J0KCJ1c2VyMzIuZGxsIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0UHJvY2Vzc0RQSUF3YXJlKCk7DQogIFtEbGxJbXBvcnQoInVzZXIzMi5kbGwiKV0gcHVibGljIHN0YXRpYyBleHRlcm4gYm9vbCBHZXRXaW5kb3dSZWN0KEludFB0ciBoV25kLCBvdXQgUkVDVCByZWN0KTsNCiAgW0RsbEltcG9ydCgiZHdtYXBpLmRsbCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBpbnQgRHdtR2V0V2luZG93QXR0cmlidXRlKEludFB0ciBod25kLCBpbnQgYXR0ciwgb3V0IFJFQ1QgcmVjdCwgaW50IHNpemUpOw0KICBbRGxsSW1wb3J0KCJ1c2VyMzIuZGxsIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgSXNXaW5kb3dWaXNpYmxlKEludFB0ciBoV25kKTsNCiAgW0RsbEltcG9ydCgidXNlcjMyLmRsbCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIElzSWNvbmljKEludFB0ciBoV25kKTsNCiAgW0RsbEltcG9ydCgidXNlcjMyLmRsbCIpXSBwdWJsaWMgc3RhdGljIGV4dGVybiBib29sIFNob3dXaW5kb3coSW50UHRyIGhXbmQsIGludCBjbWQpOw0KICBbRGxsSW1wb3J0KCJ1c2VyMzIuZGxsIildIHB1YmxpYyBzdGF0aWMgZXh0ZXJuIGJvb2wgU2V0Rm9yZWdyb3VuZFdpbmRvdyhJbnRQdHIgaFduZCk7DQogIHB1YmxpYyBzdGF0aWMgc3RyaW5nIEluZm8oSW50UHRyIGgpIHsNCiAgICBSRUNUIHI7DQogICAgR2V0V2luZG93UmVjdChoLCBvdXQgcik7DQogICAgUkVDVCBkOw0KICAgIGludCBociA9IER3bUdldFdpbmRvd0F0dHJpYnV0ZShoLCA5LCBvdXQgZCwgTWFyc2hhbC5TaXplT2YodHlwZW9mKFJFQ1QpKSk7DQogICAgYm9vbCB2aXNpYmxlID0gSXNXaW5kb3dWaXNpYmxlKGgpOw0KICAgIGJvb2wgaWNvbmljID0gSXNJY29uaWMoaCk7DQogICAgaW50IGRsID0gaHIgPT0gMCA/IGQuTGVmdCA6IHIuTGVmdDsNCiAgICBpbnQgZHQgPSBociA9PSAwID8gZC5Ub3AgOiByLlRvcDsNCiAgICBpbnQgZHcgPSBociA9PSAwID8gKGQuUmlnaHQgLSBkLkxlZnQpIDogKHIuUmlnaHQgLSByLkxlZnQpOw0KICAgIGludCBkaCA9IGhyID09IDAgPyAoZC5Cb3R0b20gLSBkLlRvcCkgOiAoci5Cb3R0b20gLSByLlRvcCk7DQogICAgaW50IGJ3ID0gci5SaWdodCAtIHIuTGVmdDsNCiAgICBpbnQgYmggPSByLkJvdHRvbSAtIHIuVG9wOw0KICAgIHJldHVybiByLkxlZnQgKyAiLCIgKyByLlRvcCArICIsIiArIGJ3ICsgIiwiICsgYmggKyAiLCIgKyBkbCArICIsIiArIGR0ICsgIiwiICsgZHcgKyAiLCIgKyBkaCArICIsIiArICh2aXNpYmxlID8gMSA6IDApICsgIiwiICsgKGljb25pYyA/IDEgOiAwKTsNCiAgfQ0KICBwdWJsaWMgc3RhdGljIHZvaWQgQWN0aXZhdGUoSW50UHRyIGgpIHsNCiAgICBpZiAoSXNJY29uaWMoaCkpIHsgU2hvd1dpbmRvdyhoLCA5KTsgfQ0KICAgIFNob3dXaW5kb3coaCwgNSk7DQogICAgU2V0Rm9yZWdyb3VuZFdpbmRvdyhoKTsNCiAgfQ0KfQ0KIkANCnRyeSB7IFt2b2lkXVtOUldpbjMyXTo6U2V0UHJvY2Vzc0RwaUF3YXJlbmVzc0NvbnRleHQoW0ludFB0cl06Om5ldygtNCkpIH0gY2F0Y2ggeyB0cnkgeyBbdm9pZF1bTlJXaW4zMl06OlNldFByb2Nlc3NEUElBd2FyZSgpIH0gY2F0Y2gge30gfQ0KJGggPSBbSW50UHRyXTo6bmV3KCRId25kKQ0KaWYgKCRBY3Rpb24gLWVxICJhY3RpdmF0ZSIpIHsgW05SV2luMzJdOjpBY3RpdmF0ZSgkaCk7IFN0YXJ0LVNsZWVwIC1NaWxsaXNlY29uZHMgMjUwIH0NCltOUldpbjMyXTo6SW5mbygkaCk=", "base64").toString("utf8");

// 把参数直接注入脚本正文后用 -EncodedCommand 传参，避免写临时 .ps1 文件
// （实测某些环境下写 %TEMP% 会 EPERM，导致窗口录制降级路径失败）。
function buildBody(hwnd, action) {
  const lines = PS_SCRIPT.split(/\r?\n/).filter(function (line) {
    return line.trim().indexOf("param(") !== 0;
  });
  const head = "$Hwnd = " + Number(hwnd) + "; $Action = " + JSON.stringify(String(action || "rect")) + ";";
  return head + "\r\n" + lines.join("\r\n");
}

function hwndFromSourceId(sourceId) {
  const m = /^window:(\d+):/.exec(String(sourceId || ""));
  return m ? Number(m[1]) : 0;
}

// PowerShell 的 Add-Type 需要往 TEMP 写编译临时文件；某些环境下默认 %TEMP% 会 EPERM，
// 所以给子进程显式指定一个我们自己的可写临时目录（userData/pstmp）。
let cachedTmpDir = null;
function psTmpDir() {
  if (cachedTmpDir) return cachedTmpDir;
  const candidates = [];
  try {
    const electron = require("electron");
    if (electron && electron.app && electron.app.getPath) candidates.push(path.join(electron.app.getPath("userData"), "pstmp"));
  } catch (e) {}
  candidates.push(path.join(os.tmpdir(), "novarec-pstmp"));
  for (let i = 0; i < candidates.length; i++) {
    try { fs.mkdirSync(candidates[i], { recursive: true }); cachedTmpDir = candidates[i]; return cachedTmpDir; } catch (e) {}
  }
  cachedTmpDir = os.tmpdir();
  return cachedTmpDir;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function runPsOnce(hwnd, action) {
  return new Promise(function (resolve, reject) {
    let b64;
    try {
      b64 = Buffer.from(buildBody(hwnd, action), "utf16le").toString("base64");
    } catch (e) { reject(e); return; }
    const tmp = psTmpDir();
    const env = Object.assign({}, process.env, { TMP: tmp, TEMP: tmp, TMPDIR: tmp });
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", b64
    ], { windowsHide: true, timeout: 20000, env: env }, function (err, stdout, stderr) {
      if (err) { reject(new Error("powershell failed: " + (err.message || "") + " " + String(stderr || "").slice(0, 300))); return; }
      resolve(String(stdout || "").trim());
    });
  });
}

// 偶发 EPERM（Add-Type 写临时文件被拒）等瞬时错误：重试 3 次，间隔 350ms。
async function runPs(hwnd, action) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runPsOnce(hwnd, action);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || "");
      if (attempt < 2 && /EPERM|EACCES|access is denied|拒绝访问|Add-Type|failed/i.test(msg)) { await sleep(350); continue; }
      break;
    }
  }
  throw lastErr || new Error("powershell 调用失败");
}

// 返回 {windowRect:{left,top,width,height}, visibleRect:{x,y,width,height}, visible, minimized}（物理像素）
async function getWindowInfo(hwnd, activate) {
  if (!hwnd) throw new Error("无效的窗口句柄");
  const text = await runPs(hwnd, activate ? "activate" : "rect");
  const lines = text.split(/\r?\n/).map(function (v) { return v.trim(); }).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  const parts = last.split(",").map(function (v) { return Number(v); });
  if (parts.length < 10 || parts.some(function (v) { return Number.isNaN(v); })) {
    throw new Error("无法解析窗口位置: " + last);
  }
  return {
    windowRect: { left: parts[0], top: parts[1], width: parts[2], height: parts[3] },
    visibleRect: { x: parts[4], y: parts[5], width: parts[6], height: parts[7] },
    visible: !!parts[8],
    minimized: !!parts[9]
  };
}

module.exports = { getWindowInfo, hwndFromSourceId };
