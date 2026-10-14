/* Cueflow player: runs a guide (scene + timeline + narration) inside a small stage. Plain browser JS, inlined at build time. */
(function () {
  "use strict";

  var CLICK_MS = 350;
  var MS_PER_CHAR = 65; // narration length estimate when there is no audio

  function mount(root, DATA) {
    var guide = DATA.guide;
    var steps = guide.steps;
    var vw = guide.viewport.width;
    var vh = guide.viewport.height;
    var lang = guide.languages[0];

    root.innerHTML =
      '<div class="cf-app">' +
      '<div class="cf-stage"><div class="cf-world">' +
      '<iframe class="cf-frame" scrolling="no" tabindex="-1"></iframe>' +
      '<div class="cf-ring"></div><div class="cf-cursor"></div>' +
      "</div>" +
      '<button class="cf-big" aria-label="Play">▶</button></div>' +
      '<div class="cf-caption"></div>' +
      '<div class="cf-bar"><button class="cf-play" aria-label="Play/Pause">▶</button>' +
      '<button class="cf-restart" aria-label="Restart">↺</button>' +
      '<div class="cf-track"><div class="cf-fill"></div></div><select class="cf-lang"></select></div></div>';

    var $ = function (s) { return root.querySelector(s); };
    var app = $(".cf-app"), stage = $(".cf-stage"), world = $(".cf-world"), frame = $(".cf-frame");
    var ring = $(".cf-ring"), cursor = $(".cf-cursor"), caption = $(".cf-caption");
    var big = $(".cf-big"), playBtn = $(".cf-play"), fill = $(".cf-fill"), langSel = $(".cf-lang");

    stage.style.aspectRatio = guide.stage.width + " / " + guide.stage.height;
    app.style.maxWidth = guide.stage.width + "px";
    world.style.width = vw + "px";
    world.style.height = vh + "px";
    frame.style.width = vw + "px";
    frame.style.height = vh + "px";

    guide.languages.forEach(function (l) {
      var o = document.createElement("option");
      o.value = l;
      o.textContent = l.toUpperCase();
      langSel.appendChild(o);
    });
    if (guide.languages.length < 2) langSel.style.display = "none";

    // ---- runtime state ----
    var curScene = null;
    var cam = null; // last camera spec
    var cur = null; // { i, t, total, narrDur, actions[], audio }
    var playing = false;
    var loading = false;
    var last = 0;
    var raf = 0;
    var sceneStepIndex = {}; // step index -> scene name

    (function () {
      var s = guide.scene;
      steps.forEach(function (st, i) { if (st.scene) s = st.scene; sceneStepIndex[i] = s; });
    })();

    function doc() { return frame.contentDocument; }
    function $el(sel) { try { return doc().querySelector(sel); } catch (e) { return null; } }

    function loadScene(name) {
      return new Promise(function (resolve) {
        frame.onload = function () { frame.onload = null; resolve(); };
        frame.srcdoc = DATA.scenes[name];
        curScene = name;
        cursor.style.opacity = "0";
        ring.style.opacity = "0";
        cursor.style.transitionDuration = "0ms";
      });
    }

    // ---- camera ----
    function rectOf(target) {
      if (typeof target === "string") {
        var el = $el(target);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
      return target;
    }
    function applyCamera(spec, ms) {
      cam = spec || null;
      var SW = stage.clientWidth, SH = stage.clientHeight;
      var rect = spec ? rectOf(spec.target) : null;
      var pad = spec && spec.padding != null ? spec.padding : 24;
      if (!rect) rect = { x: 0, y: 0, width: vw, height: vh }, pad = 0;
      var s = Math.min(SW / (rect.width + 2 * pad), SH / (rect.height + 2 * pad), 4);
      var tx = SW / 2 - (rect.x + rect.width / 2) * s;
      var ty = SH / 2 - (rect.y + rect.height / 2) * s;
      // never show the empty space outside the scene: keep the scene covering the stage (or centered when smaller)
      tx = vw * s <= SW ? (SW - vw * s) / 2 : Math.min(0, Math.max(SW - vw * s, tx));
      ty = vh * s <= SH ? (SH - vh * s) / 2 : Math.min(0, Math.max(SH - vh * s, ty));
      world.style.transitionDuration = ms + "ms";
      world.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")";
    }
    window.addEventListener("resize", function () { if (cam !== undefined) applyCamera(cam, 0); });

    // ---- actions: start / update(p) / finish ----
    function center(el) {
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function parseNum(v) {
      var m = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(String(v).trim());
      return m ? { n: parseFloat(m[1]), unit: m[2] } : { n: 0, unit: "" };
    }
    var handlers = {
      move: {
        start: function (a, ctx) {
          var el = $el(a.to);
          if (!el) return;
          var c = center(el);
          cursor.style.opacity = "1";
          cursor.style.transitionDuration = ctx.instant ? "0ms" : a.duration + "ms";
          cursor.style.transform = "translate(" + c.x + "px," + c.y + "px)";
        }
      },
      click: {
        start: function (a, ctx) {
          var el = $el(a.to);
          if (!el) return;
          var c = center(el);
          cursor.style.opacity = "1";
          cursor.style.transitionDuration = "0ms";
          cursor.style.transform = "translate(" + c.x + "px," + c.y + "px)";
          cursor.classList.add("cf-click");
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: frame.contentWindow }));
          void ctx;
        },
        finish: function () { cursor.classList.remove("cf-click"); }
      },
      type: {
        update: function (a, p) {
          var el = $el(a.to);
          if (!el) return;
          var text = a.text.slice(0, Math.round(a.text.length * p));
          if ("value" in el) {
            el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          } else el.textContent = text;
        }
      },
      highlight: {
        start: function (a) {
          var el = $el(a.to);
          if (!el) return;
          var r = el.getBoundingClientRect();
          ring.style.cssText = "opacity:1;left:" + (r.left - 6) + "px;top:" + (r.top - 6) + "px;width:" + (r.width + 12) + "px;height:" + (r.height + 12) + "px";
        },
        finish: function () { ring.style.opacity = "0"; }
      },
      set: {
        start: function (a) {
          var el = $el(a.to);
          if (!el) return;
          if (a.text != null) el.textContent = a.text;
          if (a.html != null) el.innerHTML = a.html;
          (a.add || []).forEach(function (c) { el.classList.add(c); });
          (a.remove || []).forEach(function (c) { el.classList.remove(c); });
          Object.keys(a.attr || {}).forEach(function (k) { el.setAttribute(k, a.attr[k]); });
        }
      },
      show: { start: function (a) { var el = $el(a.to); if (el) { el.removeAttribute("hidden"); el.style.display = ""; } } },
      hide: { start: function (a) { var el = $el(a.to); if (el) el.style.display = "none"; } },
      tween: {
        update: function (a, p) {
          var el = $el(a.to);
          if (!el) return;
          var f = parseNum(a.from), e = parseNum(a.end);
          el.style[a.prop] = f.n + (e.n - f.n) * p + (e.unit || f.unit);
        }
      },
      camera: {
        start: function (a, ctx) { applyCamera({ target: a.target, padding: a.padding }, ctx.instant ? 0 : a.duration); }
      }
    };
    function durationOf(a) {
      if (a.do === "click") return CLICK_MS;
      if (a.do === "move" || a.do === "camera") return 0; // CSS transitions run on their own
      return a.duration || 0;
    }
    function endOf(a, narrDur) { return atMs(a, narrDur) + (a.duration != null ? a.duration : a.do === "click" ? CLICK_MS : 0); }
    function atMs(a, narrDur) {
      var v = a.at == null ? 0 : a.at;
      return typeof v === "string" ? (parseFloat(v) / 100) * narrDur : v;
    }

    /** Runs the actions that are due at step time t; `ctx.instant` is for seeking (no transitions). */
    function runDue(c, t, ctx) {
      c.actions.forEach(function (x) {
        var a = x.a, h = handlers[a.do];
        if (!h || x.done || t < x.at) return;
        if (!x.started) { x.started = true; if (h.start) h.start(a, ctx); }
        var d = durationOf(a);
        var p = d > 0 ? Math.min(1, (t - x.at) / d) : 1;
        if (h.update) h.update(a, p);
        if (p >= 1) { x.done = true; if (h.finish) h.finish(a); }
      });
    }

    // ---- steps ----
    function estimate(text) { return text ? Math.max(1500, text.length * MS_PER_CHAR) : 1500; }

    function audioUrl(i) {
      var m = DATA.audio[lang];
      return m && m[steps[i].id] ? m[steps[i].id] : null;
    }
    function audioDuration(url) {
      return new Promise(function (resolve) {
        var a = new Audio();
        var done = false;
        function fin(v) { if (!done) { done = true; resolve({ audio: a, ms: v }); } }
        a.preload = "metadata";
        a.onloadedmetadata = function () { fin(isFinite(a.duration) ? a.duration * 1000 : null); };
        a.onerror = function () { fin(null); };
        setTimeout(function () { fin(null); }, 1500);
        a.src = url;
      });
    }

    async function enterStep(i, instant) {
      var st = steps[i];
      var sceneName = sceneStepIndex[i];
      if (sceneName !== curScene) { await loadScene(sceneName); cam = null; }
      var text = st.narration[lang] || "";
      var url = audioUrl(i);
      var info = url ? await audioDuration(url) : { audio: null, ms: null };
      var narrDur = info.ms != null ? info.ms : estimate(text);
      var actions = st.actions.map(function (a) { return { a: a, at: atMs(a, narrDur), started: false, done: false }; });
      var lastEnd = 0;
      st.actions.forEach(function (a) { lastEnd = Math.max(lastEnd, endOf(a, narrDur)); });
      cur = { i: i, t: 0, total: Math.max(narrDur, lastEnd) + (st.hold != null ? st.hold : 600), narrDur: narrDur, actions: actions, audio: info.audio && info.ms != null ? info.audio : null };
      caption.textContent = text;
      applyCamera(st.camera || cam, instant ? 0 : 700);
      if (!instant && cur.audio && playing) { cur.audio.currentTime = 0; cur.audio.play().catch(function () {}); }
    }

    function setPlaying(v) {
      playing = v;
      app.classList.toggle("cf-playing", v);
      playBtn.textContent = v ? "❚❚" : "▶";
      if (cur && cur.audio) { if (v) cur.audio.play().catch(function () {}); else cur.audio.pause(); }
      if (v) { last = performance.now(); raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf);
    }

    function progressBar() {
      var done = 0, total = 0;
      steps.forEach(function (_, i) { total += 1; if (cur && i < cur.i) done += 1; });
      var within = cur && cur.total ? Math.min(1, cur.t / cur.total) : 0;
      fill.style.width = ((done + within) / Math.max(total, 1)) * 100 + "%";
    }

    function tick(ts) {
      if (!playing || loading) { if (playing) raf = requestAnimationFrame(tick); return; }
      var dt = ts - last;
      last = ts;
      cur.t += dt;
      runDue(cur, cur.t, { instant: false });
      progressBar();
      if (cur.t >= cur.total) {
        if (cur.audio) cur.audio.pause();
        var next = cur.i + 1;
        if (next >= steps.length) { setPlaying(false); app.classList.add("cf-ended"); return; }
        loading = true;
        enterStep(next, false).then(function () { loading = false; last = performance.now(); });
      }
      raf = requestAnimationFrame(tick);
    }

    async function restart() {
      if (cur && cur.audio) cur.audio.pause();
      loading = true;
      app.classList.remove("cf-ended");
      await loadScene(guide.scene);
      cam = null;
      await enterStep(0, true);
      loading = false;
      progressBar();
    }

    /** Jumps to a point of the timeline (used by previews): replays everything before it instantly. */
    async function seek(i, t, l) {
      setPlaying(false);
      if (l) { lang = l; langSel.value = l; }
      loading = true;
      await loadScene(guide.scene);
      cam = null;
      for (var k = 0; k < i; k++) {
        await enterStep(k, true);
        runDue(cur, Infinity, { instant: true });
      }
      await enterStep(i, true);
      runDue(cur, t, { instant: true });
      cur.t = t;
      loading = false;
      progressBar();
      app.classList.add("cf-ready");
      return { total: cur.total, narration: cur.narrDur, steps: steps.length };
    }

    big.onclick = playBtn.onclick = async function () {
      if (playing) return setPlaying(false);
      if (!cur || app.classList.contains("cf-ended")) await restart();
      setPlaying(true);
    };
    $(".cf-restart").onclick = async function () { var was = playing; setPlaying(false); await restart(); setPlaying(was || true); };
    langSel.onchange = async function () { lang = langSel.value; var was = playing; setPlaying(false); await restart(); if (was) setPlaying(true); };

    restart();
    return { seek: seek, restart: restart, setLang: function (l) { lang = l; langSel.value = l; } };
  }

  window.Cueflow = { mount: mount };
})();
