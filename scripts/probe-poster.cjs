// 探针：全屏/窗口模式能否在不播放 <video> 的情况下拿到尺寸与封面（ImageCapture / 暂停的 video）
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "artifacts", "probe-poster");
fs.mkdirSync(OUT, { recursive: true });
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.setPath("userData", path.join(OUT, "userData"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "probe-poster.html"));
  const code = `(async () => {
    const out = {};
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: "screen:0:0", maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } }, audio: false });
      out.gotStream = true;
      const track = s.getVideoTracks()[0];
      out.settings = track.getSettings ? track.getSettings() : null;
      out.hasImageCapture = typeof ImageCapture !== "undefined";
      if (typeof ImageCapture !== "undefined") {
        try {
          const ic = new ImageCapture(track);
          const bmp = await ic.grabFrame();
          out.grabFrame = { width: bmp.width, height: bmp.height };
          const c = document.createElement("canvas"); c.width = 480; c.height = Math.round(480 * bmp.height / bmp.width);
          const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0, c.width, c.height);
          out.posterLen = c.toDataURL("image/jpeg", 0.82).length;
        } catch (e) { out.grabError = String((e && e.message) || e); }
      }
      const v = document.createElement("video"); v.muted = true; v.srcObject = new MediaStream([track]);
      out.dimsWithoutPlay = await new Promise(function (r) {
        var t = setTimeout(function () { r("timeout"); }, 3000);
        v.onloadedmetadata = function () { clearTimeout(t); r([v.videoWidth, v.videoHeight]); };
      });
      s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    } catch (e) { out.error = String((e && e.message) || e); }
    return out;
  })()`;
  const res = await win.webContents.executeJavaScript(code, true).catch(function (e) { return { err: String((e && e.message) || e) }; });
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(res, null, 2));
  console.log("RESULT " + JSON.stringify(res));
  app.exit(0);
});