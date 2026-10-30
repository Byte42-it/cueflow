/* Cueflow player: runs a guide (scene + timeline + narration) inside a small stage. Plain browser JS, inlined at build time. */
(function () {
  "use strict";

  var CLICK_MS = 350;
  var REPO = "https://github.com/Byte42-it/cueflow";

  /* Icons drawn from the Cueflow mark. The play triangle has rounded corners like the logo's and sits with its
     centroid (not its bounding box) on the center: a triangle centered by its box looks pushed to the left. */
  var ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.33 7.4V16.6L17.33 12Z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6" width="3.6" height="12" rx="1.6" fill="currentColor"/><rect x="13.9" y="6" width="3.6" height="12" rx="1.6" fill="currentColor"/></svg>';
  var MARK = '<svg viewBox="160 150 925 960" aria-hidden="true"><path d="M894 365A366 366 0 1 0 894 891" fill="none" stroke="currentColor" stroke-width="208" stroke-linecap="round"/><path d="M830 525V755L1035 640Z" fill="currentColor" stroke="currentColor" stroke-width="80" stroke-linejoin="round"/></svg>';
  // full screen: four corners (a font glyph like ⛶ is missing on many systems)
  var ICON_FULL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var MS_PER_CHAR = 65; // narration length estimate when there is no audio

  /* The player's own words. The interface follows the narration language; unknown languages fall back to English. */
  var LABELS = {
    en: { play: "Play", pause: "Pause", replay: "Replay this step", speed: "Speed", captions: "Captions", voice: "Voice", steps: "Steps", step: "Step",
      transcript: "Transcript", download: "Download (.txt)", watch: "Watch this step", language: "Language",
      start: "Play the video", note: "With voice and captions", noteCaptions: "With captions", ended: "End of the video", again: "Click to watch it again",
      resume: "Starts from step {n}: {title}", next: "Go to {title}",
      present: "Start the presentation", slide: "Slide", slidesNote: "{n} slides · full screen, space to go on", resumeSlide: "Starts from slide {n}: {title}",
      endSlides: "End of the presentation", againSlides: "Click to start again", previous: "Previous", forward: "Next", notes: "Notes", fullscreen: "Full screen" },
    it: { play: "Avvia", pause: "Pausa", replay: "Ripeti il passo", speed: "Velocità", captions: "Sottotitoli", voice: "Voce", steps: "Passi", step: "Passo",
      transcript: "Trascrizione", download: "Scarica (.txt)", watch: "Guarda questo passo", language: "Lingua",
      start: "Avvia il video", note: "Con voce e sottotitoli", noteCaptions: "Con sottotitoli", ended: "Fine del video", again: "Clic per rivederlo da capo",
      resume: "Riparte dal passo {n}: {title}", next: "Vai a {title}",
      present: "Avvia la presentazione", slide: "Slide", slidesNote: "{n} slide · a tutto schermo, spazio per avanzare", resumeSlide: "Riparte dalla slide {n}: {title}",
      endSlides: "Fine della presentazione", againSlides: "Clic per ricominciare", previous: "Precedente", forward: "Successiva", notes: "Note", fullscreen: "Schermo intero" },
    fr: { play: "Lire", pause: "Pause", replay: "Revoir l'étape", speed: "Vitesse", captions: "Sous-titres", voice: "Voix", steps: "Étapes", step: "Étape",
      transcript: "Transcription", download: "Télécharger (.txt)", watch: "Voir cette étape", language: "Langue",
      start: "Lancer la vidéo", note: "Avec voix et sous-titres", noteCaptions: "Avec sous-titres", ended: "Fin de la vidéo", again: "Cliquez pour la revoir",
      resume: "Reprend à l'étape {n} : {title}", next: "Aller à {title}",
      present: "Lancer la présentation", slide: "Diapositive", slidesNote: "{n} diapositives · plein écran, espace pour avancer", resumeSlide: "Reprend à la diapositive {n} : {title}",
      endSlides: "Fin de la présentation", againSlides: "Cliquez pour recommencer", previous: "Précédente", forward: "Suivante", notes: "Notes", fullscreen: "Plein écran" },
    de: { play: "Abspielen", pause: "Pause", replay: "Schritt wiederholen", speed: "Tempo", captions: "Untertitel", voice: "Stimme", steps: "Schritte", step: "Schritt",
      transcript: "Transkript", download: "Herunterladen (.txt)", watch: "Diesen Schritt ansehen", language: "Sprache",
      start: "Video abspielen", note: "Mit Stimme und Untertiteln", noteCaptions: "Mit Untertiteln", ended: "Ende des Videos", again: "Klicken, um es erneut anzusehen",
      resume: "Beginnt bei Schritt {n}: {title}", next: "Weiter zu {title}",
      present: "Präsentation starten", slide: "Folie", slidesNote: "{n} Folien · Vollbild, Leertaste zum Weiterschalten", resumeSlide: "Beginnt bei Folie {n}: {title}",
      endSlides: "Ende der Präsentation", againSlides: "Klicken, um neu zu beginnen", previous: "Zurück", forward: "Weiter", notes: "Notizen", fullscreen: "Vollbild" }
  };

  /**
   * options (all optional): fluid (fill the container instead of stopping at the stage width, for docs pages),
   * lang (start in this language when the guide has it), langSelect (false hides the language selector),
   * duration (e.g. "about 1 min", shown with the play button before the video starts),
   * autoplay (start at once; if the browser refuses sound without a click, wait on the play button as usual),
   * next ({ title, href }: the video to propose in a banner over the picture when this one ends; title as text or per language).
   */
  function mount(root, DATA, options) {
    options = options || {};
    // the kit's theme/labels.json: new languages, or other words for the built-in ones
    Object.keys(DATA.labels || {}).forEach(function (l) {
      var mine = LABELS[l] || (LABELS[l] = {});
      Object.keys(DATA.labels[l]).forEach(function (k) { mine[k] = DATA.labels[l][k]; });
    });
    var guide = DATA.guide;
    var steps = guide.steps;
    var opts = guide.player || {};
    var speeds = opts.speeds && opts.speeds.length ? opts.speeds : [1];
    // slides: one slide per step, advanced by hand, no voice and no captions (the narration is the speaker's notes)
    var slides = guide.format === "slides";
    var captionMode = slides ? "off" : opts.captions || "below";
    var pronunciation = guide.pronunciation || {};
    var vw = guide.viewport.width;
    var vh = guide.viewport.height;
    var lang = guide.languages.indexOf(options.lang) >= 0 ? options.lang : guide.languages[0];
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function tx(v) { return v == null || typeof v === "string" ? v || "" : v[lang] != null ? v[lang] : v[Object.keys(v)[0]]; }
    function L(k, vars) {
      var d = LABELS[lang] || LABELS[String(lang).slice(0, 2)] || LABELS.en, s = d[k] || LABELS.en[k] || "";
      return s.replace(/\{(\w+)\}/g, function (_, v) { return vars && vars[v] != null ? vars[v] : ""; });
    }
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

    root.innerHTML =
      '<div class="cf-app cf-captions-' + captionMode + (slides ? " cf-slides" : "") + '" tabindex="-1">' +
      '<div class="cf-stage"><div class="cf-world">' +
      '<iframe class="cf-frame" scrolling="no" tabindex="-1"></iframe>' +
      '<div class="cf-ring"></div><div class="cf-cursor"></div>' +
      "</div>" +
      '<p class="cf-subs" aria-live="polite" hidden><span></span></p>' +
      '<button class="cf-big" aria-label="Play">' + ICON_PLAY + "</button>" +
      '<p class="cf-veil-text" aria-hidden="true"><strong></strong><span></span></p>' +
      '<a class="cf-up-next" hidden></a>' +
      '<a class="cf-brand" href="' + REPO + '" target="_blank" rel="noopener" title="Made with Cueflow">' + MARK + "<span>cueflow</span></a></div>" +
      '<div class="cf-caption" aria-live="polite"></div>' +
      '<div class="cf-sl-notes" aria-live="polite" hidden></div>' +
      '<div class="cf-bar"><button class="cf-play" aria-label="Play/Pause">' + ICON_PLAY + "</button>" +
      '<button class="cf-restart" aria-label="Replay">↺</button>' +
      '<button class="cf-sl-prev" type="button" hidden>‹</button><span class="cf-sl-count" hidden></span><button class="cf-sl-next" type="button" hidden>›</button>' +
      '<div class="cf-track"><div class="cf-fill"></div></div><div class="cf-chapters" role="group"></div>' +
      '<button class="cf-speed" hidden></button>' +
      '<button class="cf-cc" aria-pressed="true">CC</button>' +
      '<button class="cf-voice" aria-pressed="true" hidden></button>' +
      '<select class="cf-lang"></select>' +
      '<button class="cf-sl-notes-btn" type="button" aria-pressed="false" hidden></button><button class="cf-sl-full" type="button" hidden>' + ICON_FULL + "</button></div>" +
      '<details class="cf-transcript" hidden><summary><span class="cf-tr-title"></span><button class="cf-download" type="button"></button></summary><ol></ol></details>' +
      "</div>";

    var $ = function (s) { return root.querySelector(s); };
    var app = $(".cf-app"), stage = $(".cf-stage"), world = $(".cf-world"), frame = $(".cf-frame");
    var ring = $(".cf-ring"), cursor = $(".cf-cursor"), caption = $(".cf-caption"), subs = $(".cf-subs");
    var big = $(".cf-big"), playBtn = $(".cf-play"), fill = $(".cf-fill"), langSel = $(".cf-lang");
    var chapters = $(".cf-chapters"), speedBtn = $(".cf-speed"), ccBtn = $(".cf-cc"), voiceBtn = $(".cf-voice");
    var transcript = $(".cf-transcript");
    var veilTitle = $(".cf-veil-text strong"), veilNote = $(".cf-veil-text span");
    // the next video, proposed over the picture when this one ends (a docs site passes it; a lone guide has none)
    var nextLink = $(".cf-up-next");
    if (options.next && options.next.href) nextLink.href = options.next.href;
    else nextLink.remove();
    // the Cueflow mark: over the picture by default; in the control bar it never covers the scene
    var brand = $(".cf-brand");
    if (opts.brand === "off") brand.remove();
    else if (opts.brand === "controls") { brand.classList.add("cf-brand-bar"); $(".cf-bar").appendChild(brand); }

    stage.style.aspectRatio = guide.stage.width + " / " + guide.stage.height;
    // a page that must fit the player in a height narrows it with this ratio, instead of cropping the picture
    app.style.setProperty("--cf-aspect", String(guide.stage.width / guide.stage.height));
    if (!options.fluid) app.style.maxWidth = guide.stage.width + "px";
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
    // a docs site chooses the language for every player at once: then the player has no selector of its own
    if (guide.languages.length < 2 || options.langSelect === false) langSel.style.display = "none";
    langSel.value = lang;

    // ---- runtime state ----
    var curScene = null;
    var cam = null; // last camera spec
    var cur = null; // { i, t, total, narrDur, actions[], audio, speaking }
    var playing = false;
    var loading = false;
    var last = 0;
    var raf = 0;
    // A sleeping sound device (Bluetooth, power saving) swallows the start of a sound and fades it in. While playing, a
    // silent stream keeps the device open; every Play makes the clock and the voice wait a moment for it to wake.
    var keepAlive = null, holdUntil = 0;
    function wake() {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        if (!keepAlive) {
          keepAlive = new Ctx();
          var src = keepAlive.createBufferSource();
          // digital silence does not wake most devices (or is dropped before it gets there): a noise around -60 dB is a signal nobody hears
          var buf = keepAlive.createBuffer(1, keepAlive.sampleRate, keepAlive.sampleRate), data = buf.getChannelData(0);
          for (var k = 0; k < data.length; k++) data[k] = (Math.random() * 2 - 1) * 0.001;
          src.buffer = buf; // a second, looped
          src.loop = true; src.connect(keepAlive.destination); src.start();
        }
        keepAlive.resume();
      } catch (e) { keepAlive = null; }
    }
    // autoplay (a docs site arriving from "Go to …"): the browser may refuse sound without a click on this page.
    // Then the video goes back to its play button instead of running silent; once a sound has played, nothing changes.
    var autoTrying = false;
    function playSound(a) {
      return a.play().then(function () { autoTrying = false; }, function (e) {
        if (!autoTrying || !e || e.name !== "NotAllowedError") return;
        autoTrying = false;
        setPlaying(false);
        app.classList.remove("cf-started");
        paintVeil();
      });
    }
    function startAudio(a) {
      var wait = holdUntil - performance.now();
      if (wait > 0) setTimeout(function () { if (playing && cur && cur.audio === a) playSound(a); }, wait);
      else playSound(a);
    }
    var speed = speeds[0];
    var captionsOn = captionMode !== "off";
    var voiceOn = true;
    var sceneStepIndex = {}; // step index -> scene name

    (function () {
      var s = guide.scene;
      steps.forEach(function (st, i) { if (st.scene) s = st.scene; sceneStepIndex[i] = s; });
    })();

    function doc() { return frame.contentDocument; }
    function $el(sel) { try { return doc().querySelector(sel); } catch (e) { return null; } }
    function ms(v) { return reduce ? 0 : v / speed; } // CSS transition time at the current speed

    // ---- easing: the CSS curves, solved here so that every motion runs on the step clock (pausable, seekable) ----
    var CURVES = { linear: [0, 0, 1, 1], ease: [.25, .1, .25, 1], "ease-in": [.42, 0, 1, 1], "ease-out": [0, .58, 1, 1], "ease-in-out": [.42, 0, .58, 1], standard: [.4, 0, .2, 1] };
    var easeCache = {};
    function bezier(x1, y1, x2, y2) {
      function sample(a, b, t) { return ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t; }
      return function (x) {
        if (x <= 0) return 0; if (x >= 1) return 1;
        var t = x;
        for (var i = 0; i < 6; i++) { var d = sample(x1, x2, t) - x; if (Math.abs(d) < 1e-4) break; var sl = (3 * (1 - 3 * x2 + 3 * x1) * t + 2 * (3 * x2 - 6 * x1)) * t + 3 * x1; if (Math.abs(sl) < 1e-6) break; t -= d / sl; }
        return sample(y1, y2, Math.max(0, Math.min(1, t)));
      };
    }
    function easeFn(name) {
      if (name === "spring") return function (p) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
      if (!easeCache[name]) {
        var pts = CURVES[name] || (/^cubic-bezier\(/.test(name) ? name.slice(13, -1).split(",").map(parseFloat) : CURVES["ease-out"]);
        easeCache[name] = bezier(pts[0], pts[1], pts[2], pts[3]);
      }
      return easeCache[name];
    }
    var DEFAULT_EASING = { move: "standard", camera: "standard", scroll: "ease-in-out", tween: "ease-out", show: "ease-out", hide: "ease-in", count: "ease-out" };
    function eased(a, p) { return easeFn(a.easing || DEFAULT_EASING[a.do] || "ease-out")(p); }
    function $all(sel) { try { return Array.prototype.slice.call(doc().querySelectorAll(sel)); } catch (e) { return []; } }

    /* stylesheets and images shared by the scenes travel once in DATA.shared; the scenes keep placeholders */
    function withShared(html) {
      var shared = DATA.shared || {};
      return String(html)
        .replace(/<style data-cf-style="([0-9a-f]+)"><\/style>/g, function (_, h) { return "<style>" + (shared[h] || "") + "</style>"; })
        .replace(/cf-shared:([0-9a-f]+)/g, function (_, h) { return shared[h] || ""; });
    }

    function loadScene(name) {
      return new Promise(function (resolve) {
        frame.onload = function () { frame.onload = null; resolve(); };
        // the translated version of the screen, when the kit has one for this language
        var own = DATA.sceneLang && DATA.sceneLang[lang] && DATA.sceneLang[lang][name];
        frame.srcdoc = withShared(own || DATA.scenes[name]);
        curScene = lang + "/" + name;
        cursor.style.opacity = "0";
        ring.style.opacity = "0";
        cursorPos = null;
      });
    }
    var cursorPos = null; // where the cursor is, in scene pixels; null = not shown yet
    function putCursor(x, y) { cursorPos = { x: x, y: y }; cursor.style.transform = "translate(" + x + "px," + y + "px)"; }

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
    /** Where the camera goes for a spec: scale and translation of the world, clamped to the scene. */
    function cameraFor(spec) {
      var SW = stage.clientWidth, SH = stage.clientHeight;
      var rect = spec ? rectOf(spec.target) : null;
      var pad = spec && spec.padding != null ? spec.padding : 24;
      if (!rect) rect = { x: 0, y: 0, width: vw, height: vh }, pad = 0;
      // never zoom out below the scale where the scene fills the stage: past that there is only empty space to show
      var s = Math.max(Math.min(SW / (rect.width + 2 * pad), SH / (rect.height + 2 * pad), 4), Math.max(SW / vw, SH / vh));
      var tx = SW / 2 - (rect.x + rect.width / 2) * s;
      var ty = SH / 2 - (rect.y + rect.height / 2) * s;
      // never show the empty space outside the scene: keep the scene covering the stage (or centered when smaller)
      tx = vw * s <= SW ? (SW - vw * s) / 2 : Math.min(0, Math.max(SW - vw * s, tx));
      ty = vh * s <= SH ? (SH - vh * s) / 2 : Math.min(0, Math.max(SH - vh * s, ty));
      return { s: s, tx: tx, ty: ty };
    }
    var camNow = { s: 1, tx: 0, ty: 0 }, camAnim = null; // the step's own framing in flight (enterStep), driven by tick
    function setCam(c) { camNow = c; world.style.transform = "translate(" + c.tx + "px," + c.ty + "px) scale(" + c.s + ")"; }
    function lerpCam(a, b, p) { return { s: a.s + (b.s - a.s) * p, tx: a.tx + (b.tx - a.tx) * p, ty: a.ty + (b.ty - a.ty) * p }; }
    /** Frames `spec` now (dur 0) or over `dur` ms of step time. */
    function applyCamera(spec, dur) {
      cam = spec || null;
      var to = cameraFor(spec);
      if (!dur || reduce) { camAnim = null; setCam(to); return; }
      camAnim = { from: camNow, to: to, start: cur ? cur.t : 0, dur: dur, ease: easeFn("standard") };
    }
    function tickCamera(t) {
      if (!camAnim) return;
      var p = Math.min(1, (t - camAnim.start) / camAnim.dur);
      setCam(lerpCam(camAnim.from, camAnim.to, camAnim.ease(p)));
      if (p >= 1) camAnim = null;
    }
    // re-frame whenever the stage changes size (window, side panels, a docs page settling its layout)
    if ("ResizeObserver" in window) new ResizeObserver(function () { applyCamera(cam, 0); }).observe(stage);
    else window.addEventListener("resize", function () { applyCamera(cam, 0); });

    // ---- actions: start / update(p) / finish ----
    function center(el) {
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function fire(el) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function parseNum(v) {
      var m = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(String(v).trim());
      return m ? { n: parseFloat(m[1]), unit: m[2] } : { n: 0, unit: "" };
    }
    var handlers = {
      move: {
        start: function (a) {
          var el = $el(a.to);
          a._to = el ? center(el) : null;
          if (!a._to) return;
          cursor.style.opacity = "1";
          a._from = cursorPos || a._to; // a cursor not shown yet appears where it is going
        },
        update: function (a, p) {
          if (!a._to) return;
          var e = eased(a, p);
          putCursor(a._from.x + (a._to.x - a._from.x) * e, a._from.y + (a._to.y - a._from.y) * e);
        }
      },
      click: {
        start: function (a, ctx) {
          var el = $el(a.to);
          if (!el) return;
          var c = center(el);
          cursor.style.opacity = "1";
          putCursor(c.x, c.y);
          if (!ctx.instant) cursor.classList.add("cf-click");
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: frame.contentWindow }));
        },
        finish: function () { cursor.classList.remove("cf-click"); }
      },
      type: {
        update: function (a, p) {
          var el = $el(a.to);
          if (!el) return;
          var full = tx(a.text);
          var text = full.slice(0, Math.round(full.length * p));
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
        start: function (a, ctx) {
          var el = $el(a.to);
          if (!el) return;
          animated(a, el, ctx);
          if (a.text != null) el.textContent = tx(a.text);
          if (a.html != null) el.innerHTML = tx(a.html);
          (a.add || []).forEach(function (c) { el.classList.add(c); });
          (a.remove || []).forEach(function (c) { el.classList.remove(c); });
          Object.keys(a.attr || {}).forEach(function (k) { el.setAttribute(k, a.attr[k]); });
        },
        finish: unanimate
      },
      select: {
        start: function (a, ctx) {
          var el = $el(a.to);
          if (!el || !el.options) return;
          animated(a, el, ctx);
          var want = tx(a.option), opts = Array.prototype.slice.call(el.options);
          var o = opts.filter(function (x) { return x.text.trim() === want; })[0] || opts.filter(function (x) { return x.value === want; })[0];
          if (!o) return;
          opts.forEach(function (x) { x.removeAttribute("selected"); });
          o.setAttribute("selected", ""); // the attribute too: a later reload of the scene state must not undo it
          el.value = o.value;
          fire(el);
        },
        finish: unanimate
      },
      value: {
        start: function (a, ctx) {
          var el = $el(a.to);
          if (!el) return;
          animated(a, el, ctx);
          var v = tx(a.value);
          if ("value" in el) { el.value = v; if (el.tagName === "INPUT") el.setAttribute("value", v); else if (el.tagName === "TEXTAREA") el.textContent = v; }
          else el.textContent = v;
          fire(el);
        },
        finish: unanimate
      },
      check: {
        start: function (a, ctx) {
          var el = $el(a.to);
          if (!el) return;
          animated(a, el, ctx);
          el.checked = a.checked !== false;
          if (el.checked) el.setAttribute("checked", ""); else el.removeAttribute("checked");
          fire(el);
        },
        finish: unanimate
      },
      show: {
        start: function (a) {
          a._els = targets(a);
          if (effective(a)) a._els.forEach(function (el) { el._cfStyle = { opacity: el.style.opacity, transform: el.style.transform }; reveal(el); entrance(el, a.effect, 0); });
        },
        update: function (a, p) {
          (a._els || []).forEach(function (el, k) {
            var q = local(a, p, k);
            if (effective(a)) entrance(el, a.effect, eased(a, q));
            else if (q > 0 || !a.stagger) reveal(el); // no entrance: each one appears at its own moment
          });
        },
        finish: function (a) { (a._els || []).forEach(restoreStyle); }
      },
      hide: {
        start: function (a) {
          a._els = targets(a);
          if (effective(a)) a._els.forEach(function (el) { el._cfStyle = { opacity: el.style.opacity, transform: el.style.transform }; });
        },
        update: function (a, p) {
          (a._els || []).forEach(function (el, k) {
            var q = local(a, p, k);
            if (effective(a)) entrance(el, a.effect, 1 - eased(a, q));
            else if (q > 0 || !a.stagger) el.style.display = "none";
          });
        },
        finish: function (a) { (a._els || []).forEach(function (el) { restoreStyle(el); el.style.display = "none"; }); }
      },
      tween: {
        update: function (a, p) {
          var el = $el(a.to);
          if (!el) return;
          var f = parseNum(a.from), e = parseNum(a.end), q = eased(a, p);
          el.style[a.prop] = f.n + (e.n - f.n) * q + (e.unit || f.unit);
        }
      },
      count: {
        start: function (a) {
          var el = $el(a.to);
          if (!el) return;
          var f = a.format || {}, loc = f.locale || lang;
          var from = a.from != null ? a.from : numberIn(el.textContent, loc);
          a._from = isFinite(from) ? from : 0;
          var dec = f.decimals != null ? f.decimals : Math.max(decimalsOf(a._from), decimalsOf(a.end));
          a._fmt = new Intl.NumberFormat(loc, { minimumFractionDigits: dec, maximumFractionDigits: dec });
          a._pre = f.prefix != null ? tx(f.prefix) : ""; a._suf = f.suffix != null ? tx(f.suffix) : "";
        },
        update: function (a, p) {
          var el = $el(a.to);
          if (!el || !a._fmt) return;
          var v = p >= 1 ? a.end : a._from + (a.end - a._from) * eased(a, p);
          el.textContent = a._pre + a._fmt.format(v) + a._suf;
        }
      },
      scroll: {
        /* just enough to show the element (below, or above), measured when the action starts */
        start: function (a) {
          var box = $el(a.in), el = $el(a.to);
          a._box = box;
          if (!box || !el) return;
          var b = box.getBoundingClientRect(), r = el.getBoundingClientRect(), m = a.margin != null ? a.margin : 24;
          var target = box.scrollTop;
          if (r.bottom + m > b.bottom) target += r.bottom + m - b.bottom;
          else if (r.top - m < b.top) target -= b.top - (r.top - m);
          a._from = box.scrollTop;
          a._to = Math.max(0, Math.min(target, box.scrollHeight - box.clientHeight));
        },
        update: function (a, p) {
          if (!a._box || a._to == null) return;
          a._box.scrollTop = a._from + (a._to - a._from) * eased(a, p);
        }
      },
      camera: {
        start: function (a) {
          camAnim = null; // the step's own framing yields to the action
          cam = { target: a.target, padding: a.padding };
          a._from = camNow; a._to = cameraFor(cam);
        },
        update: function (a, p) { if (a._to) setCam(p >= 1 ? a._to : lerpCam(a._from, a._to, eased(a, p))); }
      }
    };
    /* show/hide helpers: which elements (all of them with a stagger), each one's own progress, the entrance itself */
    function targets(a) { return a.stagger != null ? $all(a.to) : [$el(a.to)].filter(Boolean); }
    function reveal(el) { el.removeAttribute("hidden"); el.style.display = ""; }
    function effective(a) { return a.effect && a.effect !== "none" && !reduce; }
    function local(a, p, k) {
      var n = a._els.length, total = a.duration + (n - 1) * (a.stagger || 0), t = p * total;
      return a.duration > 0 ? Math.max(0, Math.min(1, (t - k * (a.stagger || 0)) / a.duration)) : 1;
    }
    var OFFSETS = { "slide-up": [0, 12], "slide-down": [0, -12], "slide-left": [12, 0], "slide-right": [-12, 0] };
    function entrance(el, effect, q) {
      el.style.opacity = String(q);
      var o = OFFSETS[effect];
      if (o) el.style.transform = "translate(" + o[0] * (1 - q) + "px," + o[1] * (1 - q) + "px)";
      else if (effect === "scale") el.style.transform = "scale(" + (0.96 + 0.04 * q) + ")";
    }
    function restoreStyle(el) {
      if (!el._cfStyle) return;
      el.style.opacity = el._cfStyle.opacity; el.style.transform = el._cfStyle.transform;
      delete el._cfStyle;
    }
    /* `animate`: the site's CSS gets a transition for the time of the change, whatever it animates by itself */
    function animated(a, el, ctx) {
      if (!a.animate || ctx.instant || reduce) return;
      a._el = el; el._cfTransition = el.style.transition;
      el.style.transition = "all " + a.animate + "ms";
      void el.offsetWidth; // the transition must be in place before the change
    }
    function unanimate(a) { var el = a._el; if (el && el._cfTransition != null) { el.style.transition = el._cfTransition; delete el._cfTransition; } a._el = null; }
    /* the number written in an element, read the way the locale writes it ("1.234,5" in Italian) */
    function numberIn(text, loc) {
      var dec = (new Intl.NumberFormat(loc).formatToParts(1.1).filter(function (x) { return x.type === "decimal"; })[0] || {}).value || ".";
      var m = /-?[\d.,\s\u00a0\u202f']+/.exec(text || "");
      if (!m) return NaN;
      var raw = m[0].replace(/[\s\u00a0\u202f']/g, "");
      raw = dec === "," ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
      return parseFloat(raw);
    }
    function decimalsOf(n) { var s = String(n); return s.indexOf(".") >= 0 ? s.length - s.indexOf(".") - 1 : 0; }
    function staggerSpan(a) { return a.stagger ? Math.max(0, (a.stagger != null ? $all(a.to).length : 1) - 1) * a.stagger : 0; }
    /** How long an action takes on the step clock (step time already runs at the chosen speed). */
    function durationOf(a) {
      if (a.do === "click") return CLICK_MS;
      if (reduce && a.do !== "type" && a.do !== "count") return 0;
      if (a.do === "show" || a.do === "hide") return a.duration + staggerSpan(a);
      if (a.do === "set" || a.do === "check" || a.do === "select" || a.do === "value") return a.animate || 0;
      if (a.do === "scroll") return a.duration != null ? a.duration : 450;
      return a.duration || 0;
    }
    function endOf(a, narrDur) { return atMs(a, narrDur) + (a.do === "click" ? CLICK_MS : a.animate != null ? a.animate : (a.duration != null ? a.duration : 0) + staggerSpan(a)); }
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

    // ---- voice ----
    function estimate(text) { return text ? Math.max(1500, text.length * MS_PER_CHAR) : 1500; }
    function spoken(text) {
      var out = text;
      Object.keys(pronunciation).forEach(function (w) {
        if (!w) return;
        var re = new RegExp("(^|[^\\p{L}\\p{N}])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}])", "gu");
        out = out.replace(re, function (_, pre) { return pre + pronunciation[w]; });
      });
      return out;
    }

    function audioUrl(i) {
      var m = DATA.audio[lang];
      return m && m[steps[i].id] ? m[steps[i].id] : null;
    }
    function audioDuration(url) {
      return new Promise(function (resolve) {
        var a = new Audio();
        var done = false;
        function fin(v) { if (!done) { done = true; resolve({ audio: a, ms: v }); } }
        a.preload = "auto"; // decoded before play(): a cold start also eats the first words
        a.onloadedmetadata = function () { fin(isFinite(a.duration) ? a.duration * 1000 : null); };
        a.onerror = function () { fin(null); };
        setTimeout(function () { fin(null); }, 1500);
        a.src = url;
      });
    }

    /* The browser's own voice, for silent builds that ask for it: a preview, it differs from machine to machine. */
    var synth = !slides && opts.fallbackVoice === "browser" && "speechSynthesis" in window ? window.speechSynthesis : null;
    var sysVoice = null;
    function pickVoice() {
      if (!synth) return;
      var all = synth.getVoices(), base = String(lang).slice(0, 2).toLowerCase();
      var mine = all.filter(function (v) { return String(v.lang).toLowerCase().indexOf(base) === 0; });
      sysVoice = mine.filter(function (v) { return /Google|Natural|Online/i.test(v.name); })[0] || mine[0] || null;
    }
    if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }
    function speak(c, text) {
      if (!synth || !voiceOn || !text) return;
      if (!sysVoice) pickVoice(); // the list of voices loads late: ask again before speaking
      synth.cancel();
      var u = new SpeechSynthesisUtterance(spoken(text));
      u.lang = lang;
      if (sysVoice) u.voice = sysVoice;
      u.rate = Math.min(speed, 2);
      c.speaking = true;
      c.utter = u;
      u.onend = u.onerror = function () { if (c.utter === u) c.speaking = false; }; // a cancelled utterance ends late
      synth.speak(u);
    }
    function stopVoice() { if (synth) synth.cancel(); if (cur) { cur.speaking = false; cur.utter = null; } }

    // ---- steps ----
    async function enterStep(i, instant) {
      var st = steps[i];
      var sceneName = sceneStepIndex[i];
      if (lang + "/" + sceneName !== curScene) { await loadScene(sceneName); cam = null; }
      var text = st.narration[lang] || "";
      var url = audioUrl(i);
      var info = url ? await audioDuration(url) : { audio: null, ms: null };
      var narrDur = info.ms != null ? info.ms : estimate(text);
      var actions = st.actions.map(function (a) { return { a: a, at: atMs(a, narrDur), started: false, done: false }; });
      var lastEnd = 0;
      st.actions.forEach(function (a) { lastEnd = Math.max(lastEnd, endOf(a, narrDur)); });
      cur = { i: i, t: 0, total: Math.max(narrDur, lastEnd) + (st.hold != null ? st.hold : 600), narrDur: narrDur, actions: actions, text: text,
        audio: info.audio && info.ms != null ? info.audio : null, speaking: false,
        // a step can be muted ("none") in this language: no browser voice either
        mute: !!(st.voice && st.voice[lang] && st.voice[lang].provider === "none") };
      if (cur.audio) { cur.audio.playbackRate = speed; cur.audio.muted = !voiceOn; }
      showCaption(text);
      if (slides) paintSlide();
      applyCamera(st.camera || cam, instant ? 0 : 700);
      if (!instant && playing) {
        if (cur.audio) { cur.audio.currentTime = 0; playSound(cur.audio); }
        else if (!cur.mute) speak(cur, text);
      }
      paintChapters();
    }

    function showCaption(text) {
      caption.textContent = captionMode === "below" && captionsOn ? text : "";
      subs.firstChild.textContent = text;
      subs.hidden = !(captionMode === "overlay" && captionsOn && text);
    }

    function setPlaying(v) {
      playing = v;
      // an editor playing slides along their timeline (Studio): the groups waiting for a press keep their own time
      if (v && slides && cur) { stopAnim(); cur.actions.forEach(function (x) { if (x.at === NEVER && x.at0 != null) x.at = x.at0; }); }
      if (v) app.classList.add("cf-started"); // themes can style the untouched player (veil, poster) apart from a paused one
      app.classList.toggle("cf-playing", v);
      playBtn.innerHTML = v ? ICON_PAUSE : ICON_PLAY;
      playBtn.setAttribute("aria-label", v ? L("pause") : L("play"));
      var now = performance.now();
      if (v) { holdUntil = now + 800; wake(); }
      else { if (keepAlive) keepAlive.suspend().catch(function () {}); }
      if (cur && cur.audio) { if (v) startAudio(cur.audio); else cur.audio.pause(); }
      if (synth) {
        if (!v) synth.pause();
        else if (cur && cur.speaking) synth.resume();
        else if (cur && !cur.audio && !cur.mute && cur.t < cur.narrDur) { synth.resume(); speak(cur, cur.text); }
      }
      if (v) { last = performance.now(); raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf);
    }

    function progressBar() {
      var done = 0, total = 0;
      steps.forEach(function (_, i) { total += 1; if (cur && i < cur.i) done += 1; });
      var within = cur && cur.total ? Math.min(1, cur.t / cur.total) : 0;
      fill.style.width = ((done + within) / Math.max(total, 1)) * 100 + "%";
      var seg = chapters.children[cur ? cur.i : 0];
      if (seg) seg.firstChild.firstChild.style.width = within * 100 + "%";
    }

    function tick(ts) {
      if (!playing || loading) { if (playing) raf = requestAnimationFrame(tick); return; }
      if (ts < holdUntil) { last = ts; raf = requestAnimationFrame(tick); return; }
      var dt = ts - last;
      last = ts;
      cur.t += dt * speed;
      tickCamera(cur.t);
      runDue(cur, cur.t, { instant: false });
      progressBar();
      // the browser voice has no known length: wait for it to finish, within a generous bound
      var waitVoice = cur.speaking && cur.t < cur.total + 2 * cur.narrDur;
      if (cur.t >= cur.total && !waitVoice) {
        if (cur.audio) cur.audio.pause();
        var next = cur.i + 1;
        if (next >= steps.length) { setPlaying(false); app.classList.add("cf-ended"); showCaption(""); paintChapters(); paintVeil(); return; }
        loading = true;
        enterStep(next, false).then(function () { loading = false; last = performance.now(); });
      }
      raf = requestAnimationFrame(tick);
    }

    /** Replays the steps before i instantly and stops at the start of step i (or at time t within it). */
    async function goTo(i, t) {
      stopVoice();
      if (cur && cur.audio) cur.audio.pause();
      loading = true;
      app.classList.remove("cf-ended");
      await loadScene(guide.scene);
      cam = null;
      for (var k = 0; k < i; k++) {
        await enterStep(k, true);
        runDue(cur, Infinity, { instant: true });
      }
      await enterStep(i, true);
      // t: ms into the step, or a percentage of its narration ("80%") like an action's `at`
      t = typeof t === "string" ? atMs({ at: t }, cur.narrDur) : t || 0;
      runDue(cur, t, { instant: true });
      cur.t = t;
      loading = false;
      progressBar();
      paintVeil();
    }

    async function restart() { await goTo(0, 0); }

    /** Jumps to a step and plays from there (chapters, transcript links, keyboard). */
    async function jump(i) {
      i = Math.max(0, Math.min(steps.length - 1, i));
      if (slides) { app.classList.add("cf-started"); await showSlide(i, false); return; }
      setPlaying(false);
      await goTo(i, 0);
      setPlaying(true);
    }

    /** Jumps to a point of the timeline (used by previews): replays everything before it instantly. */
    async function seek(i, t, l) {
      setPlaying(false);
      if (l) { lang = l; langSel.value = l; pickVoice(); }
      await goTo(i, t);
      app.classList.add("cf-ready");
      return { total: cur.total, narration: cur.narrDur, steps: steps.length };
    }

    /** Where an element of the current scene is, for checks (cueflow validate --layout): found, visible, inside the scene. */
    function probe(sel) {
      var el = $el(sel);
      if (!el) return { found: false };
      var r = el.getBoundingClientRect(), cs = frame.contentWindow.getComputedStyle(el);
      var visible = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      var rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      var inside = r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;
      var outside = r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh;
      return { found: true, visible: visible, rect: rect, inView: inside ? "full" : outside ? "none" : "part", viewport: { width: vw, height: vh } };
    }

    // ---- the words beside the big play button: what it does, and from where it starts ----
    function paintVeil() {
      paintNext();
      if (slides) {
        var endedSlides = app.classList.contains("cf-ended");
        veilTitle.textContent = endedSlides ? L("endSlides") : L("present");
        veilNote.textContent = endedSlides ? L("againSlides")
          : cur && cur.i > 0 ? L("resumeSlide", { n: cur.i + 1, title: stepTitle(steps[cur.i], cur.i) })
          : L("slidesNote", { n: steps.length });
        big.setAttribute("aria-label", veilTitle.textContent);
        return;
      }
      if (app.classList.contains("cf-ended")) {
        veilTitle.textContent = L("ended");
        veilNote.textContent = L("again");
        return;
      }
      veilTitle.textContent = L("start");
      if (cur && cur.i > 0) { veilNote.textContent = L("resume", { n: cur.i + 1, title: stepTitle(steps[cur.i], cur.i) }); return; }
      var parts = [];
      if (options.duration) parts.push(options.duration);
      parts.push(voiceBtn.hidden ? (captionMode === "off" ? "" : L("noteCaptions")) : L("note"));
      var note = parts.filter(Boolean).join(" · ");
      veilNote.textContent = note.charAt(0).toUpperCase() + note.slice(1);
    }

    /** "Go to {title}", with the title in bold: shown only once the video has ended. */
    function paintNext() {
      if (!nextLink.isConnected) return;
      var ended = app.classList.contains("cf-ended");
      nextLink.hidden = !ended;
      if (!ended) return;
      var parts = L("next", { title: "\u0000" }).split("\u0000");
      nextLink.innerHTML = "<span>" + esc(parts[0]) + "<b>" + esc(tx(options.next.title)) + "</b>" + esc(parts.slice(1).join("")) + '</span><i aria-hidden="true">→</i>';
    }

    // ---- chapters ----
    function stepTitle(st, i) { return tx(st.title) || L("step") + " " + (i + 1); }
    function buildChapters() {
      chapters.innerHTML = "";
      if (!opts.chapters) { app.classList.add("cf-no-chapters"); return; }
      chapters.setAttribute("aria-label", L("steps"));
      steps.forEach(function (st, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "cf-chap";
        b.title = stepTitle(st, i);
        b.innerHTML = "<i><b></b></i><small>" + (i + 1) + " · " + esc(stepTitle(st, i)) + "</small>";
        b.setAttribute("aria-label", L("step") + " " + (i + 1) + ": " + stepTitle(st, i));
        b.onclick = function () { jump(i); };
        chapters.appendChild(b);
      });
    }
    function paintChapters() {
      var ended = app.classList.contains("cf-ended");
      Array.prototype.forEach.call(chapters.children, function (c, i) {
        var now = !ended && cur && i === cur.i;
        c.classList.toggle("cf-past", ended || (cur && i < cur.i));
        c.classList.toggle("cf-now", !!now);
        if (now) c.setAttribute("aria-current", "step"); else c.removeAttribute("aria-current");
        if (!now) c.firstChild.firstChild.style.width = "";
      });
    }

    // ---- transcript ----
    function transcriptText() {
      var lines = [guide.title, ""];
      steps.forEach(function (st, i) { lines.push((i + 1) + ". " + stepTitle(st, i), st.narration[lang] || "", ""); });
      return lines.join("\n");
    }
    function buildTranscript() {
      if (!opts.transcript || slides) return;
      transcript.hidden = false;
      transcript.querySelector(".cf-tr-title").textContent = L("transcript");
      transcript.querySelector(".cf-download").textContent = L("download");
      transcript.querySelector("ol").innerHTML = steps.map(function (st, i) {
        return "<li><b>" + esc(stepTitle(st, i)) + "</b> " + esc(st.narration[lang] || "") +
          ' <a href="#step-' + (i + 1) + '" data-step="' + i + '">' + esc(L("watch")) + "</a></li>";
      }).join("");
    }
    transcript.querySelector(".cf-download").onclick = function (e) {
      e.preventDefault(); // it sits in the summary: do not open/close the panel
      downloadTranscript();
    };
    function downloadTranscript() {
      var blob = new Blob([transcriptText()], { type: "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = guide.id + "-" + lang + ".txt";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
    transcript.addEventListener("click", function (e) {
      var link = e.target.closest && e.target.closest("a[data-step]");
      if (!link) return;
      e.preventDefault();
      root.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      jump(+link.getAttribute("data-step"));
    });

    // ---- slides: advanced by hand, one press per group of actions ----
    /* A slide shows what its actions at 0 do as soon as it appears. Every other distinct `at` is one press, like an
       animation of a presentation: the actions of that group play together, with their own durations, then the slide
       waits. After the last group, the next press goes to the next slide. Time still flows (cur.t) so durations and
       transitions are the ones of the video; it only stops where a press is awaited. */
    var NEVER = Infinity; // `at` of a group not pressed yet: runDue never reaches it
    var FAR = 1e12; // a time after every action that has been pressed
    var anim = false, araf = 0, alast = 0, busy = false;
    var prevBtn = $(".cf-sl-prev"), fwdBtn = $(".cf-sl-next"), countEl = $(".cf-sl-count"), notesEl = $(".cf-sl-notes"), notesBtn = $(".cf-sl-notes-btn"), fullBtn = $(".cf-sl-full");
    var notesOn = false;
    var hasNotes = slides && steps.some(function (st) { return Object.keys(st.narration || {}).some(function (l) { return (st.narration[l] || "").trim(); }); });

    function arm() {
      var ats = [];
      cur.actions.forEach(function (x) { if (!x.started && ats.indexOf(x.at) < 0) ats.push(x.at); });
      ats.sort(function (a, b) { return a - b; });
      cur.groups = ats.map(function (t) { return cur.actions.filter(function (x) { return !x.started && x.at === t; }); });
      cur.groups.forEach(function (g) { g.forEach(function (x) { x.at0 = x.at; x.at = NEVER; }); });
      cur.g = 0;
    }
    function pending() { return cur.actions.some(function (x) { return x.at !== NEVER && !x.done; }); }
    function startAnim() {
      if (anim || !pending()) return;
      anim = true; alast = performance.now();
      araf = requestAnimationFrame(atick);
    }
    function atick(ts) {
      if (!anim) return;
      cur.t += Math.max(0, ts - alast); alast = ts;
      runDue(cur, cur.t, { instant: false });      if (pending()) araf = requestAnimationFrame(atick); else anim = false;
      paintSlide();
    }
    function stopAnim() { anim = false; cancelAnimationFrame(araf); }
    /** Ends what is moving now, at once: a press while a group is still playing completes it, like a presentation. */
    function finishAnim() {
      stopAnim();
      runDue(cur, FAR, { instant: true });
      paintSlide();
    }
    /** Shows slide i: at its opening (its actions at 0 run) or complete (every group done, as when going back). */
    async function showSlide(i, complete) {
      busy = true;
      stopAnim();
      await goTo(i, complete ? FAR : 0);
      arm();
      busy = false;
      startAnim(); // actions at 0 that last (a tween, typing) play out on arrival
      paintSlide();
    }
    function begin() {
      if (!cur) return;
      if (!cur.groups) arm(); // a seek (previews) left a fresh step behind
      app.classList.add("cf-started");
      app.classList.remove("cf-ended");
      startAnim();
      paintSlide();
      try { app.focus({ preventScroll: true }); } catch (e) { app.focus(); }
    }
    function slideNext() {
      if (busy || !cur) return;
      if (!app.classList.contains("cf-started")) return begin();
      if (!cur.groups) arm();
      if (app.classList.contains("cf-ended")) { if (isFull()) exitFull(); return; }
      if (anim) return finishAnim();
      if (cur.g < cur.groups.length) {
        cur.groups[cur.g++].forEach(function (x) { x.at = cur.t; });
        startAnim();
        return paintSlide();
      }
      if (cur.i < steps.length - 1) return showSlide(cur.i + 1, false);
      app.classList.add("cf-ended");
      paintVeil(); paintChapters(); paintSlide();
    }
    function slidePrev() {
      if (busy || !cur) return;
      app.classList.add("cf-started");
      if (app.classList.contains("cf-ended")) { app.classList.remove("cf-ended"); paintVeil(); paintChapters(); return paintSlide(); }
      if (cur.i > 0) return showSlide(cur.i - 1, true);
      showSlide(0, false);
    }
    function paintSlide() {
      if (!slides || !cur) return;
      countEl.textContent = (cur.i + 1) + " / " + steps.length;
      prevBtn.disabled = cur.i === 0 && !(cur.g > 0 || app.classList.contains("cf-ended"));
      fwdBtn.disabled = app.classList.contains("cf-ended");
      notesEl.textContent = (steps[cur.i].narration || {})[lang] || "";
      notesEl.hidden = !notesOn || !notesEl.textContent;
      // the chapter of this slide fills as its groups are pressed
      var seg = chapters.children[cur.i], within = cur.groups && cur.groups.length ? cur.g / cur.groups.length : 1;
      if (seg) seg.firstChild.firstChild.style.width = within * 100 + "%";
    }

    // full screen: on the player itself, so the bar and the notes come along
    function isFull() { return (document.fullscreenElement || document.webkitFullscreenElement) === app; }
    var canFull = !!(app.requestFullscreen || app.webkitRequestFullscreen);
    function enterFull() {
      if (!canFull || isFull()) return;
      try { var r = (app.requestFullscreen || app.webkitRequestFullscreen).call(app); if (r && r.catch) r.catch(function () {}); } catch (e) { /* refused: stays in the page */ }
    }
    function exitFull() {
      if (!isFull()) return;
      try { var r = (document.exitFullscreen || document.webkitExitFullscreen).call(document); if (r && r.catch) r.catch(function () {}); } catch (e) { /* already out */ }
    }
    function onFull() { app.classList.toggle("cf-full", isFull()); applyCamera(cam, 0); }
    document.addEventListener("fullscreenchange", onFull);
    document.addEventListener("webkitfullscreenchange", onFull);

    if (slides) {
      [prevBtn, countEl, fwdBtn].forEach(function (b) { b.hidden = false; });
      notesBtn.hidden = !hasNotes;
      fullBtn.hidden = !canFull;
      prevBtn.onclick = slidePrev;
      fwdBtn.onclick = slideNext;
      notesBtn.onclick = function () { notesOn = !notesOn; notesBtn.setAttribute("aria-pressed", String(notesOn)); paintSlide(); };
      fullBtn.onclick = function () { if (isFull()) exitFull(); else enterFull(); };
      // in full screen a click on the picture goes on, as with a presenter's remote; in the page the buttons do
      stage.addEventListener("click", function (e) {
        if (!isFull() || (e.target.closest && e.target.closest("a, button"))) return;
        slideNext();
      });
    }

    // ---- controls ----
    function labels() {
      prevBtn.setAttribute("aria-label", L("previous")); prevBtn.title = L("previous");
      fwdBtn.setAttribute("aria-label", L("forward")); fwdBtn.title = L("forward");
      notesBtn.textContent = L("notes");
      fullBtn.setAttribute("aria-label", L("fullscreen")); fullBtn.title = L("fullscreen");
      $(".cf-restart").setAttribute("aria-label", L("replay"));
      $(".cf-restart").title = L("replay");
      ccBtn.title = L("captions");
      speedBtn.title = L("speed");
      voiceBtn.title = L("voice");
      voiceBtn.textContent = L("voice");
      langSel.title = L("language");
      playBtn.setAttribute("aria-label", playing ? L("pause") : L("play"));
      big.setAttribute("aria-label", L("play"));
    }
    if (speeds.length > 1 && !slides) { speedBtn.hidden = false; speedBtn.textContent = speed + "×"; }
    if (captionMode === "off") ccBtn.hidden = true;
    voiceBtn.hidden = !(synth || Object.keys(DATA.audio || {}).length);

    big.onclick = playBtn.onclick = async function () {
      if (slides) {
        // presenting means full screen; where the browser cannot (iPhone), the slides run in the page
        enterFull();
        if (app.classList.contains("cf-ended")) await showSlide(0, false);
        return begin();
      }
      if (playing) return setPlaying(false);
      if (!cur || app.classList.contains("cf-ended")) await restart();
      setPlaying(true);
    };
    $(".cf-restart").onclick = function () { jump(cur ? cur.i : 0); };
    speedBtn.onclick = function () {
      speed = speeds[(speeds.indexOf(speed) + 1) % speeds.length];
      speedBtn.textContent = speed + "×";
      if (cur && cur.audio) cur.audio.playbackRate = speed;
    };
    ccBtn.onclick = function () {
      captionsOn = !captionsOn;
      ccBtn.setAttribute("aria-pressed", String(captionsOn));
      showCaption(cur ? cur.text : "");
    };
    voiceBtn.onclick = function () {
      voiceOn = !voiceOn;
      voiceBtn.setAttribute("aria-pressed", String(voiceOn));
      if (cur && cur.audio) cur.audio.muted = !voiceOn;
      if (!voiceOn) stopVoice();
    };
    langSel.onchange = async function () {
      lang = langSel.value;
      pickVoice();
      labels(); buildChapters(); buildTranscript(); paintVeil();
      if (slides) return showSlide(cur ? cur.i : 0, false);
      var was = playing;
      setPlaying(false);
      await goTo(cur ? cur.i : 0, 0);
      if (was) setPlaying(true);
    };
    /* the keys of a presentation: forward with space, arrows, Page Down (what a presenter's remote sends) */
    function slideKey(e) {
      var k = e.key;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === " " || k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === "Enter") {
        e.preventDefault();
        // starting from the keyboard is presenting: full screen, like the big button (the buttons of the bar browse in the page)
        if (!app.classList.contains("cf-started")) enterFull();
        slideNext();
      }
      else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") { e.preventDefault(); slidePrev(); }
      else if (k === "Home") { e.preventDefault(); jump(0); }
      else if (k === "End") { e.preventDefault(); app.classList.add("cf-started"); showSlide(steps.length - 1, true); }
      else if (k === "n" || k === "N") { if (!notesBtn.hidden) notesBtn.click(); }
      else if (k === "f" || k === "F") { if (canFull) fullBtn.click(); }
    }
    if (slides) document.addEventListener("keydown", function (e) {
      // in full screen the keys belong to the presentation even when the focus has slipped out of the player
      if (isFull() && !(e.target && app.contains(e.target))) slideKey(e);
    });
    app.addEventListener("keydown", function (e) {
      if (e.target.closest && e.target.closest("select, summary, a, input, textarea")) return;
      if (slides) return slideKey(e);
      if (e.key === " ") { e.preventDefault(); playBtn.click(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); jump((cur ? cur.i : 0) + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); jump(cur ? cur.i : 0); }
    });

    labels();
    buildChapters();
    buildTranscript();

    /* a link to a step (#step-3, counted from 1) opens the player there, ready to play; followed later, it plays.
       The word for "step" in the guide's languages works too (#passo-3), so links written for a translated page keep working. */
    function plain(w) { return String(w).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
    function stepFromHash() {
      var m = /^#([^-\d]+)-(\d+)$/.exec(decodeURIComponent(location.hash));
      if (!m) return null;
      var word = plain(m[1]), ok = word === "step" || guide.languages.some(function (l) {
        var d = LABELS[l] || LABELS[String(l).slice(0, 2)];
        return d && d.step && plain(d.step) === word;
      });
      return ok ? Math.max(0, Math.min(steps.length - 1, +m[2] - 1)) : null;
    }
    window.addEventListener("hashchange", function () {
      var i = stepFromHash();
      if (i == null) return;
      root.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      jump(i);
    });
    var opening = goTo(stepFromHash() || 0, 0);
    // slides wait at their opening for the first press; they never start on their own
    if (slides) opening.then(function () { arm(); paintSlide(); paintVeil(); });
    else if (options.autoplay) opening.then(function () {
      // a step without its own audio has nothing that could be refused: it just plays
      autoTrying = !!(cur && cur.audio);
      setPlaying(true);
    });
    return {
      seek: seek, probe: probe, restart: restart, jump: jump, transcript: transcriptText, downloadTranscript: downloadTranscript,
      // slides: what a press of the space bar and of the back key do
      next: slideNext, previous: slidePrev, slides: slides,
      // for an editor that draws its own transport (Studio's timeline): where we are, and play/pause from outside
      state: function () { return { step: cur ? cur.i : 0, t: cur ? cur.t : 0, total: cur ? cur.total : 0, playing: playing, loading: loading, ended: app.classList.contains("cf-ended") }; },
      play: async function () { if (playing) return; if (!cur || app.classList.contains("cf-ended")) await restart(); setPlaying(true); },
      pause: function () { setPlaying(false); },
      element: app, steps: function () { return steps.map(function (st, i) { return stepTitle(st, i); }); },
      setLang: function (l) { lang = l; langSel.value = l; pickVoice(); }
    };
  }

  window.Cueflow = { mount: mount };
})();
