"use strict";
// 创建 GitHub Release 并上传三件产物（github.com 直连可用 api.github.com 时使用）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OWNER = process.env.GH_OWNER || "UesugiEri-1";
const REPO = process.env.GH_REPO || "NovaRec";
const TAG = process.env.REL_TAG || "v1.1.1";
const API = "https://api.github.com";
const TOKEN = (process.env.GH_TOKEN || "").trim();
if (!TOKEN) { console.error("缺少 GH_TOKEN"); process.exit(2); }
const DIR = "D:\\Workplace\\deliverables\\novarec-v1.1.1";
const FILES = [
  "NovaRec-Setup-1.1.1-x64.exe",
  "NovaRec-Portable-1.1.1-x64.exe",
  "NovaRec-1.1.1-win32-x64.zip",
  "SHA256SUMS.txt",
  "使用说明.md"
];
const log = (s) => console.log("[" + new Date().toISOString().slice(11, 19) + "] " + s);

const BODY = [
  "NovaRec v1.1.1 —— 兼容性修复版（功能与体积同 1.1.0）",
  "",
  "## 本版修复",
  "- 修复部分 Windows 机器上双击后没有反应（Chromium 沙箱在 JS 起来之前就崩溃，退出码 0x80000003）：发布产物改为「启动器 + 应用」双文件结构，NovaRec.exe（C# 启动器，115,712 B）负责带必要参数启动同目录的 NovaRecApp.exe，双击/快捷方式照常使用，无需手动加参数",
  "- 安装包在「未签名程序禁止写 C 盘」的机器上装不上：安装器 .onInit 探测可写性，不可写时自动回退到 D:\\NovaRec",
  "- 保存目录、用户数据目录增加写入探测兜底，避免默认目录不可写导致起不来/录不了",
  "- 自动更新：安装更新包后退出前等待 1.5 秒，避免覆盖文件失败",
  "",
  "## 体积（对比 v1.0.0）",
  "| 产物 | v1.1.1 | v1.0.0 |",
  "| --- | --- | --- |",
  "| 安装包 | 97.1 MB | 122 MB |",
  "| 单文件便携版 | 96.7 MB | — |",
  "| 便携 zip | 136 MB | 173 MB |",
  "| 解压后 | 285 MB（20 个文件） | 421 MB（86 个文件） |",
  "",
  "## 下载怎么选",
  "- **NovaRec-Portable-1.1.1-x64.exe**（推荐先试）：单文件便携版，双击后首次解压 10–30 秒出窗口，不写注册表，删除即卸载。",
  "- **NovaRec-Setup-1.1.1-x64.exe**：常规安装包，支持仅为当前用户安装（免管理员）。",
  "- **NovaRec-1.1.1-win32-x64.zip**：解压后双击 NovaRec.exe 运行。",
  "",
  "未签名程序首次运行可能触发 SmartScreen，点「更多信息 → 仍要运行」即可。",
  "",
  "## 校验值（SHA256）",
  "见下方 SHA256SUMS.txt。",
  "",
  "仓库：https://github.com/UesugiEri-1/NovaRec"
].join("\n");

async function api(method, url, body, binary) {
  const headers = {
    Authorization: "token " + TOKEN,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "novarec-release"
  };
  let payload;
  if (binary) { headers["Content-Type"] = "application/octet-stream"; payload = binary; }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(600000) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 500) }; }
  return { status: res.status, ok: res.ok, data };
}

function sha256(p) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

async function uploadAsset(uploadUrl, file) {
  const abs = path.join(DIR, file);
  const size = fs.statSync(abs).size;
  const base = uploadUrl.replace("{?name,label}", "");
  const url = base + "?name=" + encodeURIComponent(file);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const t0 = Date.now();
    try {
      log("上传 " + file + " (" + (size / 1048576).toFixed(1) + " MB) 第 " + attempt + " 次");
      const body = fs.createReadStream(abs);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "token " + TOKEN,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "User-Agent": "novarec-release"
        },
        body,
        duplex: "half",
        signal: AbortSignal.timeout(900000)
      });
      const text = await res.text();
      let data = null; try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 300) }; }
      if (res.ok) { log("  成功 " + ((Date.now() - t0) / 1000).toFixed(1) + "s " + (data.browser_download_url || "")); return true; }
      log("  失败 " + res.status + " " + JSON.stringify(data).slice(0, 300));
      if (res.status === 422 && JSON.stringify(data).includes("already_exists")) { log("  资产已存在"); return true; }
    } catch (e) {
      log("  异常 " + (e && e.message));
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  return false;
}

async function main() {
  const me = await api("GET", API + "/repos/" + OWNER + "/" + REPO);
  if (!me.ok) throw new Error("读取仓库失败 " + me.status);
  log("仓库 " + me.data.full_name + " 权限=" + (me.data.permissions && JSON.stringify(me.data.permissions)));
  if (me.data.permissions && me.data.permissions.push === false) log("警告：token 可能没有写权限");

  let rel = null;
  const existing = await api("GET", API + "/repos/" + OWNER + "/" + REPO + "/releases/tags/" + TAG);
  if (existing.ok) { rel = existing.data; log("Release 已存在 id=" + rel.id + "，复用"); }
  else {
    const body = {
      tag_name: TAG,
      target_commitish: "main",
      name: "NovaRec " + TAG + " · 兼容性修复 + 体积优化",
      body: BODY,
      draft: false,
      prerelease: false
    };
    const created = await api("POST", API + "/repos/" + OWNER + "/" + REPO + "/releases", body);
    if (!created.ok) throw new Error("创建 Release 失败 " + created.status + " " + JSON.stringify(created.data).slice(0, 300));
    rel = created.data;
    log("Release 已创建 id=" + rel.id + " html=" + rel.html_url);
  }
  const have = new Set((rel.assets || []).map((a) => a.name));
  for (const f of FILES) {
    if (have.has(f)) { log("已存在跳过 " + f); continue; }
    const ok = await uploadAsset(rel.upload_url, f);
    if (!ok) { log("!! 上传失败 " + f); }
  }
  const after = await api("GET", API + "/repos/" + OWNER + "/" + REPO + "/releases/tags/" + TAG);
  if (after.ok) {
    log("Release 资产列表：");
    (after.data.assets || []).forEach((a) => log("  " + a.name + " " + a.size + "B state=" + a.state));
    log("下载页 " + after.data.html_url);
  }
}
main().catch((e) => { console.error("FAIL " + (e && e.stack || e)); process.exit(1); });
