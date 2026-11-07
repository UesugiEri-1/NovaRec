// 桌面采集探针：验证 DXGI duplication 在隐藏窗口里能否稳定出帧（连续两次会话）
const { app, BrowserWindow, desktopCapturer, powerSaveBlocker } = require("electron");
const path = require("node:path");
app.commandLine.appendSwitch("no-sandbox");
// 与主应用 main.js 一致：禁用窗口遮挡检测，否则被其它窗口遮住的动画窗口 rAF 会被节流到 1fps，
// 导致桌面本身几乎不更新，桌面采集自然只有 ~1fps（这是测试环境的假故障，不是采集能力问题）。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.setPath("userData", path.join(__dirname, "..", "artifacts", "probe-screen2-data"));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  const psb = powerSaveBlocker.start("prevent-display-sleep");
  log("powerSaveBlocker started id=" + psb + " isStarted=" + powerSaveBlocker.isStarted(psb));
  await sleep(2500);
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    log("sources", JSON.stringify(sources.map(s => ({ id: s.id, name: s.name, display_id: s.display_id }))));
    const screenId = sources[0] && sources[0].id;
    if (!screenId) { log("NO SCREEN SOURCE"); app.exit(2); return; }
    const demo = new BrowserWindow({ width: 520, height: 380, x: 40, y: 40, frame: false, show: true, alwaysOnTop: true, backgroundColor: "#101828", webPreferences: { backgroundThrottling: false } });
    await demo.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<body style='margin:0;background:#101828;overflow:hidden'><canvas id=c width=520 height=380></canvas><script>var v=document.getElementById('c'),x=v.getContext('2d'),t=0;window.__raf=0;function f(){t+=0.08;window.__raf++;x.fillStyle='hsl('+((t*30)%360)+',70%,40%)';x.fillRect(0,0,520,380);x.fillStyle='#fff';x.font='bold 28px sans-serif';x.fillText('DESKTOP ANIM '+Math.floor(t*10),40,60);requestAnimationFrame(f)}f();<\/script></body>"));
    demo.setAlwaysOnTop(true, "screen-saver");
    await sleep(800);
    const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadFile(path.join(__dirname, "probe-screen2.html"));
    await sleep(600);

    async function runOne(label, seconds) {
      const js = "window.__run(" + JSON.stringify(screenId) + ", " + seconds + ")";
      const t0 = Date.now();
      const res = await win.webContents.executeJavaScript(js, true);
      if (res && res.shot && res.shot.indexOf("data:image/png;base64,") === 0) {
        const dir = path.join(__dirname, "..", "artifacts", "probe-screen2");
        require("node:fs").mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, label + ".png");
        require("node:fs").writeFileSync(fp, Buffer.from(res.shot.slice("data:image/png;base64,".length), "base64"));
        res.shotPath = fp;
        delete res.shot;
      }
      log(label, "tookMs=" + (Date.now() - t0), JSON.stringify(res));
      return res;
    }

    const SESSIONS = Math.max(1, parseInt(process.env.PROBE_SESSIONS || "3", 10));
    const results = [];
    for (let i = 1; i <= SESSIONS; i++) {
      const before = await demo.webContents.executeJavaScript("window.__raf||0", true).catch(function(){return -1;});
      const res = await runOne("capture-" + i, 3);
      const after = await demo.webContents.executeJavaScript("window.__raf||0", true).catch(function(){return -1;});
      res.demoRafDuring = after - before;
      log("capture-" + i + " demoRafDelta=" + (after - before));
      results.push(res);
      if (i < SESSIONS) await sleep(parseInt(process.env.PROBE_GAP || "1200", 10));
    }
    log("SUMMARY", JSON.stringify(results));
    app.exit(0);
  } catch (e) { log("FATAL", String(e && e.stack || e)); app.exit(3); }
});
