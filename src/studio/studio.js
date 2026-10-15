/* Cueflow Studio: plain browser JS. The kit's files are the single source of truth; this page only reads and writes them. */
(function () {
  "use strict";

  var S = { state: null, guideId: null, guide: null, version: 0, step: 0, lang: null, mode: "video", tab: "narration", dirty: false, picked: null, voices: null };
  var $ = function (s) { return document.querySelector(s); };

  function h(tag, props) {
    var el = document.createElement(tag);
    for (var k in props || {}) {
      if (k === "class") el.className = props[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), props[k]);
      else if (props[k] === true) el.setAttribute(k, "");
      else if (props[k] !== false && props[k] != null) el.setAttribute(k, props[k]);
    }
    var add = function (c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return c.forEach(add);
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    };
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: { "x-cueflow": "studio" } };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers["content-type"] = "application/json"; }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || (data.errors && data.errors.join("; ")) || "request failed (" + r.status + ")"); e.data = data; e.status = r.status; throw e; }
        return data;
      });
    });
  }
  var text = function (v, lang) { if (v == null) return ""; if (typeof v === "string") return v; return v[lang] != null ? v[lang] : v[Object.keys(v)[0]] || ""; };
  var video = function () { return S.state.guides.filter(function (g) { return g.id === S.guideId; })[0]; };
  var languages = function () { var g = video(); return g ? g.languages : []; };

  /* ---------- loading ---------- */
  function loadState() {
    return api("/api/state").then(function (st) {
      S.state = st;
      $("#where").textContent = st.kitRoot + "  →  output: " + st.outDir;
      if (!S.guideId || !video()) S.guideId = st.guides[0] ? st.guides[0].id : null;
      return S.guideId ? loadGuide(S.guideId) : null;
    }).then(function () { renderAll(); });
  }
  function loadGuide(id) {
    return api("/api/guide/" + id).then(function (r) {
      S.guide = r.guide; S.version = r.version; S.dirty = false;
      if (S.step >= S.guide.steps.length) S.step = 0;
      var langs = r.guide.languages;
      if (!S.lang || langs.indexOf(S.lang) < 0) S.lang = langs[0];
    });
  }

  /* ---------- rendering ---------- */
  function renderAll() { renderLang(); renderSide(); renderView(false); renderPanel(); }
  function renderLang() {
    var sel = $("#lang"); sel.textContent = "";
    var all = {};
    S.state.guides.forEach(function (g) { g.languages.forEach(function (l) { all[l] = 1; }); });
    Object.keys(all).forEach(function (l) { sel.appendChild(h("option", { value: l, selected: l === S.lang }, l)); });
  }
  function renderSide() {
    var side = $("#side"); side.textContent = "";
    if (!S.state.guides.length) { side.appendChild(h("p", { class: "empty" }, "No videos in this kit yet. Ask your assistant to create one (see the Assistant tab).")); return; }
    S.state.guides.forEach(function (g) {
      var on = g.id === S.guideId;
      var box = h("div", { class: "vid" + (on ? " on" : "") },
        h("button", { onclick: function () { selectGuide(g.id); } }, text(g.title, S.lang), h("small", null, g.steps.length + " steps · " + g.languages.join(", "))));
      if (on) {
        var ol = h("ol", { class: "steps" });
        g.steps.forEach(function (s, i) {
          ol.appendChild(h("li", { class: i === S.step ? "on" : "" },
            h("button", { onclick: function () { selectStep(i); } }, h("span", { class: "n" }, String(i + 1)), h("span", { class: "t" }, text(s.title, S.lang) || text(s.narration, S.lang) || s.id))));
        });
        box.appendChild(ol);
      }
      side.appendChild(box);
    });
  }
  function currentScene() {
    var scene = S.guide.scene;
    for (var i = 0; i <= S.step && i < S.guide.steps.length; i++) if (S.guide.steps[i].scene) scene = S.guide.steps[i].scene;
    return scene;
  }
  var view = $("#view");
  var viewKey = "";
  function renderView(force) {
    if (!S.guide) { view.removeAttribute("src"); return; }
    var key = S.mode === "video" ? "v:" + S.guideId + ":" + S.lang : "p:" + currentScene() + ":" + S.lang;
    if (!force && key === viewKey) { if (S.mode === "video") gotoStep(); return; }
    viewKey = key;
    var src = S.mode === "video" ? "/preview/" + S.guideId + "?lang=" + S.lang + "#step-" + (S.step + 1) : "/scene/" + currentScene() + "?lang=" + S.lang;
    view.onload = S.mode === "pick" ? armPicker : null;
    view.src = src;
    if (force) view.contentWindow && view.contentWindow.location.reload();
  }
  function gotoStep() { try { view.contentWindow.location.hash = "#step-" + (S.step + 1); } catch (e) { /* not loaded yet */ } }

  /* ---------- actions ---------- */
  function selectGuide(id) {
    if (!confirmLeave()) return;
    S.guideId = id; S.step = 0; S.picked = null;
    loadGuide(id).then(function () { renderAll(); });
  }
  function selectStep(i) { if (!confirmLeave()) return; S.msg = null; S.step = i; S.dirty = false; S.picked = null; renderSide(); renderView(false); renderPanel(); pickInfo(); }
  function confirmLeave() { return !S.dirty || confirm("The narration of this step has changes you have not saved. Leave without saving?"); }
  function setMode(m) {
    S.mode = m; viewKey = "";
    $("#m-video").className = m === "video" ? "on" : ""; $("#m-pick").className = m === "pick" ? "on" : "";
    pickInfo(); renderView(false);
  }
  function save(mutate) {
    var g = JSON.parse(JSON.stringify(S.guide));
    mutate(g);
    return api("/api/guide/" + S.guideId, { method: "PUT", body: { guide: g, version: S.version } }).then(function (r) {
      S.guide = g; S.version = r.version; S.dirty = false; S.ownSave = Date.now();
      return loadState().then(function () { viewKey = ""; renderView(true); return r; });
    });
  }

  /* ---------- the element picker ---------- */
  function uniqueSelector(doc, el) {
    var q = function (s) { try { return doc.querySelectorAll(s); } catch (e) { return []; } };
    if (el.id && q("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    var cue = el.getAttribute("data-cue");
    if (cue && q('[data-cue="' + cue + '"]').length === 1) return '[data-cue="' + cue + '"]';
    var path = [], node = el;
    while (node && node.nodeType === 1 && node !== doc.body) {
      var part = node.tagName.toLowerCase();
      if (node.id) { path.unshift("#" + CSS.escape(node.id)); break; }
      var same = Array.prototype.filter.call(node.parentNode.children, function (c) { return c.tagName === node.tagName; });
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      path.unshift(part); node = node.parentNode;
      if (q(path.join(" > ")).length === 1) break;
    }
    return path.join(" > ");
  }
  function armPicker() {
    var doc = view.contentDocument; if (!doc) return;
    var box = doc.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff7a59;background:rgba(255,122,89,.15);border-radius:3px;display:none";
    doc.body.appendChild(box);
    doc.addEventListener("mouseover", function (e) {
      var r = e.target.getBoundingClientRect();
      box.style.display = "block"; box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px";
    });
    doc.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      S.picked = uniqueSelector(doc, e.target); pickInfo();
    }, true);
  }
  function pickInfo() {
    var el = $("#pickinfo");
    if (S.mode !== "pick") { el.hidden = true; return; }
    el.hidden = false; el.textContent = "";
    if (!S.picked) { el.appendChild(h("span", null, "Click an element in the screen to get its selector.")); return; }
    var stepNo = S.step + 1;
    el.appendChild(h("code", { title: S.picked }, S.picked));
    el.appendChild(h("button", { class: "btn", onclick: function () { navigator.clipboard && navigator.clipboard.writeText(S.picked); } }, "Copy"));
    el.appendChild(h("button", { class: "btn primary", onclick: function () {
      save(function (g) { var st = g.steps[S.step]; st.camera = Object.assign({}, st.camera || {}, { target: S.picked }); })
        .then(function () { flash("Camera of step " + stepNo + " now frames " + S.picked, "ok"); setMode("video"); })
        .catch(function (e) { flash(e.message, "err"); });
    } }, "Frame it in step " + stepNo));
  }
  function flash(message, kind) {
    var b = $("#banner"); b.hidden = false; b.textContent = message; b.style.background = kind === "err" ? "#fde2df" : "#e1f3e8"; b.style.color = kind === "err" ? "#7a1710" : "#14532d";
    clearTimeout(flash.t); flash.t = setTimeout(function () { b.hidden = true; }, kind === "err" ? 9000 : 3500);
  }

  /* ---------- the panel ---------- */
  function renderPanel() {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.className = b.getAttribute("data-tab") === S.tab ? "on" : ""; });
    var p = $("#panel"); p.textContent = "";
    if (S.tab === "narration") narrationTab(p);
    else if (S.tab === "voices") voicesTab(p);
    else assistantTab(p);
  }

  function narrationTab(p) {
    if (!S.guide || !S.guide.steps.length) { p.appendChild(h("p", { class: "empty" }, "Select a video with steps.")); return; }
    var step = S.guide.steps[S.step];
    var area = h("textarea", { id: "narr", lang: S.lang }); area.value = text(step.narration, S.lang);
    area.addEventListener("input", function () { S.dirty = true; });
    var msg = h("div", { class: "msg" });
    p.appendChild(h("h3", null, "Step " + (S.step + 1) + " · " + (text(step.title, S.lang) || step.id)));
    p.appendChild(h("p", null, "What is said, and shown as captions, in “" + S.lang + "”. One idea, one or two sentences."));
    p.appendChild(area);
    p.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: function () {
        var value = area.value.trim();
        save(function (g) { var n = g.steps[S.step].narration; g.steps[S.step].narration = typeof n === "object" && n ? Object.assign({}, n, (function () { var o = {}; o[S.lang] = value; return o; })()) : (function () { var o = {}; o[S.lang] = value; return o; })(); })
          .then(function (r) { S.msg = { kind: r.warnings.length ? "warn" : "ok", text: r.warnings.length ? "Saved. " + r.warnings.join(" ") : "Saved." }; renderPanel(); })
          .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
      } }, "Save"),
      h("button", { class: "btn", onclick: function () { speak(area.value, S.lang); } }, "Listen (browser voice)")));
    if (S.msg) { msg.className = "msg " + S.msg.kind; msg.textContent = S.msg.text; }
    p.appendChild(msg);
  }
  function speak(t, lang) { if (!window.speechSynthesis) return; speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(t); u.lang = lang; speechSynthesis.speak(u); }

  function assistantTab(p) {
    p.appendChild(h("h3", null, "Ask your assistant"));
    p.appendChild(h("p", null, "Studio does not talk to an assistant itself: your own assistant (Claude Code or another) edits the same files through Cueflow's tools, and you see its changes here at once. Write what you want; copy the request into your assistant."));
    var area = h("textarea", { placeholder: "e.g. Make this step shorter, and zoom on the upload button" });
    var out = h("div", { class: "msg" });
    p.appendChild(area);
    p.appendChild(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: function () {
      var g = S.guide, st = g && g.steps[S.step];
      var req = "In the Cueflow kit at " + S.state.kitRoot + (g ? ", video \"" + g.id + "\", step " + (S.step + 1) + " (" + st.id + "), language " + S.lang : "") + ": " + (area.value.trim() || "…") +
        "\nUse the Cueflow tools; then validate_guide and look at preview_frame before telling me it is done.";
      (navigator.clipboard ? navigator.clipboard.writeText(req) : Promise.reject()).then(function () { out.className = "msg ok"; out.textContent = "Copied. Paste it in your assistant."; }, function () { out.className = "msg warn"; out.textContent = req; });
    } }, "Copy the request")));
    p.appendChild(out);
    p.appendChild(h("p", { style: "margin-top:16px" }, "Not connected yet? In a terminal, inside the project: claude mcp add cueflow -- cueflow mcp"));
  }

  /* ---------- voices ---------- */
  var label = function (spec) { if (!spec) return null; return { browser: "Browser voice", none: "Silent", openai: "OpenAI" + (spec.voice ? " · " + spec.voice : ""), say: "macOS voice" + (spec.voice ? " · " + spec.voice : ""), command: "Local program" }[spec.provider] || spec.provider; };
  function voicesTab(p) {
    api("/api/voices").then(function (v) {
      S.voices = v; p.textContent = "";
      p.appendChild(h("h3", null, "Who reads the tutorials"));
      p.appendChild(h("p", null, "By default the viewer's browser reads them: free, nothing to set up. An outside voice is your choice, at one of three levels. What you leave unset follows the level above."));
      p.appendChild(level(v, { scope: "global" }, "Everything", v.current.default, "the browser's voice"));
      var langs = {}; S.state.guides.forEach(function (g) { g.languages.forEach(function (l) { langs[l] = 1; }); });
      Object.keys(langs).forEach(function (l) { p.appendChild(level(v, { scope: "language", language: l }, "Every video in “" + l + "”", v.current.languages[l], v.current.default ? label(v.current.default) + " (everything)" : "the browser's voice")); });
      var g = video();
      if (g) {
        var own = v.current.guides[g.id] || {};
        p.appendChild(level(v, { scope: "video", guide: g.id }, "Only this video: " + text(g.title, S.lang), own.default, "its language's voice, else everything's"));
        g.languages.forEach(function (l) { p.appendChild(level(v, { scope: "video", guide: g.id, language: l }, "Only this video, only in “" + l + "”", (own.languages || {})[l], "this video's voice, else its language's")); });
      }
      p.appendChild(h("h3", { style: "margin-top:18px" }, "Who speaks now"));
      var tb = h("table", null, h("tr", null, h("th", null, "Video"), h("th", null, "Lang"), h("th", null, "Voice"), h("th", null, "Set at")));
      v.table.forEach(function (r) { tb.appendChild(h("tr", null, h("td", null, r.guide), h("td", null, r.language), h("td", null, label({ provider: r.provider, voice: r.voice })), h("td", null, r.from))); });
      p.appendChild(tb);
    }).catch(function (e) { p.textContent = e.message; });
  }
  function level(v, target, title, spec, inherits) {
    var box = h("div", { class: "lvl" });
    var cur = h("div", { class: "cur" }, spec ? "Chosen: " + label(spec) : "Not set: uses " + inherits);
    var form = h("div", { hidden: true });
    box.appendChild(h("h4", null, title)); box.appendChild(cur);
    box.appendChild(h("button", { class: "btn", onclick: function () { form.hidden = !form.hidden; if (!form.hidden && !form.firstChild) buildForm(form, v, target, spec, function () { renderPanel(); }); } }, "Change…"));
    box.appendChild(form);
    return box;
  }
  function buildForm(form, v, target, spec, done) {
    var name = "o" + Math.random().toString(36).slice(2);
    var choice = spec ? spec.provider : target.scope === "global" ? "browser" : "inherit";
    var fields = {};
    var msg = h("div", { class: "msg" });
    function opt(value, title, summary, extra) {
      var input = h("input", { type: "radio", name: name, value: value, checked: choice === value });
      input.addEventListener("change", function () { choice = value; refresh(); });
      var box = h("label", { class: "opt" }, input, h("b", null, title), h("small", null, summary));
      if (extra) box.appendChild(extra);
      return box;
    }
    function fld(key, ph, val, type) { var i = h("input", { type: type || "text", placeholder: ph }); i.value = val || ""; fields[key] = i; return i; }
    function refresh() { form.querySelectorAll(".fields").forEach(function (f) { f.hidden = f.getAttribute("data-for") !== choice; }); }
    function extra(prov, kids) { return h("div", { class: "fields", "data-for": prov, hidden: choice !== prov }, kids); }
    var oa = v.options.filter(function (o) { return o.provider === "openai"; })[0];
    if (target.scope !== "global") form.appendChild(opt("inherit", "Use the level above", "Nothing is set here: the voice comes from the level above."));
    v.options.forEach(function (o) {
      if (o.provider === "openai") {
        var vsel = h("select", null, oa.voices.map(function (x) { return h("option", { value: x, selected: (spec && spec.voice || "coral") === x }, x); }));
        fields.voice = vsel;
        var kids = [h("label", null, "Voice ", vsel), fld("style", "How it should speak, e.g. calm and professional", spec && spec.style)];
        if (!v.hasKey) kids.push(h("p", { class: "msg warn" }, "An OpenAI key is needed. It is saved only in this kit's .env file, never shown again, and used only for this voice."), fld("key", "sk-…", "", "password"));
        form.appendChild(opt("openai", o.title, o.summary + " (" + o.cost + ")", extra("openai", kids)));
      } else if (o.provider === "command") {
        form.appendChild(opt("command", o.title, o.summary, extra("command", [fld("command", "piper --model voice.onnx --output_file {out} < {text}", spec && spec.command)])));
      } else if (o.provider === "say") {
        form.appendChild(opt("say", o.title, o.summary + (o.available ? "" : " (not available on this computer)"), null));
      } else form.appendChild(opt(o.provider, o.title, o.summary, null));
    });
    refresh();
    form.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: function () {
        var voice = null;
        if (choice === "inherit") voice = target.scope === "global" ? { provider: "browser" } : null;
        else if (choice === "openai") voice = { provider: "openai", voice: fields.voice.value, style: fields.style.value.trim() || undefined };
        else if (choice === "command") voice = { provider: "command", command: fields.command.value.trim(), format: "wav" };
        else voice = { provider: choice };
        var go = function () { return api("/api/voice", { method: "POST", body: Object.assign({}, target, { voice: voice }) }); };
        var key = fields.key && fields.key.value.trim();
        (choice === "openai" && key ? api("/api/key", { method: "POST", body: { key: key } }) : Promise.resolve()).then(go).then(function () { done(); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
      } }, "Save"),
      h("button", { class: "btn", onclick: function () {
        var sample = text((S.guide && S.guide.steps[S.step] || { narration: "" }).narration, target.language || S.lang) || "Hello, this is how the tutorial will sound.";
        if (choice === "browser" || choice === "inherit") return speak(sample, target.language || S.lang);
        msg.className = "msg"; msg.textContent = "Generating a sample…";
        var vc = choice === "openai" ? { provider: "openai", voice: fields.voice.value, style: fields.style.value.trim() || undefined } : choice === "command" ? { provider: "command", command: fields.command.value.trim(), format: "wav" } : { provider: choice };
        fetch("/api/voice-sample", { method: "POST", headers: { "x-cueflow": "studio", "content-type": "application/json" }, body: JSON.stringify({ voice: vc, text: sample.slice(0, 200), language: target.language || S.lang }) })
          .then(function (r) { if (!r.ok) return r.json().then(function (d) { throw new Error(d.error); }); return r.blob(); })
          .then(function (b) { msg.textContent = ""; new Audio(URL.createObjectURL(b)).play(); })
          .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
      } }, "Listen")));
    form.appendChild(msg);
  }

  /* ---------- wiring ---------- */
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { S.tab = b.getAttribute("data-tab"); renderPanel(); }); });
  $("#m-video").addEventListener("click", function () { setMode("video"); });
  $("#m-pick").addEventListener("click", function () { setMode("pick"); });
  $("#lang").addEventListener("change", function (e) { S.lang = e.target.value; S.msg = null; viewKey = ""; renderSide(); renderView(false); renderPanel(); });
  var events = new EventSource("/events");
  events.onmessage = function () {
    // someone else changed the kit (an assistant, an editor); the file watcher also reports our own saves, which we skip
    if (S.ownSave && Date.now() - S.ownSave < 2500) return;
    if (S.dirty) { var b = $("#banner"); b.hidden = false; b.style.background = ""; b.style.color = ""; b.textContent = "The kit changed on disk. Save or discard your edit, then reload this page."; return; }
    loadState().then(function () { viewKey = ""; renderView(true); flash("The kit changed: updated.", "ok"); });
  };
  loadState().catch(function (e) { document.body.textContent = "Studio could not load: " + e.message; });
})();
