/* =========================================================
   NovaRec · 渲染进程交互逻辑
   结构：工具函数 / Mock API / 全局状态 / 页面渲染 / 事件绑定
   ========================================================= */

(function () {
  'use strict';

  /* ---------------- 基础常量 ---------------- */

  var DEFAULT_SETTINGS = {
    outputDir: '',
    format: 'mp4',
    fps: 30,
    quality: 'high',
    systemAudio: true,
    microphone: false,
    micDeviceId: 'default',
    countdown: 3,
    hideMainWindow: true,
    showCursor: true,
    performanceMode: 'auto'
  };

  var PERF_LABEL = '720p · 30fps · 约 4.5 Mbps';

  var PAGE_META = {
    record: { title: '录制', icon: 'record' },
    library: { title: '素材库', icon: 'library' },
    settings: { title: '设置', icon: 'settings' }
  };

  var MODE_META = {
    screen: { title: '选择屏幕', icon: 'monitor', tag: '全屏' },
    region: { title: '选择区域', icon: 'crop', tag: '区域' },
    window: { title: '选择窗口', icon: 'window', tag: '窗口' }
  };

  var AUTO_JUMP_TO_LIBRARY = true;

  /* ---------------- 工具函数 ---------------- */

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function icon(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function clone(value) {
    if (value === undefined || value === null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (err) { return value; }
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var ctx = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function fmtDuration(ms) {
    var total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
    return pad2(m) + ':' + pad2(s);
  }

  function fmtSize(bytes) {
    var size = Number(bytes) || 0;
    if (size <= 0) return '0 B';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(0) + ' KB';
    if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
    return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function fmtDateTime(ts) {
    var date = new Date(Number(ts) || Date.now());
    if (isNaN(date.getTime())) return '—';
    var now = new Date();
    var sameDay = date.toDateString() === now.toDateString();
    var yesterday = new Date(now.getTime() - 86400000);
    var time = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    if (sameDay) return '今天 ' + time;
    if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + time;
    if (date.getFullYear() === now.getFullYear()) return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + time;
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + time;
  }

  function fmtResolution(width, height) {
    if (!width || !height) return '—';
    return width + ' × ' + height;
  }

  /* 路径过长时省略中段，便于同时看清盘符与末级目录 */
  function midTruncate(text, max) {
    var value = String(text || '');
    var limit = max || 42;
    if (value.length <= limit) return value;
    var head = Math.ceil((limit - 1) / 2);
    var tail = limit - 1 - head;
    return value.slice(0, head) + '…' + value.slice(value.length - tail);
  }

  function setHidden(el, hidden) {
    if (el) el.hidden = !!hidden;
  }

  /* 重新触发一次 CSS 动画（倒计时数字跳动等） */
  function replayAnimation(el) {
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }

  /* =========================================================
     Mock API：浏览器直接打开 index.html 时的完整模拟实现
     - 全部返回 Promise，结构与 ipc-contract.md 一致
     - 录制流程用 setTimeout 模拟 countdown -> recording -> processing
     ========================================================= */

  function createMock() {
    var HOME_DIR = 'D:\\Videos\\NovaRec';
    var ALT_DIR = 'E:\\ScreenRecords\\NovaRec';

    var listeners = { settings: [], state: [], saved: [], error: [], toast: [], maximized: [] };
    var timers = [];
    var maximized = false;
    var region = null;
    var session = null;

    var settings = {
      outputDir: HOME_DIR,
      format: 'mp4',
      fps: 30,
      quality: 'high',
      systemAudio: true,
      microphone: false,
      micDeviceId: 'default',
      countdown: 3,
      hideMainWindow: true,
      showCursor: true,
      performanceMode: 'auto'
    };

    var recState = { state: 'idle', elapsedMs: 0 };

    /* ---- Canvas 生成缩略图（深色渐变 + 网格 + 文案） ---- */

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawGrid(ctx, w, h, step, alpha) {
      ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.lineWidth = 1;
      for (var x = step; x < w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (var y = step; y < h; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    function makeCanvas(draw) {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 270;
        var ctx = canvas.getContext('2d');
        if (!ctx) return '';
        draw(ctx, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
      } catch (err) {
        return '';
      }
    }

    function paintBg(ctx, w, h, from, to) {
      var gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, from);
      gradient.addColorStop(1, to);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    }

    function drawLabel(ctx, w, h, title, subtitle) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232,236,243,.92)';
      ctx.font = '600 20px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      ctx.fillText(title, w / 2, h / 2 + 10);
      ctx.fillStyle = 'rgba(154,164,184,.85)';
      ctx.font = '400 13px "Segoe UI", "Microsoft YaHei UI", sans-serif';
      ctx.fillText(subtitle, w / 2, h / 2 + 34);
    }

    function makeScreenThumb(name, resolution) {
      return makeCanvas(function (ctx, w, h) {
        paintBg(ctx, w, h, '#1d2434', '#0f131b');
        drawGrid(ctx, w, h, 40, .05);
        /* 桌面窗口 */
        ctx.fillStyle = 'rgba(30,37,50,.95)';
        roundRect(ctx, 54, 46, 250, 150, 8);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.09)';
        ctx.stroke();
        ctx.fillStyle = 'rgba(99,102,241,.32)';
        roundRect(ctx, 54, 46, 250, 22, 8);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.16)';
        roundRect(ctx, 214, 90, 180, 120, 8);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.08)';
        ctx.stroke();
        /* 任务栏 */
        ctx.fillStyle = 'rgba(10,13,18,.72)';
        ctx.fillRect(0, h - 28, w, 28);
        ctx.fillStyle = 'rgba(99,102,241,.75)';
        roundRect(ctx, 12, h - 23, 18, 18, 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.20)';
        roundRect(ctx, 38, h - 23, 18, 18, 4);
        ctx.fill();
        drawLabel(ctx, w, h, name, resolution);
      });
    }

    function makeWindowThumb(title, appName, accent) {
      return makeCanvas(function (ctx, w, h) {
        paintBg(ctx, w, h, '#171d29', '#0e121a');
        drawGrid(ctx, w, h, 44, .04);
        /* 应用窗口 */
        ctx.fillStyle = 'rgba(28,34,46,.96)';
        roundRect(ctx, 26, 24, 300, 214, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.1)';
        ctx.stroke();
        ctx.fillStyle = accent;
        roundRect(ctx, 26, 24, 300, 26, 10);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.22)';
        ctx.beginPath();
        ctx.arc(196, 37, 3, 0, Math.PI * 2);
        ctx.arc(208, 37, 3, 0, Math.PI * 2);
        ctx.arc(220, 37, 3, 0, Math.PI * 2);
        ctx.fill();
        /* 内容行 */
        ctx.fillStyle = 'rgba(255,255,255,.13)';
        for (var i = 0; i < 5; i++) {
          roundRect(ctx, 44, 66 + i * 24, 200 - (i % 3) * 26, 9, 4);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(99,102,241,.45)';
        roundRect(ctx, 262, 62, 48, 148, 8);
        ctx.fill();
        /* 应用名 */
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(232,236,243,.9)';
        ctx.font = '600 15px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        ctx.fillText(appName || title, 26, 258);
        ctx.fillStyle = 'rgba(154,164,184,.75)';
        ctx.font = '400 11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        ctx.fillText(title, 26, 272);
      });
    }

    function makePoster(mode, width, height, durationMs) {
      return makeCanvas(function (ctx, w, h) {
        paintBg(ctx, w, h, '#1C2421', '#0B0F0D');
        var glow = ctx.createRadialGradient(w * .3, h * .2, 10, w * .3, h * .2, w * .7);
        glow.addColorStop(0, 'rgba(23,162,75,.28)');
        glow.addColorStop(1, 'rgba(23,162,75,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        drawGrid(ctx, w, h, 36, .05);
        /* 播放按钮 */
        ctx.strokeStyle = 'rgba(255,255,255,.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2 - 6, 30, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.82)';
        ctx.beginPath();
        ctx.moveTo(w / 2 - 8, h / 2 - 22);
        ctx.lineTo(w / 2 + 14, h / 2 - 6);
        ctx.lineTo(w / 2 - 8, h / 2 + 10);
        ctx.closePath();
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(232,236,243,.92)';
        ctx.font = '600 14px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        ctx.fillText('NovaRec · ' + (mode === 'region' ? '区域录制' : mode === 'window' ? '窗口录制' : '屏幕录制'), w / 2, h - 46);
        ctx.fillStyle = 'rgba(154,164,184,.8)';
        ctx.font = '400 11px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        ctx.fillText(width + ' × ' + height + '  ·  ' + fmtDuration(durationMs), w / 2, h - 26);
      });
    }

    function makeAppIcon(letter, color) {
      return makeCanvas(function (ctx, w, h) {
        var gradient = ctx.createLinearGradient(0, 0, w, h);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, '#0E1214');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        ctx.font = '700 26px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(letter, w / 2, h / 2 + 9);
      });
    }

    var screens = [{
      id: 'screen:0',
      name: '整个屏幕',
      displayId: 0,
      isScreen: true,
      thumbnailDataUrl: makeScreenThumb('整个屏幕', '1920 × 1080')
    }];

    var windowSeeds = [
      { title: 'NovaRec 项目 - Visual Studio Code', appName: 'Visual Studio Code', accent: 'rgba(56,74,96,.55)', letter: 'V', color: '#384A60' },
      { title: 'NovaRec 界面稿 - Figma', appName: 'Figma', accent: 'rgba(74,63,88,.5)', letter: 'F', color: '#4A3F58' },
      { title: '产品需求文档 - Google Chrome', appName: 'Google Chrome', accent: 'rgba(58,74,66,.5)', letter: 'C', color: '#3A4A42' },
      { title: 'Windows PowerShell', appName: 'Windows Terminal', accent: 'rgba(58,64,72,.5)', letter: '>', color: '#3A4048' },
      { title: '团队周会 - 腾讯会议', appName: '腾讯会议', accent: 'rgba(57,73,85,.5)', letter: '会', color: '#394955' },
      { title: '设置', appName: 'Windows 设置', accent: 'rgba(74,63,69,.5)', letter: '设', color: '#4A3F45' }
    ];

    var windows = windowSeeds.map(function (seed, index) {
      return {
        id: 'window:' + (100 + index),
        name: seed.title,
        appName: seed.appName,
        isScreen: false,
        thumbnailDataUrl: makeWindowThumb(seed.title, seed.appName, seed.accent),
        appIconDataUrl: makeAppIcon(seed.letter, seed.color)
      };
    });

    var now = Date.now();
    var recordings = [
      {
        id: 'rec-demo-1',
        filePath: HOME_DIR + '\\NovaRec_2026-10-30_15-24-08.mp4',
        fileName: 'NovaRec_2026-10-30_15-24-08.mp4',
        format: 'mp4',
        mode: 'screen',
        width: 1920,
        height: 1080,
        fps: 60,
        durationMs: 764000,
        sizeBytes: 184 * 1024 * 1024,
        hasAudio: true,
        hasMic: false,
        createdAt: now - 1000 * 60 * 60 * 26,
        posterDataUrl: makePoster('screen', 1920, 1080, 764000)
      },
      {
        id: 'rec-demo-2',
        filePath: HOME_DIR + '\\NovaRec_2026-10-29_10-12-41.webm',
        fileName: 'NovaRec_2026-10-29_10-12-41.webm',
        format: 'webm',
        mode: 'region',
        width: 1280,
        height: 720,
        fps: 30,
        durationMs: 193000,
        sizeBytes: 42 * 1024 * 1024,
        hasAudio: true,
        hasMic: true,
        createdAt: now - 1000 * 60 * 60 * 55,
        posterDataUrl: makePoster('region', 1280, 720, 193000)
      }
    ];

    /* ---- 事件与状态 ---- */

    function emit(type, payload) {
      var list = listeners[type] || [];
      list.slice().forEach(function (cb) {
        try { cb(clone(payload)); } catch (err) { console.error('[mock] listener error', err); }
      });
    }

    function on(type, cb) {
      if (typeof cb !== 'function') return function () {};
      listeners[type].push(cb);
      return function () {
        var index = listeners[type].indexOf(cb);
        if (index >= 0) listeners[type].splice(index, 1);
      };
    }

    function clearTimers() {
      timers.forEach(function (id) { clearInterval(id); clearTimeout(id); });
      timers = [];
    }

    function pushTimer(id) {
      timers.push(id);
      return id;
    }

    function setState(patch) {
      recState = Object.assign({}, recState, patch);
      emit('state', recState);
    }

    function sourceNameOf(req) {
      if (req.mode === 'screen') {
        var screen = screens.filter(function (item) { return item.id === req.sourceId; })[0] || screens[0];
        return screen ? screen.name : '整个屏幕';
      }
      if (req.mode === 'window') {
        var win = windows.filter(function (item) { return item.id === req.sourceId; })[0];
        return win ? (win.appName ? win.appName + ' · ' : '') + win.name : '应用窗口';
      }
      if (region) return '自定义区域 ' + region.width + ' × ' + region.height;
      return '自定义区域';
    }

    function beginCapture() {
      clearTimers();
      var startAt = Date.now();
      session.startedAt = startAt;
      session.accumulated = 0;
      recState = {
        state: 'recording',
        mode: session.req.mode,
        sourceName: session.sourceName,
        startedAt: startAt,
        elapsedMs: 0
      };
      emit('state', clone(recState));
      pushTimer(setInterval(function () {
        if (recState.state !== 'recording') return;
        recState.elapsedMs = Date.now() - session.startedAt - session.accumulated;
        emit('state', clone(recState));
      }, 250));
    }

    function startRecording(req) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (!req || !req.mode) {
            resolve({ ok: false, error: '录制参数无效' });
            return;
          }
          if (req.mode === 'region' && !region) {
            resolve({ ok: false, error: '请先框选录制区域' });
            return;
          }
          var sourceName = sourceNameOf(req);
          session = { req: req, sourceName: sourceName, startedAt: 0, accumulated: 0 };
          var countdown = Number(req.countdown) || 0;
          if (countdown > 0) {
            var left = countdown;
            recState = { state: 'countdown', mode: req.mode, sourceName: sourceName, countdownLeft: left, elapsedMs: 0 };
            emit('state', clone(recState));
            pushTimer(setInterval(function () {
              left -= 1;
              if (left <= 0) {
                clearTimers();
                beginCapture();
              } else {
                recState.countdownLeft = left;
                emit('state', clone(recState));
              }
            }, 1000));
          } else {
            beginCapture();
          }
          resolve({ ok: true, sessionId: 'mock-session-' + Date.now() });
        }, 280);
      });
    }

    function stopRecording() {
      return new Promise(function (resolve) {
        if (!session || (recState.state !== 'recording' && recState.state !== 'paused')) {
          if (recState.state === 'countdown') {
            clearTimers();
            session = null;
            setState({ state: 'idle', elapsedMs: 0 });
            resolve({ ok: true, cancelled: true });
            return;
          }
          resolve({ ok: false, error: '当前没有正在进行的录制' });
          return;
        }
        clearTimers();
        var durationMs = recState.elapsedMs || 0;
        var req = session.req;
        var startedAt = session.startedAt;
        setState({ state: 'processing', elapsedMs: durationMs });
        setTimeout(function () {
          var date = new Date();
          var stamp = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
            '_' + pad2(date.getHours()) + '-' + pad2(date.getMinutes()) + '-' + pad2(date.getSeconds());
          var ext = req.format || settings.format || 'mp4';
          var fileName = 'NovaRec_' + stamp + '.' + ext;
          var width = 1920;
          var height = 1080;
          if (req.mode === 'region' && region) { width = region.width; height = region.height; }
          if (req.mode === 'window') { width = 1600; height = 900; }
          var item = {
            id: 'rec-' + Date.now(),
            filePath: settings.outputDir + '\\' + fileName,
            fileName: fileName,
            format: ext,
            mode: req.mode,
            width: width,
            height: height,
            fps: req.fps || settings.fps,
            durationMs: durationMs,
            sizeBytes: Math.max(320 * 1024, Math.round((durationMs / 1000) * 1.35 * 1024 * 1024)),
            hasAudio: !!req.systemAudio,
            hasMic: !!req.microphone,
            createdAt: Date.now(),
            posterDataUrl: makePoster(req.mode, width, height, durationMs)
          };
          session = null;
          recordings.unshift(item);
          setState({ state: 'idle', elapsedMs: 0 });
          emit('saved', item);
          resolve({ ok: true, item: item });
        }, 900);
        void startedAt;
      });
    }

    function togglePause() {
      return new Promise(function (resolve) {
        if (!session || recState.state === 'countdown') {
          resolve({ paused: false });
          return;
        }
        if (recState.state === 'recording') {
          session.accumulated += Date.now() - session.startedAt;
          recState.elapsedMs = session.accumulated;
          setState({ state: 'paused' });
          resolve({ paused: true });
          return;
        }
        if (recState.state === 'paused') {
          session.startedAt = Date.now();
          setState({ state: 'recording' });
          resolve({ paused: false });
          return;
        }
        resolve({ paused: false });
      });
    }

    function chooseOutputDir() {
      return new Promise(function (resolve) {
        setTimeout(function () {
          settings = Object.assign({}, settings, {
            outputDir: settings.outputDir === HOME_DIR ? ALT_DIR : HOME_DIR
          });
          emit('settings', clone(settings));
          resolve(clone(settings));
        }, 320);
      });
    }

    var appInfo = {
      name: 'NovaRec',
      version: '1.0.0',
      electron: '45.2.1 (mock)',
      ffmpeg: true,
      hardware: { cores: 4, memGB: 13.9, lowEnd: true },
      performance: { mode: 'auto', enabled: true, label: '720p · 30fps · 约 4.5 Mbps', maxHeight: 720, fpsCap: 30 }
    };

    return {
      getSettings: function () { return Promise.resolve(clone(settings)); },
      setSettings: function (patch) {
        settings = Object.assign({}, settings, patch || {});
        setTimeout(function () { emit('settings', clone(settings)); }, 60);
        return Promise.resolve(clone(settings));
      },
      onSettingsChanged: function (cb) { return on('settings', cb); },
      chooseOutputDir: chooseOutputDir,
      openOutputDir: function () {
        emit('toast', { type: 'info', message: '（Mock）打开保存目录：' + settings.outputDir });
        return Promise.resolve(true);
      },
      getAppInfo: function () { return Promise.resolve(clone(appInfo)); },

      listSources: function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve({ screens: clone(screens), windows: clone(windows) });
          }, 380);
        });
      },
      getDisplayInfo: function () {
        return Promise.resolve(clone({
          displays: [{ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: true }],
          virtualBounds: { x: 0, y: 0, width: 1920, height: 1080 }
        }));
      },
      selectRegion: function () {
        return new Promise(function (resolve) {
          emit('toast', { type: 'info', message: '（Mock）正在框选区域…' });
          setTimeout(function () {
            region = { x: 160, y: 120, width: 1280, height: 720, displayId: 0 };
            resolve(clone(region));
          }, 720);
        });
      },
      hasRegion: function () { return region ? clone(region) : null; },

      startRecording: startRecording,
      stopRecording: stopRecording,
      togglePause: togglePause,
      getRecordingState: function () { return Promise.resolve(clone(recState)); },
      onRecordingState: function (cb) { return on('state', cb); },
      onRecordingSaved: function (cb) { return on('saved', cb); },
      onRecordingError: function (cb) { return on('error', cb); },
      onToast: function (cb) { return on('toast', cb); },

      listRecordings: function () {
        return new Promise(function (resolve) {
          setTimeout(function () {
            var sorted = recordings.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
            resolve(clone(sorted));
          }, 320);
        });
      },
      deleteRecording: function (id) {
        recordings = recordings.filter(function (item) { return item.id !== id; });
        return Promise.resolve(true);
      },
      revealRecording: function (id) {
        var item = recordings.filter(function (rec) { return rec.id === id; })[0];
        emit('toast', { type: 'info', message: '（Mock）在文件夹中显示：' + (item ? item.fileName : id) });
        return Promise.resolve(true);
      },
      openRecording: function (id) {
        var item = recordings.filter(function (rec) { return rec.id === id; })[0];
        emit('toast', { type: 'info', message: '（Mock）播放视频：' + (item ? item.fileName : id) });
        return Promise.resolve(true);
      },

      window: {
        minimize: function () {
          emit('toast', { type: 'info', message: '（Mock）最小化窗口' });
          return Promise.resolve(true);
        },
        toggleMaximize: function () {
          maximized = !maximized;
          emit('maximized', maximized);
          return Promise.resolve(maximized);
        },
        isMaximized: function () { return maximized; },
        onMaximizedChange: function (cb) { return on('maximized', cb); },
        close: function () {
          emit('toast', { type: 'info', message: '（Mock）关闭窗口（浏览器预览中不生效）' });
          return Promise.resolve(true);
        }
      }
    };
  }

  /* ---------------- API 统一入口 ---------------- */

  var NATIVE_API = (typeof window !== 'undefined' && window.novarec && typeof window.novarec.getSettings === 'function')
    ? window.novarec
    : null;

  // 截图/浏览器预览门控：?mock=1 或 window.__NOVAREC_FORCE_MOCK__ 强制走 Mock 数据
  var FORCE_MOCK = false;
  try {
    FORCE_MOCK = (typeof location !== 'undefined' && /(?:^\?|&)mock=1(?:&|$)/.test(location.search || ''))
      || (typeof window !== 'undefined' && window.__NOVAREC_FORCE_MOCK__ === true);
  } catch (e) { FORCE_MOCK = false; }
  var IS_MOCK = !NATIVE_API || FORCE_MOCK;
  var api = IS_MOCK ? createMock() : NATIVE_API;


  /* =========================================================
     全局状态与 DOM 缓存
     ========================================================= */

  var state = {
    page: 'record',
    mode: 'screen',
    settings: Object.assign({}, DEFAULT_SETTINGS),
    appInfo: null,
    display: null,

    screens: [],
    windows: [],
    selectedScreenId: null,
    selectedWindowId: null,
    windowFilter: '',
    sourcesLoading: false,
    sourcesLoaded: false,

    region: null,
    regionKnown: false,
    regionBusy: false,

    recording: { state: 'idle', elapsedMs: 0 },
    lastCountdown: null,
    startLoading: false,
    stopLoading: false,
    pauseLoading: false,

    recordings: [],
    libLoading: false,
    libLoaded: false,
    newRecordingId: null,
    confirmDeleteId: null,

    micDevices: [],
    micLabelAsked: false,

    initialized: false
  };

  var dom = {};
  var pendingPatch = {};

  function cacheDom() {
    dom.app = $('#app');
    dom.titlebar = $('#titlebar');
    dom.pageTitle = $('#pageTitle');
    dom.pageIcon = $('#pageIcon');
    dom.btnMinimize = $('#btnMinimize');
    dom.btnMaximize = $('#btnMaximize');
    dom.btnMaxIcon = $('#btnMaxIcon');
    dom.btnClose = $('#btnClose');
    dom.navItems = $$('.nav-item');
    dom.navBadge = $('#navBadge');
    dom.mockBadge = $('#mockBadge');
    dom.sidebarVersion = $('#sidebarVersion');
    dom.btnOpenDir = $('#btnOpenDir');
    dom.main = $('#main');
    dom.pages = $$('.page');
    dom.perfHint = $('#perfHint');
    dom.perfParamHint = $('#perfParamHint');
    dom.perfModeNote = $('#perfModeNote');
    dom.perfBadge = $('#perfBadge');
    dom.perfCardTip = $('#perfCardTip');
    dom.aboutHardware = $('#aboutHardware');
    dom.aboutPerf = $('#aboutPerf');

    dom.modeGrid = $('#modeGrid');
    dom.sourceTitle = $('#sourceTitle');
    dom.sourceCount = $('#sourceCount');
    dom.sourceActions = $('#sourceActions');
    dom.sourceBody = $('#sourceBody');

    dom.btnStart = $('#btnStart');
    dom.actionHint = $('#actionHint');
    dom.actionIdle = $('#actionIdle');
    dom.actionRecording = $('#actionRecording');
    dom.actionProcessing = $('#actionProcessing');
    dom.recTimer = $('#recTimer');
    dom.recSource = $('#recSource');
    dom.recStateTag = $('#recStateTag');
    dom.btnPause = $('#btnPause');
    dom.pauseIconUse = $('#pauseIconUse');
    dom.btnPauseLabel = $('#btnPauseLabel');
    dom.btnStop = $('#btnStop');

    dom.countdownOverlay = $('#countdownOverlay');
    dom.countdownNumber = $('#countdownNumber');
    dom.countdownSource = $('#countdownSource');

    dom.recGrid = $('#recGrid');
    dom.libSkeleton = $('#libSkeleton');
    dom.libEmpty = $('#libEmpty');
    dom.librarySub = $('#librarySub');
    dom.btnLibOpenDir = $('#btnLibOpenDir');
    dom.btnLibRefresh = $('#btnLibRefresh');
    dom.btnEmptyStart = $('#btnEmptyStart');

    dom.toastStack = $('#toastStack');
    dom.btnChangeDir = $('#btnChangeDir');
    dom.outputDirText = $('#outputDirText');
    dom.micDeviceSelect = $('#micDeviceSelect');
    dom.micDeviceNote = $('#micDeviceNote');
    dom.formatHint = $('#formatHint');

    dom.settingsDirText = $('#settingsDirText');
    dom.btnSettingsChangeDir = $('#btnSettingsChangeDir');
    dom.aboutAppName = $('#aboutAppName');
    dom.aboutVersion = $('#aboutVersion');
    dom.aboutElectron = $('#aboutElectron');
    dom.aboutFfmpeg = $('#aboutFfmpeg');
    dom.aboutOutputDir = $('#aboutOutputDir');
  }

  /* =========================================================
     Toast 通知
     ========================================================= */

  var TOAST_ICONS = { success: 'check-circle', error: 'x-circle', warning: 'alert', info: 'info' };
  var TOAST_LIMIT = 4;

  function pushToast(type, message) {
    if (!message) return;
    var tone = TOAST_ICONS[type] ? type : 'info';
    var node = document.createElement('div');
    node.className = 'toast toast-' + tone;
    node.setAttribute('role', 'status');
    node.innerHTML =
      icon(TOAST_ICONS[tone], 'toast-icon') +
      '<div class="toast-message">' + esc(message) + '</div>' +
      '<button type="button" class="toast-close" aria-label="关闭提示">' + icon('x') + '</button>' +
      '<div class="toast-progress"></div>';

    var closed = false;
    function dismiss() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }
    var timer = setTimeout(dismiss, 3400);

    node.querySelector('.toast-close').addEventListener('click', dismiss);
    dom.toastStack.appendChild(node);

    while (dom.toastStack.children.length > TOAST_LIMIT) {
      dom.toastStack.removeChild(dom.toastStack.firstChild);
    }
  }

  /* =========================================================
     设置：读取、渲染、防抖保存
     ========================================================= */

  function applySettings(next) {
    state.settings = Object.assign({}, DEFAULT_SETTINGS, next || {});
    renderSettingsControls();
  }

  function setSwitch(el, on) {
    if (!el) return;
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.classList.toggle('is-on', !!on);
  }

  function renderSettingsControls() {
    var settings = state.settings;

    $$('[data-setting]').forEach(function (control) {
      var key = control.getAttribute('data-setting');
      if (!(key in settings)) return;
      if (control.classList.contains('switch')) {
        setSwitch(control, !!settings[key]);
        return;
      }
      if (control.classList.contains('segmented')) {
        var current = String(settings[key]);
        $$('button[data-value]', control).forEach(function (btn) {
          var active = btn.getAttribute('data-value') === current;
          btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
      }
    });

    renderMicSelect();
    renderMicHint();
    renderOutputDir();
    renderFormatHint();
    renderPerfHint();
  }

  function renderOutputDir() {
    var dir = state.settings.outputDir || '—';
    if (dom.outputDirText) {
      dom.outputDirText.textContent = midTruncate(dir, 30);
      dom.outputDirText.title = dir;
    }
    if (dom.settingsDirText) {
      dom.settingsDirText.textContent = midTruncate(dir, 44);
      dom.settingsDirText.title = dir;
    }
    if (dom.aboutOutputDir) {
      dom.aboutOutputDir.textContent = midTruncate(dir, 40);
      dom.aboutOutputDir.title = dir;
    }
  }

  function renderFormatHint() {
    if (!dom.formatHint) return;
    dom.formatHint.textContent = state.settings.format === 'webm'
      ? 'WebM 体积更小，部分播放器需转码'
      : 'MP4 兼容性最好';
  }

  /* ---- 性能模式：自动/开启/关闭 + 低配判定（硬件信息来自主进程） ---- */

  function perfEnabledNow() {
    var mode = state.settings.performanceMode || 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    var hw = (state.appInfo && state.appInfo.hardware) || null;
    return !!(hw && hw.lowEnd);
  }

  function renderPerfHint() {
    var mode = state.settings.performanceMode || 'auto';
    var hw = (state.appInfo && state.appInfo.hardware) || null;
    var enabled = perfEnabledNow();
    var hwText = hw ? (hw.cores + ' 核 · 约 ' + hw.memGB + ' GB 内存') : '';
    var status = enabled ? '已启用' : (mode === 'off' ? '已关闭' : '自动 · 未触发');
    var hint;
    if (enabled) {
      hint = '已启用：采集上限 ' + PERF_LABEL + '，画质最高「标准」，占用更低' + (hwText ? '（本机 ' + hwText + '）' : '');
    } else if (mode === 'off') {
      hint = '已关闭：按当前分辨率、帧率与画质原样录制，老设备可能掉帧';
    } else {
      hint = hwText ? '本机 ' + hwText + '，配置足够，自动模式不做限制' : '正在读取硬件信息…';
    }
    if (dom.perfHint) dom.perfHint.textContent = hint;
    if (dom.perfParamHint) {
      dom.perfParamHint.textContent = enabled
        ? ('已启用 · ' + PERF_LABEL)
        : (mode === 'off' ? '已关闭 · 按原生画质录制' : '自动 · 本机未触发');
    }
    if (dom.perfModeNote) dom.perfModeNote.textContent = status;
    if (dom.perfBadge) {
      dom.perfBadge.className = 'badge ' + (enabled ? 'badge-ok' : 'badge-neutral');
      dom.perfBadge.textContent = status;
    }
    if (dom.perfCardTip) dom.perfCardTip.textContent = status;
    var root = document.documentElement;
    if (root && root.classList) root.classList.toggle('perf-lite', enabled);
  }

  function renderPerfAbout() {
    var hw = (state.appInfo && state.appInfo.hardware) || null;
    if (dom.aboutHardware) dom.aboutHardware.textContent = hw ? (hw.cores + ' 核 · ' + hw.memGB + ' GB') : '—';
    if (dom.aboutPerf) {
      var enabled = perfEnabledNow();
      dom.aboutPerf.className = 'badge ' + (enabled ? 'badge-ok' : 'badge-neutral');
      dom.aboutPerf.textContent = enabled ? '已启用' : (state.settings.performanceMode === 'off' ? '已关闭' : '自动 · 未触发');
    }
  }

  function commitSettings() {
    var patch = pendingPatch;
    pendingPatch = {};
    if (!Object.keys(patch).length) return;
    api.setSettings(patch).then(function (next) {
      if (next && typeof next === 'object') {
        state.settings = Object.assign({}, state.settings, next);
        renderSettingsControls();
      }
    }).catch(function (err) {
      pushToast('error', (err && err.message) || '保存设置失败');
    });
  }

  var scheduleSaveSettings = debounce(commitSettings, 300);

  function setSetting(key, value) {
    if (state.settings[key] === value) return;
    state.settings[key] = value;
    pendingPatch[key] = value;
    renderSettingsControls();
    updateStartAvailability();
    scheduleSaveSettings();
  }

  /* =========================================================
     麦克风设备枚举
     ========================================================= */

  function renderMicSelect() {
    var devices = state.micDevices || [];
    var current = state.settings.micDeviceId || 'default';
    var options = '<option value="default">默认麦克风</option>';
    var found = current === 'default';

    devices.forEach(function (device, index) {
      var label = device.label || ('麦克风 ' + (index + 1));
      if (device.deviceId === current) found = true;
      options += '<option value="' + esc(device.deviceId) + '">' + esc(label) + '</option>';
    });

    if (!found) options += '<option value="' + esc(current) + '">已保存的设备（当前不可用）</option>';

    $$('[data-mic-select]').forEach(function (select) {
      select.innerHTML = options;
      select.value = current;
      select.disabled = !state.settings.microphone;
      select.title = select.value === 'default' ? '系统默认输入设备' : '';
    });
  }

  function renderMicHint() {
    if (!dom.micDeviceNote) return;
    if (!state.settings.microphone) {
      dom.micDeviceNote.textContent = '开启麦克风后可选择';
      return;
    }
    if (!state.micDevices.length) {
      dom.micDeviceNote.textContent = '未检测到麦克风设备';
      return;
    }
    dom.micDeviceNote.textContent = '共 ' + state.micDevices.length + ' 个输入设备';
  }

  function collectMicDevices(devices) {
    state.micDevices = devices.filter(function (device) { return device.kind === 'audioinput'; });
    renderMicSelect();
    renderMicHint();
  }

  function refreshMicDevices() {
    var media = navigator.mediaDevices;
    if (!media || typeof media.enumerateDevices !== 'function') {
      state.micDevices = [];
      renderMicSelect();
      renderMicHint();
      return;
    }
    media.enumerateDevices().then(function (devices) {
      collectMicDevices(devices);
      var needLabels = state.micDevices.some(function (device) { return !device.label; });
      if (!needLabels || state.micLabelAsked) return;
      state.micLabelAsked = true;
      media.getUserMedia({ audio: true }).then(function (stream) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        setTimeout(function () {
          media.enumerateDevices().then(collectMicDevices).catch(function () {});
        }, 150);
      }).catch(function () {
        /* 用户拒绝授权时保留“麦克风 N”占位名，不影响录制 */
      });
    }).catch(function () {
      state.micDevices = [];
      renderMicSelect();
      renderMicHint();
    });
  }

  /* =========================================================
     显示信息 / 来源列表
     ========================================================= */

  function loadDisplayInfo() {
    if (!api.getDisplayInfo) return;
    Promise.resolve(api.getDisplayInfo()).then(function (info) {
      state.display = info || null;
      if (state.mode === 'region') renderSource();
    }).catch(function () { /* 区域说明为辅助信息，失败静默 */ });
  }

  function ensureSourceSelection() {
    if (!state.screens.some(function (item) { return item.id === state.selectedScreenId; })) {
      state.selectedScreenId = state.screens.length ? state.screens[0].id : null;
    }
    if (!state.windows.some(function (item) { return item.id === state.selectedWindowId; })) {
      state.selectedWindowId = state.windows.length ? state.windows[0].id : null;
    }
  }

  function selectedScreen() {
    return state.screens.filter(function (item) { return item.id === state.selectedScreenId; })[0] || state.screens[0] || null;
  }

  function selectedWindow() {
    return state.windows.filter(function (item) { return item.id === state.selectedWindowId; })[0] || state.windows[0] || null;
  }

  function loadSources(force) {
    if (state.sourcesLoading) return;
    if (state.sourcesLoaded && !force) {
      renderSource();
      return;
    }
    state.sourcesLoading = true;
    renderSource();
    Promise.resolve(api.listSources()).then(function (result) {
      state.screens = (result && result.screens) || [];
      state.windows = (result && result.windows) || [];
      state.sourcesLoaded = true;
      state.sourcesLoading = false;
      ensureSourceSelection();
      renderSource();
      updateStartAvailability();
    }).catch(function (err) {
      state.sourcesLoading = false;
      state.sourcesLoaded = false;
      state.screens = [];
      state.windows = [];
      renderSource();
      updateStartAvailability();
      pushToast('error', (err && err.message) || '获取录制来源失败');
    });
  }

  /* ---------------- 来源区渲染 ---------------- */

  function displayFor(source) {
    var displays = (state.display && state.display.displays) || [];
    if (!displays.length) return null;
    if (source && source.displayId != null) {
      var matched = displays.filter(function (item) { return item.id === source.displayId; })[0];
      if (matched) return matched;
    }
    return displays.filter(function (item) { return item.primary; })[0] || displays[0];
  }

  function screenResolution(source) {
    var display = displayFor(source);
    if (display && display.bounds) return fmtResolution(display.bounds.width, display.bounds.height);
    return '—';
  }

  function sourceEmptyHtml(iconName, title, desc, actionHtml) {
    return '<div class="source-empty">' +
      '<span class="source-empty-icon">' + icon(iconName) + '</span>' +
      '<span class="source-empty-title">' + esc(title) + '</span>' +
      '<span class="source-empty-desc">' + esc(desc) + '</span>' +
      (actionHtml || '') +
      '</div>';
  }

  function sourceSkeletonHtml(count) {
    var html = '<div class="source-skeleton">';
    for (var i = 0; i < (count || 2); i++) {
      html += '<div class="sk-source"><div class="sk-source-thumb"></div><div class="sk-source-line"></div></div>';
    }
    return html + '</div>';
  }

  function screenCardHtml(source) {
    var selected = source.id === state.selectedScreenId;
    var thumb = source.thumbnailDataUrl
      ? '<img src="' + esc(source.thumbnailDataUrl) + '" alt="">'
      : '<span class="source-thumb-fallback">' + icon('monitor') + '</span>';
    return '<label class="source-card' + (selected ? ' is-selected' : '') + '" data-source-id="' + esc(source.id) + '">' +
      '<input class="source-radio" type="radio" name="screenSource" value="' + esc(source.id) + '"' + (selected ? ' checked' : '') + '>' +
      '<span class="source-thumb">' + thumb + '<span class="source-tick">' + icon('check') + '</span></span>' +
      '<span class="source-meta">' +
        '<span class="source-name">' + esc(source.name || '屏幕') + '</span>' +
        '<span class="source-sub">' + esc(screenResolution(source)) + '</span>' +
      '</span>' +
      '</label>';
  }

  function windowCardHtml(win) {
    var selected = win.id === state.selectedWindowId;
    var thumb = win.thumbnailDataUrl
      ? '<img src="' + esc(win.thumbnailDataUrl) + '" alt="">'
      : '<span class="window-thumb-fallback">' + icon('window') + '</span>';
    var appIcon = win.appIconDataUrl ? '<img class="window-app-icon" src="' + esc(win.appIconDataUrl) + '" alt="">' : '';
    return '<label class="window-card' + (selected ? ' is-selected' : '') + '" data-source-id="' + esc(win.id) + '">' +
      '<input class="source-radio" type="radio" name="windowSource" value="' + esc(win.id) + '"' + (selected ? ' checked' : '') + '>' +
      '<span class="window-thumb">' + thumb + appIcon + '<span class="source-tick">' + icon('check') + '</span></span>' +
      '<span class="window-title">' + esc(win.name || '应用窗口') + '</span>' +
      '<span class="window-app">' + icon('window') + '<span class="window-app-name">' + esc(win.appName || '应用') + '</span></span>' +
      '</label>';
  }

  function filteredWindows() {
    var keyword = state.windowFilter.trim().toLowerCase();
    if (!keyword) return state.windows;
    return state.windows.filter(function (win) {
      return ((win.name || '') + ' ' + (win.appName || '')).toLowerCase().indexOf(keyword) >= 0;
    });
  }

  function windowListHtml() {
    var list = filteredWindows();
    if (!list.length) {
      if (state.windowFilter.trim()) {
        return sourceEmptyHtml('search', '没有匹配的窗口', '试试更短的关键词，或清空搜索条件', '<button type="button" class="btn btn-sm" data-action="clear-window-filter">清空搜索</button>');
      }
      return sourceEmptyHtml('window', '没有找到可录制的窗口', '请先打开需要录制的应用窗口，然后点击刷新',
        '<button type="button" class="btn btn-sm" data-action="refresh-sources">' + icon('refresh') + '刷新列表</button>');
    }
    return '<div class="window-list"><div class="window-grid">' + list.map(windowCardHtml).join('') + '</div></div>';
  }

  function renderWindowListOnly() {
    var list = $('#windowListHost', dom.sourceBody);
    if (list) list.innerHTML = windowListHtml();
    var note = $('#windowToolbarNote', dom.sourceBody);
    if (note) note.textContent = filteredWindows().length + ' / ' + state.windows.length;
  }

  function regionFrameHtml(region) {
    var bounds = (state.display && state.display.virtualBounds) ||
      { x: 0, y: 0, width: 1920, height: 1080 };
    var width = bounds.width || 1920;
    var height = bounds.height || 1080;
    var left = Math.max(0, Math.min(96, ((region.x - bounds.x) / width) * 100));
    var top = Math.max(0, Math.min(96, ((region.y - bounds.y) / height) * 100));
    var w = Math.max(3, Math.min(100 - left, (region.width / width) * 100));
    var h = Math.max(3, Math.min(100 - top, (region.height / height) * 100));
    return '<span class="region-frame" style="left:' + left.toFixed(2) + '%;top:' + top.toFixed(2) +
      '%;width:' + w.toFixed(2) + '%;height:' + h.toFixed(2) + '%"></span>';
  }

  function regionBodyHtml() {
    var region = state.region;
    var known = !!region || state.regionKnown;
    var preview;
    if (region) {
      preview = '<div class="region-preview">' +
        '<span class="region-placeholder">' + icon('crop') + '<p>已框选区域</p></span>' +
        regionFrameHtml(region) +
        '</div>';
    } else {
      preview = '<div class="region-preview"><span class="region-placeholder">' + icon('crop') +
        '<p>尚未框选区域</p></span></div>';
    }

    var sizeHtml = region
      ? '<span class="region-size-value">' + region.width + ' × ' + region.height + '<span class="unit">像素</span></span>'
      : '<span class="region-size-value is-dim">未框选</span>';

    var pill = known
      ? '<span class="region-pill">' + icon('check') + '已就绪</span>'
      : '<span class="region-pill" style="border-color:rgba(245,158,11,.3);background:rgba(245,158,11,.1);color:#fcd34d">' + icon('alert') + '待框选</span>';

    var display = displayFor(null);
    var displayHint = display
      ? '当前屏幕 ' + display.bounds.width + ' × ' + display.bounds.height +
        '（' + Math.round((display.scaleFactor || 1) * 100) + '% 缩放）'
      : '';

    var hint = region
      ? '仅录制框选范围内的画面，可重新框选调整'
      : '点击“框选区域”，在屏幕上拖拽选择要录制的范围';
    if (displayHint) hint += ' · ' + displayHint;

    return '<div class="region-card">' + preview +
      '<div class="region-body">' +
        '<div>' +
          '<div class="region-size">' + sizeHtml + pill + '</div>' +
          '<div class="region-hint">' + esc(hint) + '</div>' +
        '</div>' +
        '<div class="region-actions">' +
          '<button type="button" class="btn btn-primary" data-action="select-region"' + (state.regionBusy ? ' disabled' : '') + '>' +
            (state.regionBusy ? '<span class="spinner"></span>框选中…' : icon('crop') + '框选区域') +
          '</button>' +
          (region ? '<button type="button" class="btn btn-sm" data-action="clear-region">清除</button>' : '') +
        '</div>' +
      '</div>' +
      '</div>';
  }

  function sourceBodyHtml() {
    if (state.mode === 'screen') {
      if (state.sourcesLoading) return sourceSkeletonHtml(2);
      if (!state.screens.length) {
        return sourceEmptyHtml('monitor-off', '未检测到可录制的屏幕', '请检查显示器连接后刷新来源列表',
          '<button type="button" class="btn btn-sm" data-action="refresh-sources">' + icon('refresh') + '刷新列表</button>');
      }
      return '<div class="source-grid">' + state.screens.map(screenCardHtml).join('') + '</div>';
    }

    if (state.mode === 'window') {
      if (state.sourcesLoading) return sourceSkeletonHtml(3);
      var keyword = state.windowFilter;
      return '<div class="window-toolbar">' +
        '<div class="search-box">' + icon('search') +
          '<input class="search-input" id="windowSearch" type="search" placeholder="搜索窗口标题或应用" value="' + esc(keyword) + '" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<span class="window-toolbar-note" id="windowToolbarNote">' + filteredWindows().length + ' / ' + state.windows.length + '</span>' +
        '</div>' +
        '<div id="windowListHost">' + windowListHtml() + '</div>';
    }

    return regionBodyHtml();
  }

  function renderSource() {
    if (!dom.sourceTitle) return;
    var meta = MODE_META[state.mode] || MODE_META.screen;
    dom.sourceTitle.textContent = meta.title;

    var countText = '';
    if (state.mode === 'screen') countText = state.screens.length + ' 个显示器';
    else if (state.mode === 'window') countText = state.windows.length + ' 个窗口';
    else countText = '自由框选';
    dom.sourceCount.textContent = state.sourcesLoading ? '刷新中…' : countText;

    dom.sourceActions.innerHTML =
      '<button type="button" class="icon-btn' + (state.sourcesLoading ? ' is-spinning' : '') + '" data-action="refresh-sources" title="刷新来源" aria-label="刷新来源">' +
      icon('refresh') + '</button>';

    dom.sourceBody.innerHTML = sourceBodyHtml();
    updateStartAvailability();
  }

  /* =========================================================
     模式切换 / 区域框选
     ========================================================= */

  function setMode(mode) {
    if (!MODE_META[mode] || state.mode === mode) return;
    if (state.recording.state !== 'idle') {
      pushToast('warning', '录制过程中无法切换模式');
      return;
    }
    state.mode = mode;
    $$('.mode-card', dom.modeGrid).forEach(function (card) {
      var active = card.getAttribute('data-mode') === mode;
      card.classList.toggle('is-selected', active);
      card.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    renderSource();
  }

  function selectSource(id) {
    if (!id) return;
    if (state.mode === 'screen') state.selectedScreenId = id;
    else if (state.mode === 'window') state.selectedWindowId = id;
    else return;
    renderSource();
  }

  function chooseRegion() {
    if (state.regionBusy) return;
    if (state.recording.state !== 'idle') {
      pushToast('warning', '录制过程中无法重新框选区域');
      return;
    }
    state.regionBusy = true;
    renderSource();
    Promise.resolve(api.selectRegion()).then(function (region) {
      state.regionBusy = false;
      if (region) {
        state.region = region;
        state.regionKnown = true;
        pushToast('success', '已框选区域：' + region.width + ' × ' + region.height);
      } else {
        pushToast('info', '已取消框选');
      }
      renderSource();
      updateStartAvailability();
    }).catch(function (err) {
      state.regionBusy = false;
      renderSource();
      updateStartAvailability();
      pushToast('error', (err && err.message) || '框选区域失败');
    });
  }

  function clearRegion() {
    state.region = null;
    state.regionKnown = false;
    renderSource();
    updateStartAvailability();
  }

  function refreshRegionState() {
    if (!api.hasRegion) return;
    try {
      var result = api.hasRegion();
      if (result && !state.region) {
        state.regionKnown = true;
        renderSource();
        updateStartAvailability();
      }
    } catch (err) { /* hasRegion 可能返回 undefined，忽略 */ }
  }

  /* =========================================================
     录制控制
     ========================================================= */

  function buildStartRequest() {
    var settings = state.settings;
    var request = {
      mode: state.mode,
      fps: settings.fps,
      quality: settings.quality,
      format: settings.format,
      systemAudio: !!settings.systemAudio,
      microphone: !!settings.microphone,
      micDeviceId: settings.microphone ? (settings.micDeviceId || 'default') : 'default',
      countdown: settings.countdown,
      hideMainWindow: !!settings.hideMainWindow
    };

    if (state.mode === 'screen') {
      var screen = selectedScreen();
      if (!screen) {
        pushToast('warning', '没有可用的屏幕来源，请刷新后重试');
        return null;
      }
      request.sourceId = screen.id;
    } else if (state.mode === 'window') {
      var win = selectedWindow();
      if (!win) {
        pushToast('warning', '请先选择一个窗口');
        return null;
      }
      request.sourceId = win.id;
    } else {
      if (state.region) {
        request.region = clone(state.region);
      } else if (!state.regionKnown) {
        pushToast('warning', '请先框选录制区域');
        return null;
      }
    }
    return request;
  }

  function startCapture() {
    if (state.startLoading) return;
    if (state.recording.state !== 'idle') return;
    var request = buildStartRequest();
    if (!request) return;

    state.startLoading = true;
    updateStartAvailability();
    renderActionState();

    Promise.resolve(api.startRecording(request)).then(function (result) {
      if (!result || result.ok === false) {
        state.startLoading = false;
        renderActionState();
        pushToast('error', (result && result.error) || '无法开始录制');
        return;
      }
      /* 成功后等待 onRecordingState 推送；若主进程未推送则兜底解除 loading */
      setTimeout(function () {
        if (state.startLoading && state.recording.state === 'idle') {
          state.startLoading = false;
          renderActionState();
          pushToast('warning', '录制已启动，但未收到状态更新');
        }
      }, 3000);
    }).catch(function (err) {
      state.startLoading = false;
      renderActionState();
      pushToast('error', (err && err.message) || '启动录制失败');
    });
  }

  function stopCapture() {
    if (state.stopLoading) return;
    var recState = state.recording.state;
    if (recState !== 'recording' && recState !== 'paused') return;
    state.stopLoading = true;
    renderActionState();
    Promise.resolve(api.stopRecording()).then(function (result) {
      if (result && result.ok === false) {
        state.stopLoading = false;
        renderActionState();
        pushToast('error', result.error || '停止录制失败');
      }
    }).catch(function (err) {
      state.stopLoading = false;
      renderActionState();
      pushToast('error', (err && err.message) || '停止录制失败');
    });
  }

  function togglePauseCapture() {
    if (state.pauseLoading) return;
    var recState = state.recording.state;
    if (recState !== 'recording' && recState !== 'paused') return;
    state.pauseLoading = true;
    renderActionState();
    Promise.resolve(api.togglePause()).then(function () {
      state.pauseLoading = false;
      renderActionState();
    }).catch(function (err) {
      state.pauseLoading = false;
      renderActionState();
      pushToast('error', (err && err.message) || '暂停/继续失败');
    });
  }

  function updateStartAvailability() {
    if (!dom.btnStart) return;
    var recState = state.recording.state;
    var missingRegion = state.mode === 'region' && !state.region && !state.regionKnown;
    var missingSource = (state.mode === 'screen' && !selectedScreen()) ||
      (state.mode === 'window' && !selectedWindow());
    var disabled = state.startLoading || recState !== 'idle' || missingRegion || missingSource;

    dom.btnStart.disabled = disabled;
    dom.btnStart.classList.toggle('is-loading', state.startLoading);
    dom.btnStart.setAttribute('aria-busy', state.startLoading ? 'true' : 'false');

    var label = $('.record-btn-label', dom.btnStart);
    if (label) label.textContent = state.startLoading ? '正在启动录制…' : '开始录制';

    var hint = '';
    if (state.startLoading) {
      hint = '<span>正在启动录制，请稍候</span>';
    } else if (state.sourcesLoading) {
      hint = icon('loader') + '<span>正在加载录制来源…</span>';
    } else if (missingRegion) {
      hint = icon('alert') + '<span>请先框选要录制的区域</span>';
    } else if (missingSource) {
      hint = icon('alert') + '<span>没有可用的录制来源，请刷新后重试</span>';
    } else {
      hint = '<span>选择来源与参数后开始录制；录制中按 <kbd>F9</kbd> 停止、<kbd>F10</kbd> 暂停</span>';
    }
    if (dom.actionHint) dom.actionHint.innerHTML = hint;
  }

  function renderActionState() {
    if (!dom.actionIdle) return;
    var rec = state.recording;
    var idle = rec.state === 'idle';
    var processing = rec.state === 'processing';
    var live = rec.state === 'recording' || rec.state === 'paused';
    var paused = rec.state === 'paused';

    setHidden(dom.actionIdle, !idle);
    setHidden(dom.actionRecording, !live);
    setHidden(dom.actionProcessing, !processing);

    if (live) {
      dom.recTimer.textContent = fmtDuration(rec.elapsedMs || 0);
      var modeTag = MODE_META[rec.mode] ? MODE_META[rec.mode].tag : '';
      dom.recSource.textContent = (modeTag ? modeTag + ' · ' : '') + (rec.sourceName || '正在录制');
      dom.recStateTag.textContent = paused ? '已暂停' : '录制中';
      dom.recStateTag.classList.toggle('is-paused', paused);
      dom.actionRecording.classList.toggle('is-paused', paused);
      dom.btnPauseLabel.textContent = paused ? '继续' : '暂停';
      if (dom.pauseIconUse) dom.pauseIconUse.setAttribute('href', paused ? '#i-play' : '#i-pause');
      dom.btnPause.disabled = !!state.pauseLoading;
      dom.btnStop.disabled = !!state.stopLoading;
    }

    if (idle) {
      dom.actionRecording.classList.remove('is-paused');
      updateStartAvailability();
    }
  }

  function renderCountdown() {
    var rec = state.recording;
    var show = rec.state === 'countdown' && !!dom.countdownOverlay;
    setHidden(dom.countdownOverlay, !show);
    if (!show) {
      state.lastCountdown = null;
      return;
    }
    var left = rec.countdownLeft != null ? rec.countdownLeft : 3;
    if (left !== state.lastCountdown) {
      state.lastCountdown = left;
      dom.countdownNumber.textContent = left;
      replayAnimation(dom.countdownNumber);
    }
    var modeTag = MODE_META[rec.mode] ? MODE_META[rec.mode].tag : '';
    dom.countdownSource.textContent = (modeTag ? modeTag + ' · ' : '') + (rec.sourceName || '');
  }

  function renderNavBadge() {
    if (!dom.navBadge) return;
    dom.navBadge.classList.toggle('is-on', state.recording.state !== 'idle');
  }

  function handleRecordingState(recState) {
    if (!recState || !recState.state) return;
    state.recording = recState;
    if (recState.state !== 'idle') state.startLoading = false;
    if (recState.state === 'processing' || recState.state === 'recording' || recState.state === 'paused') {
      state.stopLoading = false;
      state.pauseLoading = false;
    }
    renderActionState();
    renderCountdown();
    renderNavBadge();
  }


  /* =========================================================
     素材库
     ========================================================= */

  function sortedRecordings() {
    return state.recordings.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  }

  function recConfirmHtml(item) {
    return '<div class="rec-confirm">' +
      icon('alert') +
      '<div class="rec-confirm-title">删除这个视频？</div>' +
      '<div class="rec-confirm-desc">' + esc(item.fileName || '') + '</div>' +
      '<div class="rec-confirm-actions">' +
        '<button type="button" class="btn btn-sm" data-action="cancel-delete">取消</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-action="confirm-delete">删除</button>' +
      '</div>' +
      '</div>';
  }

  function recCardHtml(item) {
    var poster = item.posterDataUrl
      ? '<img src="' + esc(item.posterDataUrl) + '" alt="" loading="lazy">'
      : '<div class="rec-thumb-fallback">' + icon('film') + '</div>';
    var hasSound = !!(item.hasAudio || item.hasMic);
    var isNew = item.id === state.newRecordingId;
    var confirm = state.confirmDeleteId === item.id ? recConfirmHtml(item) : '';
    return '<article class="rec-card' + (isNew ? ' is-new' : '') + '" data-rec-id="' + esc(item.id) + '">' +
      '<div class="rec-thumb">' + poster +
        '<span class="rec-thumb-duration mono">' + fmtDuration(item.durationMs) + '</span>' +
        (hasSound ? '<span class="rec-audio-badge">' + icon('volume') + '含声音</span>' : '') +
        '<div class="rec-thumb-actions">' +
          '<button type="button" class="rec-action is-play" data-action="play" title="播放" aria-label="播放">' + icon('play') + '</button>' +
          '<button type="button" class="rec-action" data-action="reveal" title="在文件夹中显示" aria-label="定位文件">' + icon('folder') + '</button>' +
          '<button type="button" class="rec-action is-danger" data-action="delete" title="删除" aria-label="删除">' + icon('trash') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="rec-body">' +
        '<div class="rec-name" title="' + esc(item.fileName || '') + '">' + esc(item.fileName || '未命名视频') + '</div>' +
        '<div class="rec-meta">' +
          '<span>' + fmtResolution(item.width, item.height) + '</span>' +
          '<span class="sep"></span>' +
          '<span>' + fmtSize(item.sizeBytes) + '</span>' +
          '<span class="sep"></span>' +
          '<span>' + fmtDateTime(item.createdAt) + '</span>' +
        '</div>' +
      '</div>' +
      confirm +
      '</article>';
  }

  function renderLibrary() {
    if (!dom.recGrid) return;
    var items = sortedRecordings();
    var loading = state.libLoading;
    var showSkeleton = loading && !state.libLoaded;
    var showEmpty = !loading && state.libLoaded && items.length === 0;
    var showGrid = !loading && items.length > 0;

    setHidden(dom.libSkeleton, !showSkeleton);
    setHidden(dom.libEmpty, !showEmpty);
    setHidden(dom.recGrid, !showGrid);

    if (dom.btnLibRefresh) {
      dom.btnLibRefresh.classList.toggle('is-spinning', loading);
      dom.btnLibRefresh.disabled = loading;
    }

    if (dom.librarySub) {
      if (loading) dom.librarySub.textContent = state.libLoaded ? '正在刷新…' : '正在读取素材…';
      else if (state.libLoaded) dom.librarySub.textContent = '共 ' + items.length + ' 个视频';
      else dom.librarySub.textContent = '加载中…';
    }

    if (showGrid) dom.recGrid.innerHTML = items.map(recCardHtml).join('');
    else dom.recGrid.innerHTML = '';
  }

  function loadRecordings(force) {
    if (state.libLoading) return;
    if (state.libLoaded && !force) {
      renderLibrary();
      return;
    }
    state.libLoading = true;
    renderLibrary();
    Promise.resolve(api.listRecordings()).then(function (items) {
      state.recordings = (items || []).map(function (item) { return item; });
      state.libLoaded = true;
      state.libLoading = false;
      renderLibrary();
    }).catch(function (err) {
      state.libLoading = false;
      state.libLoaded = false;
      renderLibrary();
      pushToast('error', (err && err.message) || '读取素材库失败');
    });
  }

  function playRecording(id) {
    Promise.resolve(api.openRecording(id)).catch(function (err) {
      pushToast('error', (err && err.message) || '无法打开视频');
    });
  }

  function revealRecording(id) {
    Promise.resolve(api.revealRecording(id)).catch(function (err) {
      pushToast('error', (err && err.message) || '无法定位文件');
    });
  }

  function removeRecording(id) {
    Promise.resolve(api.deleteRecording(id)).then(function () {
      state.recordings = state.recordings.filter(function (item) { return item.id !== id; });
      state.confirmDeleteId = null;
      state.newRecordingId = state.newRecordingId === id ? null : state.newRecordingId;
      renderLibrary();
      pushToast('success', '已删除视频');
    }).catch(function (err) {
      pushToast('error', (err && err.message) || '删除失败');
    });
  }

  function highlightNewCard() {
    if (!state.newRecordingId) return;
    var node = $('.rec-card[data-rec-id="' + state.newRecordingId + '"]', dom.recGrid);
    if (!node) return;
    if (node.scrollIntoView) {
      try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) { node.scrollIntoView(); }
    }
    setTimeout(function () {
      if (node) node.classList.remove('is-new');
      if (state.newRecordingId) state.newRecordingId = null;
    }, 2800);
  }

  function handleRecordingSaved(item) {
    if (!item || !item.id) return;
    pushToast('success', '已保存：' + (item.fileName || '视频'));
    state.confirmDeleteId = null;
    state.newRecordingId = item.id;
    var exists = state.recordings.some(function (rec) { return rec.id === item.id; });
    if (!exists) state.recordings.unshift(item);
    state.libLoaded = true;
    renderLibrary();

    if (AUTO_JUMP_TO_LIBRARY) {
      setTimeout(function () {
        renderPage('library');
        highlightNewCard();
      }, 420);
    }
  }

  /* =========================================================
     设置页 / 关于信息
     ========================================================= */

  function renderAbout() {
    var info = state.appInfo || {};
    if (dom.aboutAppName) dom.aboutAppName.textContent = info.name || 'NovaRec';
    if (dom.aboutVersion) dom.aboutVersion.textContent = info.version ? 'v' + info.version : '—';
    if (dom.aboutElectron) dom.aboutElectron.textContent = info.electron ? String(info.electron) : '—';
    if (dom.aboutFfmpeg) {
      var available = info.ffmpeg;
      var cls = available === true ? 'badge-ok' : available === false ? 'badge-warn' : 'badge-neutral';
      dom.aboutFfmpeg.className = 'badge ' + cls;
      dom.aboutFfmpeg.innerHTML = icon(available === true ? 'check-circle' : available === false ? 'alert' : 'info') +
        (available === true ? '可用' : available === false ? '不可用' : '检测中');
    }
    renderOutputDir();
    renderPerfAbout();
  }

  function loadAppInfo() {
    if (!api.getAppInfo) return;
    Promise.resolve(api.getAppInfo()).then(function (info) {
      state.appInfo = info || null;
      if (info && info.version && dom.sidebarVersion) dom.sidebarVersion.textContent = 'v' + info.version;
      renderAbout();
      renderPerfHint();
    }).catch(function () { /* 版本信息为辅助内容，失败静默 */ });
  }

  /* =========================================================
     页面切换 / 窗口控制
     ========================================================= */

  function renderPage(page) {
    if (!PAGE_META[page]) page = 'record';
    state.page = page;

    dom.pages.forEach(function (section) {
      section.classList.toggle('is-active', section.getAttribute('data-page') === page);
    });
    dom.navItems.forEach(function (item) {
      var active = item.getAttribute('data-page') === page;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });

    var meta = PAGE_META[page];
    if (dom.pageTitle) dom.pageTitle.textContent = meta.title;
    if (dom.pageIcon) dom.pageIcon.setAttribute('href', '#i-' + meta.icon);
    if (dom.main) dom.main.scrollTop = 0;

    if (page === 'library') loadRecordings(false);
    if (page === 'settings') {
      renderSettingsControls();
      renderAbout();
    }
    if (page === 'record') updateStartAvailability();
  }

  function applyMaximized(maximized) {
    if (!dom.btnMaxIcon) return;
    dom.btnMaxIcon.setAttribute('href', maximized ? '#i-restore' : '#i-maximize');
    if (dom.btnMaximize) {
      dom.btnMaximize.setAttribute('title', maximized ? '向下还原' : '最大化');
      dom.btnMaximize.setAttribute('aria-label', maximized ? '向下还原' : '最大化');
    }
  }

  function toggleWindowMaximize() {
    if (!api.window || typeof api.window.toggleMaximize !== 'function') return;
    Promise.resolve(api.window.toggleMaximize()).then(applyMaximized).catch(function () {});
  }

  function bindWindowState() {
    var win = api.window;
    if (!win) {
      if (dom.btnMaximize) dom.btnMaximize.disabled = true;
      return;
    }
    if (typeof win.isMaximized === 'function') {
      try { applyMaximized(!!win.isMaximized()); } catch (err) { /* ignore */ }
    }
    if (typeof win.onMaximizedChange === 'function') {
      try {
        var off = win.onMaximizedChange(applyMaximized);
        if (typeof off === 'function') unsubscribes.push(off);
      } catch (err) { /* ignore */ }
    }
  }

  /* =========================================================
     目录操作
     ========================================================= */

  var choosingDir = false;

  function setDirBusy(busy) {
    [dom.btnChangeDir, dom.btnSettingsChangeDir].forEach(function (btn) {
      if (btn) btn.disabled = busy;
    });
  }

  function chooseOutputDir() {
    if (choosingDir) return;
    choosingDir = true;
    setDirBusy(true);
    Promise.resolve(api.chooseOutputDir()).then(function (next) {
      choosingDir = false;
      setDirBusy(false);
      if (!next) {
        pushToast('info', '已取消选择保存目录');
        return;
      }
      if (typeof next === 'object') applySettings(next);
      pushToast('success', '保存位置已更新');
    }).catch(function (err) {
      choosingDir = false;
      setDirBusy(false);
      pushToast('error', (err && err.message) || '选择保存目录失败');
    });
  }

  function openOutputDir() {
    Promise.resolve(api.openOutputDir()).catch(function (err) {
      pushToast('error', (err && err.message) || '无法打开保存目录');
    });
  }

  /* =========================================================
     事件绑定
     ========================================================= */

  var unsubscribes = [];

  function subscribe(method, handler) {
    if (!api || typeof api[method] !== 'function') return;
    try {
      var off = api[method](handler);
      if (typeof off === 'function') unsubscribes.push(off);
    } catch (err) {
      console.error('[NovaRec] 订阅 ' + method + ' 失败', err);
    }
  }

  function handleAction(action) {
    switch (action) {
      case 'refresh-sources': loadSources(true); break;
      case 'select-region': chooseRegion(); break;
      case 'clear-region': clearRegion(); break;
      case 'clear-window-filter': state.windowFilter = ''; renderSource(); break;
      case 'open-output-dir': openOutputDir(); break;
      case 'change-dir': chooseOutputDir(); break;
      default: break;
    }
  }

  function onDocumentClick(event) {
    var target = event.target;
    if (!target || !target.closest) return;

    /* 素材库卡片内的操作按钮 */
    var recCard = target.closest('.rec-card[data-rec-id]');
    if (recCard) {
      var actionEl = target.closest('[data-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-action');
      var recId = recCard.getAttribute('data-rec-id');
      if (action === 'play') playRecording(recId);
      else if (action === 'reveal') revealRecording(recId);
      else if (action === 'delete') { state.confirmDeleteId = recId; renderLibrary(); }
      else if (action === 'cancel-delete') { state.confirmDeleteId = null; renderLibrary(); }
      else if (action === 'confirm-delete') removeRecording(recId);
      return;
    }

    /* 开关 */
    var switchEl = target.closest('.switch[data-setting]');
    if (switchEl) {
      var key = switchEl.getAttribute('data-setting');
      setSetting(key, !state.settings[key]);
      return;
    }

    /* 分段控件 */
    var segButton = target.closest('.segmented[data-setting] button[data-value]');
    if (segButton) {
      var seg = segButton.closest('.segmented');
      var segKey = seg.getAttribute('data-setting');
      var raw = segButton.getAttribute('data-value');
      var value = (segKey === 'fps' || segKey === 'countdown') ? Number(raw) : raw;
      setSetting(segKey, value);
      return;
    }

    /* 通用 data-action 按钮 */
    var actionBtn = target.closest('[data-action]');
    if (actionBtn) {
      if (target.closest('#btnChangeDir, #btnSettingsChangeDir')) return;
      handleAction(actionBtn.getAttribute('data-action'));
      return;
    }

    /* 来源卡片选择 */
    var sourceCard = target.closest('[data-source-id]');
    if (sourceCard) selectSource(sourceCard.getAttribute('data-source-id'));
  }

  function bindEvents() {
    /* 导航 */
    dom.navItems.forEach(function (item) {
      item.addEventListener('click', function () { renderPage(item.getAttribute('data-page')); });
    });

    /* 模式选择 */
    if (dom.modeGrid) {
      dom.modeGrid.addEventListener('click', function (event) {
        var card = event.target.closest ? event.target.closest('.mode-card') : null;
        if (card) setMode(card.getAttribute('data-mode'));
      });
    }

    /* 来源区：搜索过滤（输入事件不重建工具栏，保持焦点） */
    if (dom.sourceBody) {
      dom.sourceBody.addEventListener('input', function (event) {
        var target = event.target;
        if (target && target.id === 'windowSearch') {
          state.windowFilter = target.value;
          renderWindowListOnly();
        }
      });
      dom.sourceBody.addEventListener('keydown', function (event) {
        var target = event.target;
        if (target && target.id === 'windowSearch' && event.key === 'Escape') {
          state.windowFilter = '';
          target.value = '';
          renderWindowListOnly();
        }
      });
    }

    /* 麦克风下拉 */
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (target && target.matches && target.matches('[data-mic-select]')) {
        setSetting('micDeviceId', target.value);
      }
    });

    /* 设置控件 / 卡片操作 / 通用动作 统一委托 */
    document.addEventListener('click', onDocumentClick);

    /* 录制主按钮 */
    if (dom.btnStart) dom.btnStart.addEventListener('click', startCapture);
    if (dom.btnPause) dom.btnPause.addEventListener('click', togglePauseCapture);
    if (dom.btnStop) dom.btnStop.addEventListener('click', stopCapture);

    /* 目录相关 */
    [dom.btnOpenDir, dom.btnLibOpenDir].forEach(function (btn) {
      if (btn) btn.addEventListener('click', openOutputDir);
    });
    [dom.btnChangeDir, dom.btnSettingsChangeDir].forEach(function (btn) {
      if (btn) btn.addEventListener('click', chooseOutputDir);
    });

    /* 素材库 */
    if (dom.btnLibRefresh) dom.btnLibRefresh.addEventListener('click', function () { loadRecordings(true); });
    if (dom.btnEmptyStart) dom.btnEmptyStart.addEventListener('click', function () { renderPage('record'); });

    /* 窗口控制 */
    if (dom.btnMinimize) {
      dom.btnMinimize.addEventListener('click', function () {
        if (api.window && typeof api.window.minimize === 'function') Promise.resolve(api.window.minimize()).catch(function () {});
      });
    }
    if (dom.btnMaximize) dom.btnMaximize.addEventListener('click', toggleWindowMaximize);
    if (dom.btnClose) {
      dom.btnClose.addEventListener('click', function () {
        if (api.window && typeof api.window.close === 'function') Promise.resolve(api.window.close()).catch(function () {});
      });
    }
    if (dom.titlebar) {
      dom.titlebar.addEventListener('dblclick', function (event) {
        if (event.target && event.target.closest && event.target.closest('.win-btn')) return;
        toggleWindowMaximize();
      });
    }

    /* 快捷键：与主进程全局快捷键互补（窗口聚焦时也可用） */
    document.addEventListener('keydown', function (event) {
      if (event.key === 'F9') {
        event.preventDefault();
        stopCapture();
        return;
      }
      if (event.key === 'F10') {
        event.preventDefault();
        togglePauseCapture();
        return;
      }
      if (event.key === 'Escape' && state.confirmDeleteId) {
        state.confirmDeleteId = null;
        renderLibrary();
      }
    });

    /* 麦克风设备变化 */
    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
      try { navigator.mediaDevices.addEventListener('devicechange', refreshMicDevices); } catch (err) { /* ignore */ }
    }

    window.addEventListener('beforeunload', function () {
      unsubscribes.forEach(function (off) {
        try { off(); } catch (err) { /* ignore */ }
      });
      unsubscribes = [];
    });
  }

  /* =========================================================
     初始化
     ========================================================= */

  function syncRecordingState() {
    if (!api.getRecordingState) return;
    Promise.resolve(api.getRecordingState()).then(handleRecordingState).catch(function () {});
  }

  function boot() {
    cacheDom();

    if (IS_MOCK && dom.mockBadge) {
      dom.mockBadge.hidden = false;
      dom.mockBadge.innerHTML = icon('flask') + '<span>预览模式 · Mock 数据</span>';
    } else if (dom.mockBadge) {
      dom.mockBadge.hidden = true;
    }

    bindEvents();
    bindWindowState();

    /* 先渲染空态/骨架，再异步填充数据 */
    renderSource();
    renderActionState();
    renderCountdown();
    renderLibrary();
    renderSettingsControls();

    Promise.resolve(api.getSettings()).then(applySettings).catch(function (err) {
      pushToast('error', (err && err.message) || '读取设置失败');
    });

    loadAppInfo();
    loadDisplayInfo();
    loadSources(false);
    loadRecordings(false);
    refreshMicDevices();
    refreshRegionState();
    syncRecordingState();

    subscribe('onSettingsChanged', function (next) {
      if (next && typeof next === 'object') applySettings(next);
    });
    subscribe('onRecordingState', handleRecordingState);
    subscribe('onRecordingSaved', handleRecordingSaved);
    subscribe('onRecordingError', function (message) {
      state.startLoading = false;
      renderActionState();
      pushToast('error', message || '录制过程出错');
    });
    subscribe('onToast', function (payload) {
      if (!payload) return;
      pushToast(payload.type || 'info', payload.message || '');
    });

    renderPage('record');
    state.initialized = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
