"use strict";
// 在 github.com 直连不通的机器上，用 GitHub REST API 把本地提交推送到远程 main。
// 依赖 GH_TOKEN（或从 git credential fill 读取）。只推送本地 HEAD 相对远程 HEAD 的差异文件。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = process.env.GH_OWNER || "UesugiEri-1";
const REPO = process.env.GH_REPO || "NovaRec";
const BRANCH = process.env.GH_BRANCH || "main";
const API = "https://api.github.com";
const DRY = process.argv.indexOf("--dry") >= 0;

function log(s) { console.log("[" + new Date().toISOString() + "] " + s); }
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}
function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", cwd: ROOT, windowsHide: true
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error("未取到 GitHub token");
  return m[1].trim();
}
const TOKEN = token();
async function api(method, url, body) {
  const headers = {
    Authorization: "token " + TOKEN,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "novarec-push"
  };
  let payload;
  if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 800) }; }
  if (!res.ok) log("API " + method + " " + url.replace(API, "") + " -> " + res.status + " " + JSON.stringify(data).slice(0, 500));
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  const localHead = git(["rev-parse", "HEAD"]);
  const localParent = git(["rev-parse", "HEAD^"]);
  const subject = git(["log", "-1", "--pretty=%B"]);
  log("本地 HEAD " + localHead.slice(0, 10) + " 父提交 " + localParent.slice(0, 10));

  const ref = await api("GET", API + "/repos/" + OWNER + "/" + REPO + "/git/ref/heads/" + BRANCH);
  if (!ref.ok) throw new Error("读取远程分支失败 " + ref.status);
  const remoteHead = ref.data.object.sha;
  log("远程 " + BRANCH + " = " + remoteHead.slice(0, 10));
  if (remoteHead === localHead) { log("远程已是最新，无需推送"); return; }

  let baseTree = null;
  if (remoteHead === localParent) {
    const rc = await api("GET", API + "/repos/" + OWNER + "/" + REPO + "/git/commits/" + remoteHead);
    if (!rc.ok) throw new Error("读取远程提交失败");
    baseTree = rc.data.tree.sha;
    log("父提交一致，增量推送（base_tree=" + baseTree.slice(0, 10) + "）");
  } else {
    log("父提交不一致（远程可能被 rebase/覆盖），改为全量树推送");
  }

  const diffArgs = baseTree
    ? ["diff", "--name-status", "-z", remoteHead, localHead]
    : ["ls-tree", "-r", "-z", "--full-tree", localHead];
  const out = execFileSync("git", diffArgs, { cwd: ROOT, encoding: "buffer", windowsHide: true });
  const fields = out.toString("utf8").split("\0");
  const entries = [];
  const deletes = [];
  let i = 0;
  if (baseTree) {
    while (i < fields.length) {
      const st = fields[i];
      if (!st) { i++; continue; }
      const file = fields[i + 1];
      i += 2;
      if (st[0] === "D") { deletes.push(file); continue; }
      entries.push({ file: file, mode: st[0] === "A" ? "100644" : "100644" });
    }
  } else {
    while (i < fields.length) {
      const rec = fields[i];
      if (!rec) { i++; continue; }
      const m = rec.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s);
      i++;
      if (!m) continue;
      entries.push({ file: m[4], mode: m[1] === "100755" ? "100755" : "100644", sha: m[3] });
    }
  }
  log("待上传文件 " + entries.length + " 个" + (deletes.length ? "，删除 " + deletes.length + " 个" : ""));

  const tree = [];
  for (const e of entries) {
    const abs = path.join(ROOT, e.file);
    if (!fs.existsSync(abs)) { log("跳过不存在的文件 " + e.file); continue; }
    const buf = fs.readFileSync(abs);
    const blob = await api("POST", API + "/repos/" + OWNER + "/" + REPO + "/git/blobs", {
      content: buf.toString("base64"), encoding: "base64"
    });
    if (!blob.ok) throw new Error("上传 blob 失败 " + e.file);
    tree.push({ path: e.file, mode: e.mode, type: "blob", sha: blob.data.sha });
    log("blob " + e.file + " " + buf.length + "B -> " + blob.data.sha.slice(0, 8));
  }
  for (const d of deletes) tree.push({ path: d, mode: "100644", type: "blob", sha: null });

  const treeBody = { tree: tree };
  if (baseTree) treeBody.base_tree = baseTree;
  else treeBody.tree = tree;
  const newTree = await api("POST", API + "/repos/" + OWNER + "/" + REPO + "/git/trees", treeBody);
  if (!newTree.ok) throw new Error("创建 tree 失败");
  log("新 tree " + newTree.data.sha.slice(0, 10));

  const commit = await api("POST", API + "/repos/" + OWNER + "/" + REPO + "/git/commits", {
    message: subject, tree: newTree.data.sha, parents: [remoteHead]
  });
  if (!commit.ok) throw new Error("创建 commit 失败");
  log("远程 commit " + commit.data.sha.slice(0, 10));

  if (DRY) { log("dry: 不更新 ref"); return; }
  const upd = await api("PATCH", API + "/repos/" + OWNER + "/" + REPO + "/git/refs/heads/" + BRANCH, {
    sha: commit.data.sha, force: baseTree ? false : true
  });
  if (!upd.ok) throw new Error("更新分支失败 " + upd.status);
  log("已推送 " + BRANCH + " -> " + commit.data.sha.slice(0, 10));
}

main().catch(function (e) { log("FAIL " + (e && e.message ? e.message : e)); process.exit(1); });
