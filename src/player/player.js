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
      '<div class="cf-spot"></div><div class="cf-ring"></div><div class="cf-cursor"></div>' +
      "</div>" +
      '<div class="cf-av-ghost" hidden aria-hidden="true"><div class="cf-av-face"></div></div>' +
      '<div class="cf-avatar" hidden aria-hidden="true"><div class="cf-av-face"></div></div>' +
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
    var ring = $(".cf-ring"), spot = $(".cf-spot"), cursor = $(".cf-cursor"), caption = $(".cf-caption"), subs = $(".cf-subs");
    var big = $(".cf-big"), playBtn = $(".cf-play"), fill = $(".cf-fill"), langSel = $(".cf-lang");
    var chapters = $(".cf-chapters"), speedBtn = $(".cf-speed"), ccBtn = $(".cf-cc"), voiceBtn = $(".cf-voice");
    var transcript = $(".cf-transcript");
    var veilTitle = $(".cf-veil-text strong"), veilNote = $(".cf-veil-text span");
    // the next video, proposed over the picture when this one ends (a docs site passes it; a lone guide has none)
    var nextLink = $(".cf-up-next");
    if (options.next && options.next.href) { nextLink.href = options.next.href; nextLink.setAttribute("data-cf-cta", "next-video"); }
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
    /* what a page around the player may want to count (a docs site turns these into analytics events): DOM events on
       the mount root, cueflow:play (first: the first one of this mount), cueflow:progress at 25/50/75% of the bar
       (once each), cueflow:ended. Only while playing: seeks and the instant replay of earlier steps send nothing. */
    var played = false, reached = {};
    function emit(name, detail) {
      try { root.dispatchEvent(new CustomEvent("cueflow:" + name, { bubbles: true, detail: detail || {} })); } catch (e) { /* an old browser: nothing to count */ }
    }
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
    /* a shared part is its content (a guide built on its own) or { url } (a docs site, where the parts are files) */
    function withShared(html) {
      var shared = DATA.shared || {};
      return String(html)
        .replace(/<style data-cf-style="([0-9a-f]+)"><\/style>/g, function (_, h) {
          var v = shared[h];
          return v && v.url ? '<link rel="stylesheet" href="' + v.url + '">' : "<style>" + hoverable(v || "") + "</style>";
        })
        .replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, function (_, attrs, css) { return "<style" + attrs + ">" + hoverable(css) + "</style>"; })
        .replace(/cf-shared:([0-9a-f]+)/g, function (_, h) { var v = shared[h]; return v && v.url ? v.url : v || ""; });
    }
    /* the scene never sees a real pointer: its :hover rules answer to .cf-hover, which the hover action sets */
    function hoverable(css) { return css.replace(/:hover\b/g, ".cf-hover"); }

    function loadScene(name) {
      return new Promise(function (resolve) {
        frame.onload = function () { frame.onload = null; resolve(); };
        // the translated version of the screen, when the kit has one for this language
        var own = DATA.sceneLang && DATA.sceneLang[lang] && DATA.sceneLang[lang][name];
        frame.srcdoc = withShared(own || DATA.scenes[name]);
        curScene = lang + "/" + name;
        cursor.style.opacity = "0";
        ring.style.opacity = "0";
        spot.style.opacity = "0";
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
          var r = el.getBoundingClientRect(), box = a.style === "spotlight" ? spot : ring;
          ring.className = "cf-ring" + (a.style === "glow" ? " cf-glow" : "");
          box.style.cssText = "opacity:0;left:" + (r.left - 6) + "px;top:" + (r.top - 6) + "px;width:" + (r.width + 12) + "px;height:" + (r.height + 12) + "px";
          a._box = box;
        },
        update: function (a, p) {
          if (!a._box) return;
          // in and out over the first and last 15 % of the time; the ring keeps its own pulse in between
          var q = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;
          a._box.style.opacity = String(Math.max(0, Math.min(1, q)));
        },
        finish: function (a) { if (a._box) a._box.style.opacity = "0"; }
      },
      hover: {
        start: function (a) {
          var el = $el(a.to);
          if (!el) return;
          var c = center(el);
          cursor.style.opacity = "1";
          putCursor(c.x, c.y);
          el.classList.add("cf-hover");
          a._el = el;
        },
        finish: function (a) { if (a._el) a._el.classList.remove("cf-hover"); a._el = null; }
      },
      reorder: {
        /* FLIP: measure, move the node, measure again, start everyone from where it was and let it slide */
        start: function (a) {
          var moved = relocate(a);
          a._flip = moved && !reduce ? flipStart(moved) : null; // a seek into the action shows it half way too
        },
        update: function (a, p) { if (a._flip) flipAt(a._flip, 1 - eased(a, p)); },
        finish: function (a) { if (a._flip) flipEnd(a._flip); a._flip = null; }
      },
      drag: {
        /* the node goes to its place at once (FLIP), but on screen it is held where it was: lifted, carried by the
           cursor, dropped; the others make room while it travels */
        start: function (a) {
          var moved = relocate(a);
          if (!moved) return;
          var el = moved.el;
          cursor.style.opacity = "1";
          if (reduce) { putCursor(center(el).x, center(el).y); return; }
          a._flip = flipStart(moved);
          el._cfLift = { boxShadow: el.style.boxShadow, zIndex: el.style.zIndex, position: el.style.position };
          a._el = el;
        },
        update: function (a, p) {
          if (!a._flip) return;
          var el = a._el, q = eased(a, p);
          // lift (0–15 %): the element rises; travel (15–85 %): it moves with the cursor; drop: it settles, the room closes
          var lift = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;
          var travel = p < 0.15 ? 0 : p > 0.85 ? 1 : (p - 0.15) / 0.7;
          var room = p < 0.6 ? 0 : Math.min(1, (p - 0.6) / 0.3);
          flipAt(a._flip, 1 - easeFn("ease-in-out")(travel), 1 - easeFn("ease-out")(room), el, 1 + 0.03 * lift);
          el.style.boxShadow = "0 " + 10 * lift + "px " + 24 * lift + "px rgba(0,0,0," + 0.25 * lift + ")";
          el.style.zIndex = "1000"; if (!el.style.position || el.style.position === "static") el.style.position = "relative";
          var c = center(el); putCursor(c.x, c.y);
        },
        finish: function (a) {
          if (a._flip) flipEnd(a._flip);
          var el = a._el;
          if (el && el._cfLift) { el.style.boxShadow = el._cfLift.boxShadow; el.style.zIndex = el._cfLift.zIndex; el.style.position = el._cfLift.position; delete el._cfLift; }
          a._flip = null; a._el = null;
        }
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
      draw: {
        /* a stroke drawn by a pen: dash as long as the path, offset from all to none */
        start: function (a) {
          a._els = targets(a).filter(function (el) { return typeof el.getTotalLength === "function"; });
          a._els.forEach(function (el) {
            var len = el.getTotalLength();
            el._cfDraw = { len: len, dasharray: el.style.strokeDasharray, dashoffset: el.style.strokeDashoffset };
            el.style.strokeDasharray = len; el.style.strokeDashoffset = len;
          });
        },
        update: function (a, p) {
          (a._els || []).forEach(function (el, k) { if (el._cfDraw) el.style.strokeDashoffset = el._cfDraw.len * (1 - eased(a, local(a, p, k))); });
        },
        finish: function (a) {
          (a._els || []).forEach(function (el) { if (el._cfDraw) { el.style.strokeDasharray = el._cfDraw.dasharray; el.style.strokeDashoffset = el._cfDraw.dashoffset; delete el._cfDraw; } });
        }
      },
      grow: {
        start: function (a) {
          a._els = targets(a);
          a._els.forEach(function (el) {
            el._cfGrow = { transform: el.style.transform, origin: el.style.transformOrigin };
            el.style.transformOrigin = { bottom: "50% 100%", top: "50% 0", left: "0 50%", right: "100% 50%", center: "50% 50%" }[a.from] || "50% 100%";
            el.style.transform = growAt(a.from, 0);
          });
        },
        update: function (a, p) { (a._els || []).forEach(function (el, k) { el.style.transform = growAt(a.from, eased(a, local(a, p, k))); }); },
        finish: function (a) { (a._els || []).forEach(function (el) { if (el._cfGrow) { el.style.transform = el._cfGrow.transform; el.style.transformOrigin = el._cfGrow.origin; delete el._cfGrow; } }); }
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
    /* reorder/drag: put the node where the action says; the two parents' children are the ones that may move */
    function relocate(a) {
      var el = $el(a.to);
      if (!el) return null;
      var from = el.parentNode, dest, ref = null;
      if (a.before != null) { ref = $el(a.before); dest = ref && ref.parentNode; }
      else if (a.after != null) { ref = $el(a.after); dest = ref && ref.parentNode; if (ref) ref = ref.nextSibling; }
      else { dest = $el(a.into); if (dest && a.index != null) ref = dest.children[a.index] || null; }
      if (!dest || dest === el || el.contains(dest)) return null;
      var family = Array.prototype.slice.call(from.children);
      if (dest !== from) family = family.concat(Array.prototype.slice.call(dest.children));
      var before = family.map(function (x) { return x.getBoundingClientRect(); });
      dest.insertBefore(el, ref);
      return { el: el, family: family, before: before };
    }
    function flipStart(m) {
      var items = [];
      m.family.forEach(function (x, i) {
        var r = x.getBoundingClientRect(), b = m.before[i], dx = b.left - r.left, dy = b.top - r.top;
        if (!dx && !dy && x !== m.el) return; // did not move: left alone
        items.push({ el: x, dx: dx, dy: dy, transform: x.style.transform, transition: x.style.transition });
        x.style.transition = "none";
      });
      return { items: items };
    }
    /* k = how far back towards the old place (1 = old, 0 = new); kOthers for the elements that make room; the
       dragged element may be scaled while carried */
    function flipAt(f, k, kOthers, dragged, scale) {
      f.items.forEach(function (it) {
        var kk = dragged && it.el !== dragged ? kOthers : k;
        var t = "translate(" + it.dx * kk + "px," + it.dy * kk + "px)";
        if (dragged && it.el === dragged && scale && scale !== 1) t += " scale(" + scale + ")";
        it.el.style.transform = t;
      });
    }
    function flipEnd(f) { f.items.forEach(function (it) { it.el.style.transform = it.transform; it.el.style.transition = it.transition; }); }
    /* show/hide helpers: which elements (all of them with a stagger), each one's own progress, the entrance itself */
    function targets(a) { return a.stagger != null ? $all(a.to) : [$el(a.to)].filter(Boolean); }
    function reveal(el) { el.removeAttribute("hidden"); el.style.display = ""; }
    function growAt(from, q) { q = Math.max(0, q); return from === "left" || from === "right" ? "scaleX(" + q + ")" : from === "center" ? "scale(" + q + ")" : "scaleY(" + q + ")"; }
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
      if (a.do === "show" || a.do === "hide" || a.do === "draw" || a.do === "grow") return a.duration + staggerSpan(a);
      if (a.do === "set" || a.do === "check" || a.do === "select" || a.do === "value") return a.animate || 0;
      if (a.do === "scroll") return a.duration != null ? a.duration : 450;
      if (a.do === "hover") return a.duration != null ? a.duration : 600;
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
      u.onboundary = function () { avatarPulse(); }; // a word: the narrator's mouth moves (Chromium gives these)
      synth.speak(u);
    }
    function stopVoice() { if (synth) synth.cancel(); if (cur) { cur.speaking = false; cur.utter = null; } }

    // ---- the narrator: a face over the picture (a corner, a side panel, a band, the whole picture), drawn by the
    // player; blinks on the step clock, lips follow the voice. Chosen like a voice: step < video < project < defaults.
    var AVATAR_SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<g id="head"><circle cx="50" cy="52" r="34" fill="#f2c9a8"/><path d="M18 46c2-22 18-32 32-32s30 10 32 32c-6-10-18-14-32-14s-26 4-32 14z" fill="#3b2a24"/>' +
      '<g id="eye-l"><ellipse cx="38" cy="50" rx="4.2" ry="4.6" fill="#2b2b2b"/><circle cx="39.4" cy="48.6" r="1.3" fill="#fff"/></g>' +
      '<g id="eye-r"><ellipse cx="62" cy="50" rx="4.2" ry="4.6" fill="#2b2b2b"/><circle cx="63.4" cy="48.6" r="1.3" fill="#fff"/></g>' +
      '<path d="M46 60q4 3 8 0" fill="none" stroke="#d99a7a" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path id="mouth-closed" d="M41 70q9 5 18 0" fill="none" stroke="#9c4a3c" stroke-width="2.4" stroke-linecap="round"/>' +
      '<ellipse id="mouth-mid" cx="50" cy="71" rx="7.5" ry="3.2" fill="#8d3b31"/>' +
      '<g id="mouth-open"><ellipse cx="50" cy="72" rx="8.5" ry="6" fill="#8d3b31"/><ellipse cx="50" cy="69.5" rx="6" ry="2" fill="#fff"/></g></g></svg>';
    var AVATAR_DEFAULTS = { provider: "none", mode: "pip", position: "bottom-right", x: 0.7, y: 0.6, size: 0.28, shape: "round", background: "#1f2a44" };
    var avatarEl = $(".cf-avatar"), faceEl = avatarEl.querySelector(".cf-av-face"), av = null, avKey = "";
    // the step before, as it last looked: fades out over the first 300 ms of a step while the new narrator fades in,
    // so a clip that starts again from the photo's pose, a move, an appearance or a disappearance never happen in one frame
    var ghostEl = $(".cf-av-ghost"), ghostFace = ghostEl.querySelector(".cf-av-face"), ghostReady = Promise.resolve(), avFade = null;
    var FADE = 300;
    /** What the narrator is in a step: the step's choices over the video's over the project's over the defaults. */
    function avatarOf(st) {
      var out = {}, layers = [AVATAR_DEFAULTS, DATA.avatarGlobal, opts.avatar, st && st.avatar];
      layers.forEach(function (l) { Object.keys(l || {}).forEach(function (k) { if (l[k] !== undefined) out[k] = l[k]; }); });
      return out;
    }
    function isImagePath(v) { return typeof v === "string" && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(v) && !/^(data:|https?:)/.test(v); }
    function kitImage(v) { return (DATA.avatarImages || {})[v] || null; }
    /** Puts the face where the step says. Idempotent: called at every step entry (and seek). */
    /** what a step shows of the narrator: the resolved choice, whether it is on, and the clip of this language if the voice made one */
    function avatarShown(st) {
      var a = avatarOf(st);
      // a person: the clip of this step in this language when the voice made one; without it (a preview, no key yet) the picture stands in
      var person = a.provider === "image" || a.provider === "fantastico" || a.provider === "command";
      var clip = person && st && DATA.avatarVideo && DATA.avatarVideo[lang] ? DATA.avatarVideo[lang][st.id] : null;
      var on = !slides && a.provider !== "none" && a.mode !== "off" && (!person || clip || kitImage(a.image));
      return { a: a, person: person, clip: clip, on: on, place: placeKey(a) };
    }
    function placeKey(a) { return [a.mode, a.position, a.size, a.shape, a.x, a.y, a.background].join("|"); }
    /** where, how big, on what: the same for the narrator and for its ghost */
    function placeAvatar(el, a) {
      var pos = a.position, mode = a.mode;
      if (mode === "pip" && ["bottom-right", "bottom-left", "top-right", "top-left", "custom"].indexOf(pos) < 0) pos = "bottom-right";
      if (mode === "side" && pos !== "left") pos = "right";
      if (mode === "band" && pos !== "top") pos = "bottom";
      el.className = (el === ghostEl ? "cf-av-ghost" : "cf-avatar") + " cf-av-" + mode + " cf-av-" + pos + (mode === "pip" && a.shape === "rounded" ? " cf-av-rounded" : "");
      var cs = el.style;
      cs.left = cs.right = cs.top = cs.bottom = cs.width = cs.height = "";
      if (mode === "pip") { cs.height = a.size * 100 + "%"; if (pos === "custom") { cs.left = a.x * 100 + "%"; cs.top = a.y * 100 + "%"; } }
      else if (mode === "side") cs.width = a.size * 100 + "%";
      else if (mode === "band") cs.height = a.size * 100 + "%";
      var bgImage = isImagePath(a.background) ? kitImage(a.background) : null;
      cs.background = bgImage ? "url(" + JSON.stringify(bgImage) + ") center / cover no-repeat" : a.background;
      el.classList.toggle("cf-av-clear", a.background === "transparent"); // no panel: no shadow either
    }
    /** the step before, frozen as it ended (a clip's last frame drawn on a canvas, or the picture), to fade out under the new one */
    function makeGhost(prev, now) {
      ghostEl.hidden = true; ghostFace.innerHTML = ""; ghostReady = Promise.resolve();
      if (!prev || !prev.on || reduce) return;
      // the same still picture in the same place: nothing changes, nothing to fade
      if (!prev.clip && !now.clip && now.on && prev.a.provider === now.a.provider && prev.a.image === now.a.image && prev.place === now.place) return;
      placeAvatar(ghostEl, prev.a);
      ghostEl.hidden = false; ghostEl.style.opacity = "1";
      if (!prev.clip) { ghostFace.innerHTML = prev.person ? '<img alt="" src="' + kitImage(prev.a.image) + '">' : (DATA.avatar || AVATAR_SVG); return; }
      var canvas = document.createElement("canvas"); ghostFace.appendChild(canvas);
      ghostReady = new Promise(function (res) {
        var v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.src = prev.clip;
        var done = false, finish = function () { if (done) return; done = true; try { canvas.width = v.videoWidth || 2; canvas.height = v.videoHeight || 2; canvas.getContext("2d").drawImage(v, 0, 0); } catch (e) {} res(); };
        v.addEventListener("loadedmetadata", function () { v.currentTime = Math.max(0, (v.duration || 0) - 0.05); });
        v.addEventListener("seeked", finish); v.addEventListener("error", finish);
      });
    }
    function applyAvatar(st) {
      var now = avatarShown(st), a = now.a, clip = now.clip, on = now.on;
      var prev = cur && cur.i > 0 ? avatarShown(steps[cur.i - 1]) : null;
      makeGhost(prev, now);
      // a narrator that appears, or changes place, fades in with the ghost fading out; one that only changes clip stays, the ghost dissolves over it
      avFade = on && prev && !reduce && (!prev.on || (!ghostEl.hidden && prev.place !== now.place)) ? "in" : null;
      avatarEl.style.opacity = "";
      app.classList.toggle("cf-av-br", on && a.mode === "pip" && a.position === "bottom-right");
      avatarEl.hidden = !on;
      if (!on) { avKey = ""; paintAvatar(cur ? cur.t : 0, 0); return; } // the face stays built for the next step that shows it
      var key = JSON.stringify(a) + (clip ? "#" + st.id : "");
      if (key === avKey) { paintAvatar(cur ? cur.t : 0, 0); return; }
      avKey = key;
      // the face itself
      var faceKey = a.provider + ":" + (a.image || "") + ":" + (clip ? st.id + "/" + lang : "");
      if (faceEl.getAttribute("data-face") !== faceKey) {
        faceEl.setAttribute("data-face", faceKey);
        faceEl.innerHTML = clip ? '<video muted playsinline preload="auto"></video>' : now.person ? '<img alt="" src="' + kitImage(a.image) + '">' : (DATA.avatar || AVATAR_SVG);
        var svg = faceEl.querySelector("svg"), img = faceEl.querySelector("img"), video = faceEl.querySelector("video");
        if (video) { video.src = clip; video.playbackRate = speed; }
        av = { svg: svg, img: img, video: video, eyes: svg ? [svg.querySelector("#eye-l"), svg.querySelector("#eye-r")] : [], mouths: svg ? { closed: svg.querySelector("#mouth-closed"), mid: svg.querySelector("#mouth-mid"), open: svg.querySelector("#mouth-open") } : {}, pulse: -1e9, bound: false, level: 0 };
        av.eyes.forEach(function (e) { if (e) { e.style.transformBox = "fill-box"; e.style.transformOrigin = "50% 50%"; } });
      }
      placeAvatar(avatarEl, a);
      paintAvatar(cur ? cur.t : 0, 0);
    }
    /* a small deterministic noise of the step time: the same t gives the same blink, in a seek as in playback */
    function noise(n) { var x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }
    /* the clip follows the step clock: plays with the player, pauses with it, lands where a seek lands */
    var render = false; // a recorder drives the clock frame by frame: the clip is positioned, never played (real time would run ahead)
    function syncClip(t) {
      var v = av && av.video; if (!v) return;
      var want = t / 1000;
      if (playing && !render) { if (Math.abs(v.currentTime - want) > 0.15) v.currentTime = want; if (v.paused && want < (v.duration || Infinity)) v.play().catch(function () {}); }
      else { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - want) > (render ? 0.001 : 0.02)) v.currentTime = Math.min(want, v.duration || want); }
    }
    /** resolves once the clip shows the frame it was sent to (a recorder waits for it before taking the picture) */
    function clipSettled() {
      var v = av && av.video; if (!v || avatarEl.hidden) return ghostReady;
      return ghostReady.then(function () { return new Promise(function (res) {
        if (v.readyState >= 2 && !v.seeking) return res();
        var done = function () { v.removeEventListener("seeked", done); v.removeEventListener("loadeddata", done); v.removeEventListener("error", done); res(); };
        v.addEventListener("seeked", done); v.addEventListener("loadeddata", done); v.addEventListener("error", done);
      }); });
    }
    function paintAvatar(t, level) {
      var k = reduce ? 1 : Math.min(1, Math.max(0, t / FADE));
      if (!ghostEl.hidden) { ghostEl.style.opacity = String(1 - k); if (k >= 1) { ghostEl.hidden = true; ghostFace.innerHTML = ""; } }
      if (avFade === "in") { avatarEl.style.opacity = String(k); if (k >= 1) { avFade = null; avatarEl.style.opacity = ""; } }
      if (!av || avatarEl.hidden) return;
      syncClip(t);
      if (av.video) return; // a real face: nothing to draw
      // a blink every 2.5–5 s, 150 ms long; the slot's own noise picks its moment
      var slot = Math.floor(t / 3600), at = slot * 3600 + 400 + noise(slot) * 2800, blink = reduce ? 0 : Math.max(0, 1 - Math.abs(t - at) / 75);
      av.eyes.forEach(function (e) { if (e) e.style.transform = "scaleY(" + (1 - 0.92 * blink) + ")"; });
      // a slow sway; a picture also nods a little as it speaks
      var sway = reduce ? "" : "rotate(" + (1.4 * Math.sin(t / 1300)) + "deg) translateY(" + (0.6 * Math.sin(t / 900)) + "%)";
      if (av.svg) av.svg.style.transform = sway;
      if (av.img) av.img.style.transform = sway + (reduce ? "" : " scale(" + (1 + 0.015 * level) + ")");
      var m = level < 0.12 ? "closed" : level < 0.45 ? "mid" : "open";
      Object.keys(av.mouths).forEach(function (k) { if (av.mouths[k]) av.mouths[k].style.display = k === m ? "" : "none"; });
    }
    function avatarPulse() { if (av) { av.pulse = performance.now(); av.bound = true; } }
    /* how open the mouth is now, 0–1: the audio's loudness, else the words of the browser voice, else a guess from the text */
    var analyser = null, analysed = null, bins = null;
    function mouthLevel() {
      if (!av || !cur || !playing) return 0;
      if (cur.audio && !cur.audio.paused && voiceOn) {
        try {
          if (keepAlive && analysed !== cur.audio) {
            analyser = keepAlive.createAnalyser(); analyser.fftSize = 512; bins = new Uint8Array(analyser.frequencyBinCount);
            var src = keepAlive.createMediaElementSource(cur.audio); src.connect(analyser); analyser.connect(keepAlive.destination);
            analysed = cur.audio;
          }
          if (analyser && analysed === cur.audio) {
            analyser.getByteTimeDomainData(bins);
            var sum = 0; for (var i = 0; i < bins.length; i++) { var d = (bins[i] - 128) / 128; sum += d * d; }
            var rms = Math.sqrt(sum / bins.length);
            av.peak = Math.max(rms, (av.peak || 0) * 0.995, 0.01); // the loudest recent moment is "wide open", whatever the recording's volume
            av.level = Math.max(rms / av.peak, av.level * 0.6); // quick up, soft down
            return Math.min(1, av.level);
          }
        } catch (e) { /* no analyser (a cross-origin file): the text guess below */ }
      }
      var speaking = cur.audio ? !cur.audio.paused : cur.speaking || (!cur.mute && cur.t < cur.narrDur && synth);
      if (!speaking) return 0;
      if (av.bound && !cur.audio) { var since = performance.now() - av.pulse; return since < 220 ? 1 - since / 220 * 0.6 : since < 420 ? 0.3 : 0; }
      // no clue from the voice itself: syllables at about 5 a second, with pauses the text would have
      var beat = Math.floor(cur.t / 190);
      return noise(beat + 7) < 0.3 ? 0.08 : 0.35 + 0.65 * Math.abs(Math.sin(cur.t / 95));
    }

    // ---- steps ----
    async function enterStep(i, instant) {
      var st = steps[i];
      var sceneName = sceneStepIndex[i];
      if (lang + "/" + sceneName !== curScene) { await loadScene(sceneName); cam = null; }
      var text = st.narration[lang] || "";
      var url = audioUrl(i);
      var info = url ? await audioDuration(url) : { audio: null, ms: null };
      var said = (st.speech && st.speech[lang] && st.speech[lang].trim()) || text; // the caption stays the narration
      var narrDur = info.ms != null ? info.ms : estimate(said);
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
      applyAvatar(st);
      if (!instant && playing) {
        if (cur.audio) { cur.audio.currentTime = 0; playSound(cur.audio); }
        else if (!cur.mute) speak(cur, said);
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
      if (v) { emit("play", { first: !played }); played = true; }
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
      if (v) { last = performance.now(); raf = requestAnimationFrame(tick); } else { cancelAnimationFrame(raf); if (cur) paintAvatar(cur.t, 0); } // a paused narrator closes its mouth
    }

    function progressBar() {
      var done = 0, total = 0;
      steps.forEach(function (_, i) { total += 1; if (cur && i < cur.i) done += 1; });
      var within = cur && cur.total ? Math.min(1, cur.t / cur.total) : 0;
      var percent = ((done + within) / Math.max(total, 1)) * 100;
      fill.style.width = percent + "%";
      if (playing) [25, 50, 75].forEach(function (m) { if (percent >= m && !reached[m]) { reached[m] = true; emit("progress", { percent: m }); } });
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
      paintAvatar(cur.t, mouthLevel());
      runDue(cur, cur.t, { instant: false });
      progressBar();
      // the browser voice has no known length: wait for it to finish, within a generous bound
      var waitVoice = cur.speaking && cur.t < cur.total + 2 * cur.narrDur;
      if (cur.t >= cur.total && !waitVoice) {
        if (cur.audio) cur.audio.pause();
        var next = cur.i + 1;
        if (next >= steps.length) { setPlaying(false); app.classList.add("cf-ended"); showCaption(""); paintChapters(); paintVeil(); emit("ended"); return; }
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
      paintAvatar(t, 0);
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
      await ghostReady;
      if (av && av.video && !avatarEl.hidden) await new Promise(function (res) { var v = av.video; if (v.readyState >= 2 && !v.seeking) return res(); var done = function () { v.removeEventListener("seeked", done); v.removeEventListener("loadeddata", done); res(); }; v.addEventListener("seeked", done); v.addEventListener("loadeddata", done); setTimeout(done, 1500); });
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
      if (av && av.video) av.video.playbackRate = speed;
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
      // for a recorder (the MP4 export): the narrator's clip follows the clock frame by frame, and says when the frame is on screen
      setRender: function (on) { render = !!on; if (cur) syncClip(cur.t); }, clipSettled: clipSettled,
      // one exact frame of the current step at `ms`, without the live clock: no 800 ms hold at play, no rAF jitter;
      // resolves once the narrator's clip shows that frame too
      renderFrame: function (ms) { if (!cur) return Promise.resolve(); cur.t = ms; tickCamera(cur.t); paintAvatar(cur.t, 0); runDue(cur, cur.t, { instant: false }); progressBar(); return clipSettled(); },
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
