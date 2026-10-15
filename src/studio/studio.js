/* Cueflow Studio: plain browser JS. The kit's files are the single source of truth; this page only reads and writes them. */
(function () {
  "use strict";

  var S = { state: null, guideId: null, guide: null, version: 0, step: 0, lang: null, mode: "video", tab: "narration", dirty: false, picked: null, voices: null, page: "timeline", pending: null, draft: null, zoom: 60, scene: null, check: null, busy: null };
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
  function renderAll() { renderLang(); renderSide(); renderView(false); renderPanel(); renderStrip(); renderPage(); }
  /* the bottom bar: Media, Timeline, Voice, Export (as in a video editor) */
  function showPage(name) {
    if (name !== S.page && !confirmLeave()) return;
    S.page = name;
    document.querySelectorAll(".page").forEach(function (el) { el.hidden = el.id !== "page-" + name; });
    $("#project").addEventListener("click", projectDialog);
  $("#exportall").addEventListener("click", exportAll);
  document.querySelectorAll(".pagebar button").forEach(function (b) { b.className = b.getAttribute("data-page") === name ? "on" : ""; });
    renderPage();
  }
  function renderPage() {
    if (S.page === "media") renderMedia();
    else if (S.page === "voice") voicesTab($("#voice-body"));
    else if (S.page === "preview") renderPreview();
    else if (S.page === "export") renderExport();
  }
  function renderLang() {
    var sel = $("#lang"); sel.textContent = "";
    var all = {};
    S.state.guides.forEach(function (g) { g.languages.forEach(function (l) { all[l] = 1; }); });
    Object.keys(all).forEach(function (l) { sel.appendChild(h("option", { value: l, selected: l === S.lang }, l)); });
  }
  function renderSide() { renderFilm(); }
  /* all the tutorials as thumbnails, like the slides of a presentation */
  function renderFilm() {
    var film = $("#film"); film.textContent = "";
    S.state.guides.forEach(function (g, i) {
      var on = g.id === S.guideId;
      var vp = g.viewport || { width: 1280, height: 720 };
      var thumb = h("div", { class: "thumb", style: "aspect-ratio:" + vp.width + " / " + vp.height });
      var fr = h("iframe", { src: "/scene/" + g.scene + "?lang=" + S.lang, loading: "lazy", tabindex: "-1", title: "" });
      fr.style.width = vp.width + "px"; fr.style.height = vp.height + "px";
      thumb.appendChild(fr);
      var total = (g.timing[S.lang] || g.timing[g.languages[0]] || []).reduce(function (n, t) { return n + t.total; }, 0);
      var tile = h("button", { class: "tile" + (on ? " on" : ""), title: text(g.title, S.lang), onclick: function () { selectGuide(g.id); } },
        thumb, h("span", { class: "cap" }, (i + 1) + ". " + text(g.title, S.lang)), h("span", { class: "sub" }, g.steps.length + " steps · " + fmt(total)));
      film.appendChild(tile);
      requestAnimationFrame(function () { fr.style.transform = "scale(" + thumb.clientWidth / vp.width + ")"; });
    });
    film.appendChild(h("button", { class: "tile add", title: "New tutorial", onclick: newTutorialDialog }, h("div", { class: "thumb" }, "+"), h("span", { class: "cap" }, "New tutorial")));
    var g = video();
    $("#current").textContent = g ? text(g.title, S.lang) : "";
  }
  function dialog(title, build) {
    var d = $("#dlg"); d.textContent = "";
    d.appendChild(h("h3", null, title));
    var body = h("div"); d.appendChild(body);
    build(body, function () { d.close(); });
    if (!d.open) d.showModal();
    return d;
  }
  var slug = function (t) { return String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); };
  function newTutorialDialog() {
    dialog("New tutorial", function (body, close) {
      var title = h("input", { type: "text", placeholder: "How to … (the title)" });
      var id = h("input", { type: "text", placeholder: "id (letters, digits, -)" });
      title.addEventListener("input", function () { if (!id.dataset.touched) id.value = slug(title.value); });
      id.addEventListener("input", function () { id.dataset.touched = "1"; });
      var scene = h("select", null, S.state.scenes.map(function (n) { return h("option", { value: n }, n); }));
      var langs = h("input", { type: "text" }); langs.value = (S.state.brief.languages.length ? S.state.brief.languages : [S.lang || "en"]).join(", ");
      var msg = h("div", { class: "msg" });
      body.appendChild(h("p", null, "It starts empty: add its steps in the Timeline."));
      body.appendChild(h("div", { class: "fields" }, h("label", { class: "lab" }, "Title", title), h("label", { class: "lab" }, "Id", id), h("label", { class: "lab" }, "First screen (scene)", scene), h("label", { class: "lab" }, "Languages, separated by commas", langs)));
      body.appendChild(h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: function () {
          api("/api/guide-create", { method: "POST", body: { id: id.value.trim(), title: title.value.trim(), scene: scene.value, languages: langs.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) } })
            .then(function (r) { S.guideId = r.id; S.step = 0; close(); return loadState(); }).then(function () { showPage("timeline"); })
            .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
        } }, "Create"), h("button", { class: "btn", onclick: close }, "Cancel")));
      body.appendChild(msg);
    });
  }
  function uniqueStepId(base) {
    var ids = S.guide.steps.map(function (s) { return s.id; }), id = base || "step", n = 2;
    while (ids.indexOf(id) >= 0) id = (base || "step") + "-" + n++;
    return id;
  }
  function addStep() {
    var title = prompt("Title of the new step (it names the chapter):");
    if (title === null) return;
    var at = S.guide.steps.length ? S.step + 1 : 0;
    save(function (g) {
      var n = {}; g.languages.forEach(function (l) { n[l] = ""; });
      var t = {}; t[S.lang] = title.trim() || "New step";
      g.steps.splice(at, 0, { id: uniqueStepId(slug(title)), title: t, actions: [], narration: n, hold: 600 });
    }).then(function () { S.step = at; S.tab = "narration"; renderAll(); }).catch(function (e) { flash(e.message, "err"); });
  }
  /* drag and drop: move step i so that it comes before the one that is now at `before` (the end is steps.length) */
  function moveStepTo(i, before) {
    var to = before > i ? before - 1 : before;
    if (to === i) return;
    save(function (g) { var x = g.steps.splice(i, 1)[0]; g.steps.splice(to, 0, x); }).then(function () { S.step = to; renderAll(); }).catch(function (e) { flash(e.message, "err"); });
  }
  function deleteStep(i) {
    if (!confirm("Delete step " + (i + 1) + "? Its narration and actions are removed from the video.")) return;
    save(function (g) { g.steps.splice(i, 1); }).then(function () { S.step = Math.max(0, i - 1); renderAll(); }).catch(function (e) { flash(e.message, "err"); });
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
    view.onload = S.mode === "pick" ? function () { armPicker(view); } : null;
    view.src = src;
    if (force) view.contentWindow && view.contentWindow.location.reload();
  }
  function gotoStep() { try { view.contentWindow.location.hash = "#step-" + (S.step + 1); } catch (e) { /* not loaded yet */ } }

  /* ---------- actions ---------- */
  function selectGuide(id) {
    if (!confirmLeave()) return;
    S.guideId = id; S.step = 0; S.picked = null; S.sel = null; S.check = null; mediaData = null; prevKey = "";
    loadGuide(id).then(function () { renderAll(); });
  }
  function selectStep(i) { if (!confirmLeave()) return; S.msg = null; S.draft = null; S.pending = null; S.step = i; S.dirty = false; S.picked = null; renderSide(); renderView(false); renderPanel(); pickInfo(); }
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
      return loadState().then(function () { viewKey = ""; prevKey = ""; renderView(true); return r; });
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
  function armPicker(frame, onPick) {
    frame = frame || view; onPick = onPick || function (sel) { S.picked = sel; pickInfo(); };
    var doc = frame.contentDocument; if (!doc) return;
    var box = doc.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff7a59;background:rgba(255,122,89,.15);border-radius:3px;display:none";
    doc.body.appendChild(box);
    doc.addEventListener("mouseover", function (e) {
      var r = e.target.getBoundingClientRect();
      box.style.display = "block"; box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px";
    });
    doc.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      onPick(uniqueSelector(doc, e.target));
    }, true);
  }
  function pickInfo() {
    var el = $("#pickinfo");
    if (S.mode !== "pick") { el.hidden = true; return; }
    el.hidden = false; el.textContent = "";
    var pend = S.pending;
    if (!S.picked) { el.appendChild(h("span", null, pend ? pendingText() : "Click an element in the screen to get its selector.")); return; }
    var stepNo = S.step + 1;
    el.appendChild(h("code", { title: S.picked }, S.picked));
    el.appendChild(h("button", { class: "btn", onclick: function () { navigator.clipboard && navigator.clipboard.writeText(S.picked); } }, "Copy"));
    if (pend && pend.kind === "field") {
      el.appendChild(h("button", { class: "btn primary", onclick: function () { S.draft[pend.index][pend.field] = S.picked; S.dirty = true; finishPick(); } }, "Use it for action " + (pend.index + 1)));
    } else if (pend && pend.kind === "add") {
      el.appendChild(h("button", { class: "btn primary", onclick: function () {
        var a = { do: pend.type }; a[pend.type === "camera" ? "target" : "to"] = S.picked; a.at = defaultAt();
        S.draft.push(a); S.dirty = true; finishPick();
      } }, "Add “" + pend.type + "” on it"));
    } else {
      el.appendChild(h("button", { class: "btn primary", onclick: function () {
        save(function (g) { var st = g.steps[S.step]; st.camera = Object.assign({}, st.camera || {}, { target: S.picked }); })
          .then(function () { flash("Camera of step " + stepNo + " now frames " + S.picked, "ok"); setMode("video"); })
          .catch(function (e) { flash(e.message, "err"); });
      } }, "Frame it in step " + stepNo));
    }
    if (pend) el.appendChild(h("button", { class: "btn", onclick: function () { S.pending = null; finishPick(true); } }, "Cancel"));
  }
  function pendingText() { var p = S.pending; return p.kind === "add" ? "Click the element the new “" + p.type + "” is about." : "Click the element for action " + (p.index + 1) + "."; }
  function finishPick(cancel) { S.picked = null; S.pending = null; S.tab = "actions"; setMode("video"); renderPanel(); }
  function defaultAt() { var last = S.draft.length ? S.draft[S.draft.length - 1].at : 0; return typeof last === "string" ? Math.min(90, parseFloat(last) + 15) + "%" : "20%"; }
  function flash(message, kind) {
    var b = $("#banner"); b.hidden = false; b.textContent = message; b.className = "banner " + (kind || "");
    clearTimeout(flash.t); flash.t = setTimeout(function () { b.hidden = true; }, kind === "err" ? 9000 : 3500);
  }

  /* ---------- the panel ---------- */
  function renderPanel() {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.className = b.getAttribute("data-tab") === S.tab ? "on" : ""; });
    var p = $("#panel"); p.textContent = "";
    if (S.tab !== "narration" && S.tab !== "actions" && S.tab !== "assistant") S.tab = "narration";
    if (S.tab === "narration") narrationTab(p);
    else if (S.tab === "actions") actionsTab(p);
    else assistantTab(p);
  }

  function narrationTab(p) {
    if (!S.guide || !S.guide.steps.length) { p.appendChild(h("p", { class: "empty" }, "Select a video with steps.")); return; }
    var step = S.guide.steps[S.step];
    var area = h("textarea", { id: "narr", lang: S.lang }); area.value = text(step.narration, S.lang);
    area.addEventListener("input", function () { S.dirty = true; });
    var msg = h("div", { class: "msg" });
    var titleIn = h("input", { type: "text", placeholder: "Chapter name" }); titleIn.value = text(step.title, S.lang);
    titleIn.addEventListener("input", function () { S.dirty = true; });
    p.appendChild(h("h3", null, "Step " + (S.step + 1) + " · " + step.id));
    p.appendChild(h("label", { class: "lab" }, "Title (chapter name, in “" + S.lang + "”)", titleIn));
    p.appendChild(h("p", null, "What is said, and shown as captions, in “" + S.lang + "”. One idea, one or two sentences."));
    p.appendChild(area);
    p.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: function () {
        var value = area.value.trim(), title = titleIn.value.trim();
        save(function (g) { var st0 = g.steps[S.step], tt = st0.title; if (title) { var o = (tt && typeof tt === "object") ? Object.assign({}, tt) : (typeof tt === "string" ? (function () { var x = {}; g.languages.forEach(function (l) { x[l] = tt; }); return x; })() : {}); o[S.lang] = title; st0.title = o; } var n = g.steps[S.step].narration; g.steps[S.step].narration = typeof n === "object" && n ? Object.assign({}, n, (function () { var o = {}; o[S.lang] = value; return o; })()) : (function () { var o = {}; o[S.lang] = value; return o; })(); })
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

  /* ---------- actions ---------- */
  var ACTION_TYPES = ["move", "click", "type", "highlight", "show", "hide", "value", "select", "check", "camera", "set", "scroll", "tween"];
  var WITH_DURATION = { move: 1, type: 1, highlight: 1, tween: 1, scroll: 1, camera: 1 };
  function actionsTab(p) {
    if (!S.guide || !S.guide.steps.length) { p.appendChild(h("p", { class: "empty" }, "Select a step first.")); return; }
    if (!S.draft) S.draft = JSON.parse(JSON.stringify(S.guide.steps[S.step].actions));
    var d = S.draft;
    p.appendChild(h("h3", null, "Actions of step " + (S.step + 1)));
    p.appendChild(h("p", null, "What happens on screen, in order. “At” is a time in ms, or a percentage of the narration (40%), so it stays in sync with any voice."));
    if (!d.length) p.appendChild(h("p", { class: "empty" }, "No actions: the step only shows its camera and narration."));
    d.forEach(function (a, i) { p.appendChild(actionCard(a, i)); });
    var sel = h("select", null, ACTION_TYPES.map(function (t) { return h("option", { value: t }, t); }));
    p.appendChild(h("div", { class: "row" }, sel, h("button", { class: "btn", onclick: function () {
      S.pending = { kind: "add", type: sel.value }; S.picked = null; S.tab = "actions"; setMode("pick");
    } }, "Add by picking an element…")));
    var msg = h("div", { class: "msg" });
    if (S.msg) { msg.className = "msg " + S.msg.kind; msg.textContent = S.msg.text; }
    p.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", disabled: !S.dirty, onclick: function () {
        save(function (g) { g.steps[S.step].actions = JSON.parse(JSON.stringify(d)); })
          .then(function (r) { S.draft = null; S.msg = { kind: r.warnings.length ? "warn" : "ok", text: r.warnings.length ? "Saved. " + r.warnings.join(" ") : "Saved." }; renderPanel(); })
          .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
      } }, "Save actions"),
      h("button", { class: "btn", disabled: !S.dirty, onclick: function () { S.draft = null; S.dirty = false; renderPanel(); } }, "Discard")));
    p.appendChild(msg);
  }
  function localizedField(label, value, set) {
    var inp = h("input", { type: "text" }); inp.value = typeof value === "string" ? value : (value && value[S.lang]) || "";
    inp.addEventListener("input", function () { S.dirty = true; set(inp.value); renderSaveState(); });
    return h("label", { class: "lab" }, label, inp);
  }
  function renderSaveState() { document.querySelectorAll("#panel .btn.primary[disabled], #panel .btn[disabled]").forEach(function (b) { if (/Save actions|Discard/.test(b.textContent)) b.disabled = false; }); }
  function actionCard(a, i) {
    var d = S.draft;
    var touch = function () { S.dirty = true; renderSaveState(); };
    var card = h("div", { class: "act" });
    card.appendChild(h("div", { class: "acthead" }, h("b", null, (i + 1) + " · " + a.do),
      h("span", null,
        h("button", { title: "Earlier", disabled: i === 0, onclick: function () { d.splice(i - 1, 0, d.splice(i, 1)[0]); S.dirty = true; renderPanel(); } }, "↑"),
        h("button", { title: "Later", disabled: i === d.length - 1, onclick: function () { d.splice(i + 1, 0, d.splice(i, 1)[0]); S.dirty = true; renderPanel(); } }, "↓"),
        h("button", { title: "Remove", onclick: function () { d.splice(i, 1); S.dirty = true; renderPanel(); } }, "✕"))));
    var field = a.do === "camera" ? "target" : "to";
    if (typeof a[field] === "string" || (a[field] === undefined && field === "to")) {
      var sel = h("input", { type: "text" }); sel.value = a[field] || "";
      sel.addEventListener("input", function () { a[field] = sel.value; touch(); });
      card.appendChild(h("label", { class: "lab" }, field === "to" ? "Element" : "Frames", h("div", { class: "pickrow" }, sel,
        h("button", { class: "btn", onclick: function () { S.pending = { kind: "field", index: i, field: field }; S.picked = null; setMode("pick"); } }, "Pick"))));
    }
    var at = h("input", { type: "text", style: "width:90px" }); at.value = a.at == null ? "0" : String(a.at);
    at.addEventListener("input", function () { var v = at.value.trim(); a.at = /%$/.test(v) ? v : (v === "" || isNaN(+v) ? 0 : +v); touch(); });
    var row = h("div", { class: "pickrow" }, h("label", { class: "lab" }, "At (ms or 40%)", at));
    if (WITH_DURATION[a.do]) {
      var du = h("input", { type: "number", min: "0", style: "width:90px" }); du.value = a.duration == null ? "" : a.duration;
      du.addEventListener("input", function () { if (du.value === "") delete a.duration; else a.duration = +du.value; touch(); });
      row.appendChild(h("label", { class: "lab" }, "Duration (ms)", du));
    }
    card.appendChild(row);
    if (a.do === "type") card.appendChild(localizedField("Text typed (“" + S.lang + "”)", a.text, function (v) { a.text = setLocalized(a.text, v); }));
    if (a.do === "value") card.appendChild(localizedField("Value (“" + S.lang + "”)", a.value, function (v) { a.value = setLocalized(a.value, v); }));
    if (a.do === "select") card.appendChild(localizedField("Option (“" + S.lang + "”)", a.option, function (v) { a.option = setLocalized(a.option, v); }));
    if (a.do === "check") {
      var cb = h("input", { type: "checkbox", checked: a.checked !== false });
      cb.addEventListener("change", function () { a.checked = cb.checked; touch(); });
      card.appendChild(h("label", { class: "lab" }, cb, " ticked"));
    }
    if (["set", "scroll", "tween"].indexOf(a.do) >= 0 || typeof (a.target) === "object") {
      var js = h("textarea", { class: "json" }); js.value = JSON.stringify(a, null, 1);
      js.addEventListener("input", function () { try { var o = JSON.parse(js.value); d[i] = o; S.dirty = true; renderSaveState(); js.style.borderColor = ""; } catch (e) { js.style.borderColor = "#a3231b"; } });
      card.appendChild(h("label", { class: "lab" }, "Details (JSON)", js));
    }
    return card;
  }
  function setLocalized(old, v) {
    if (old && typeof old === "object") { var o = Object.assign({}, old); o[S.lang] = v; return o; }
    if (S.guide.languages.length > 1) { var n = {}; S.guide.languages.forEach(function (l) { n[l] = typeof old === "string" ? old : ""; }); n[S.lang] = v; return n; }
    return v;
  }

  /* ---------- check and build ---------- */
  function checkTab(p) {
    if (!S.guide) { p.appendChild(h("p", { class: "empty" }, "Select a video first.")); return; }
    var id = S.guideId;
    var external = (S.voicesTable || []).filter(function (r) { return r.guide === id && ["browser", "none"].indexOf(r.provider) < 0; });
    p.appendChild(h("h3", null, "Check and build"));
    p.appendChild(h("p", null, "Check finds selectors that do not exist, languages without narration, long steps. Build writes the files you publish."));
    var busy = S.busy;
    var btn = function (label, kind, fn) { return h("button", { class: "btn" + (kind ? " " + kind : ""), disabled: !!busy, onclick: fn }, label); };
    p.appendChild(h("div", { class: "row" },
      btn("Check this video", "primary", function () { runCheck(false); }),
      btn("Check layout (opens a browser)", "", function () { runCheck(true); })));
    p.appendChild(h("div", { class: "row" },
      btn("Build this video", "", function () { runBuild({ target: "guide", guide: id }); }),
      btn("Build the whole site", "", function () { runBuild({ target: "site" }); })));
    if (external.length) p.appendChild(h("p", { class: "msg warn" }, "Building generates audio with the external voice chosen for this video (" + external.map(function (r) { return r.language + ": " + r.provider; }).join(", ") + "): the narration text is sent to that service, and it may cost. Texts already generated are not paid again."));
    if (busy) p.appendChild(h("p", { class: "msg" }, busy));
    var c = S.check;
    if (c) {
      var box = h("div", { class: "result" });
      if (c.errors) c.errors.forEach(function (x) { box.appendChild(h("div", { class: "msg err" }, "✕ " + x)); });
      (c.warnings || []).forEach(function (x) { box.appendChild(h("div", { class: "msg warn" }, "! " + x)); });
      (c.layout || []).forEach(function (x) { box.appendChild(h("div", { class: "msg warn" }, "▢ " + x)); });
      if (c.layoutError) box.appendChild(h("div", { class: "msg err" }, c.layoutError));
      if (c.errors && !c.errors.length && !(c.warnings || []).length && !(c.layout || []).length && !c.layoutError) box.appendChild(h("div", { class: "msg ok" }, "✓ Nothing to fix."));
      if (c.built) {
        box.appendChild(h("div", { class: "msg ok" }, "✓ Built" + (c.built.target === "guide" ? (c.built.silent ? " (no recorded audio: the browser reads it)" : " with " + c.built.audioFiles + " audio file(s)") : " (" + c.built.pages + " pages)") + "."));
        box.appendChild(h("a", { href: c.built.url, target: "_blank", rel: "noopener", class: "btn" }, "Open it"));
        (c.built.warnings || []).forEach(function (x) { box.appendChild(h("div", { class: "msg warn" }, "! " + x)); });
      }
      p.appendChild(box);
    }
    if (!S.voicesTable) api("/api/voices").then(function (v) { S.voicesTable = v.table; if (S.page === "export") renderPage(); });
  }
  function runCheck(layout) {
    S.busy = layout ? "Playing the video in a browser to check the layout…" : "Checking…"; S.check = null; renderPage();
    api("/api/check", { method: "POST", body: { guide: S.guideId, layout: layout, lang: S.lang } })
      .then(function (r) { S.check = r; }).catch(function (e) { S.check = { errors: [e.message], warnings: [] }; })
      .then(function () { S.busy = null; renderPage(); });
  }
  function runBuild(body) {
    S.busy = body.target === "site" ? "Building the site…" : "Building the video…"; S.check = null; renderPage();
    api("/api/build", { method: "POST", body: body })
      .then(function (r) { S.check = { errors: [], warnings: [], built: r }; }).catch(function (e) { S.check = { errors: [e.message], warnings: [] }; })
      .then(function () { S.busy = null; S.voicesTable = null; renderPage(); });
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
    box.appendChild(h("button", { class: "btn", onclick: function () { form.hidden = !form.hidden; if (!form.hidden && !form.firstChild) buildForm(form, v, target, spec, function () { renderPage(); }); } }, "Change…"));
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

  /* ---------- the timeline strip ---------- */
  var fmt = function (ms) { var s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  function renderStrip() {
    var strip = $("#strip"); strip.textContent = "";
    var g = video();
    if (!g) { strip.appendChild(h("div", { class: "stripbar" }, "Create a tutorial with “+” on the left.")); return; }
    var timing = g.timing[S.lang] || g.timing[g.languages[0]];
    var total = timing.reduce(function (n, t) { return n + t.total; }, 0);
    var px = S.zoom / 1000;
    strip.appendChild(h("div", { class: "stripbar" }, h("b", null, text(g.title, S.lang)), "· " + fmt(total) + " (estimated: the real length is that of the voice)",
      h("span", { style: "flex:1" }),
      h("span", null, g.steps.length ? "Drag a step to change the order" : ""),
      h("button", { class: "wide", title: "Add a step after the selected one", onclick: addStep }, "+ Step"),
      h("button", { class: "wide", title: "Delete the selected step", disabled: !g.steps.length, onclick: function () { deleteStep(S.step); } }, "Delete"),
      h("button", { title: "Zoom out", onclick: function () { S.zoom = Math.max(20, S.zoom * 0.7); renderStrip(); } }, "−"),
      h("button", { title: "Zoom in", onclick: function () { S.zoom = Math.min(400, S.zoom * 1.4); renderStrip(); } }, "+")));
    if (!g.steps.length) { strip.appendChild(h("div", { class: "stripbar" }, "No steps yet: add the first with “+ Step”.")); return; }
    var lanes = h("div", { class: "lanes", style: "width:" + Math.ceil(total * px + 100) + "px" });
    var ruler = h("div", { class: "ruler" });
    var stepSec = S.zoom >= 120 ? 1 : S.zoom >= 50 ? 5 : 10;
    for (var t = 0; t * 1000 <= total; t += stepSec) ruler.appendChild(h("i", { style: "left:" + t * S.zoom + "px" }, fmt(t * 1000)));
    lanes.appendChild(ruler);
    var lSteps = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Steps"));
    var lNarr = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Voice"));
    var lAct = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Actions"));
    var line = h("div", { class: "dropline", hidden: true });
    var starts = [], x = 0;
    g.steps.forEach(function (st, i) {
      starts.push(x);
      var tm = timing[i], on = i === S.step;
      var pick = function () { if (!confirmLeave()) return; S.step = i; S.draft = null; S.pending = null; S.msg = null; renderSide(); renderView(false); renderPanel(); renderStrip(); };
      var drag = function (cls, style, label, tip) {
        var el = h("div", { class: "blk " + cls + (on ? " on" : ""), draggable: "true", style: style, title: tip, onclick: pick }, label);
        el.addEventListener("dragstart", function (e) { S.dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); el.classList.add("dragging"); });
        el.addEventListener("dragend", function () { el.classList.remove("dragging"); line.hidden = true; S.dragFrom = null; });
        return el;
      };
      lSteps.appendChild(drag("step", "left:" + x * px + "px;width:" + Math.max(8, tm.total * px - 2) + "px", (i + 1) + " · " + (text(st.title, S.lang) || st.id), (text(st.title, S.lang) || st.id) + " — drag to move"));
      lNarr.appendChild(drag("narr", "left:" + x * px + "px;width:" + Math.max(4, tm.narration * px - 2) + "px", text(st.narration, S.lang), text(st.narration, S.lang)));
      st.actions.forEach(function (a) {
        var at = typeof a.at === "string" ? parseFloat(a.at) / 100 * tm.narration : a.at;
        lAct.appendChild(h("div", { class: "mk " + a.do + (on ? " on" : ""), style: "left:" + (x + at) * px + "px", title: a.do + " at " + (typeof a.at === "string" ? a.at : Math.round(a.at) + " ms"), onclick: function () { pick(); S.tab = "actions"; renderPanel(); } }, a.do.charAt(0).toUpperCase()));
      });
      x += tm.total;
    });
    starts.push(x);
    // where a dragged step would land: before the first step whose middle is to the right of the pointer
    var target = function (e, lane) {
      var r = lane.getBoundingClientRect(), px0 = e.clientX - r.left;
      var ms = px0 / px, idx = g.steps.length;
      for (var k = 0; k < g.steps.length; k++) if (ms < (starts[k] + starts[k + 1]) / 2) { idx = k; break; }
      return idx;
    };
    [lSteps, lNarr].forEach(function (lane) {
      lane.addEventListener("dragover", function (e) {
        if (S.dragFrom == null) return;
        e.preventDefault(); e.dataTransfer.dropEffect = "move";
        var idx = target(e, lane);
        line.hidden = false; line.style.left = starts[idx] * px + "px";
      });
      lane.addEventListener("drop", function (e) {
        if (S.dragFrom == null) return;
        e.preventDefault(); var from = S.dragFrom, idx = target(e, lane); line.hidden = true; S.dragFrom = null;
        moveStepTo(from, idx);
      });
    });
    var wrap = h("div", { class: "lanewrap" }, line, lSteps, lNarr);
    lanes.appendChild(wrap); lanes.appendChild(lAct);
    strip.appendChild(h("div", { class: "scroll" }, lanes));
  }

  /* ---------- media: the files of this tutorial, and the ones shared by all ---------- */
  var KB = function (n) { return n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB"; };
  var mediaData = null;
  function renderMedia() {
    var side = $("#media-side");
    var g = video();
    if (!g) { side.textContent = ""; side.appendChild(h("p", { class: "empty" }, "Select or create a tutorial.")); return; }
    api("/api/media/" + g.id).then(function (m) { mediaData = m; drawMedia(); }).catch(function (e) { side.textContent = e.message; });
  }
  function mediaThumb(area, it) {
    var t = h("div", { class: "mt" });
    if (it.kind === "scene") { var fr = h("iframe", { src: "/scene/" + it.name + "?lang=" + S.lang, loading: "lazy", tabindex: "-1" }); t.appendChild(fr); requestAnimationFrame(function () { fr.style.transform = "scale(" + t.clientWidth / 1280 + ")"; }); }
    else if (it.kind === "image") t.appendChild(h("img", { src: it.url, alt: "" }));
    else t.textContent = (it.name.split(".").pop() || "").toUpperCase();
    return t;
  }
  function mediaSection(title, note, area, group) {
    var sec = h("div", { class: "media-sec" }, h("h4", null, title), h("p", null, note));
    group.scenes.concat(group.files).forEach(function (it) {
      var on = S.sel && S.sel.area === area && S.sel.name === it.name && S.sel.kind === it.kind;
      var users = it.usedBy.length ? "used by " + it.usedBy.join(", ") : "not used yet";
      sec.appendChild(h("button", { class: "mitem" + (on ? " on" : ""), onclick: function () { S.sel = { area: area, kind: it.kind, name: it.name }; drawMedia(); } },
        mediaThumb(area, it), h("span", { class: "mn" }, h("b", null, it.kind === "scene" ? it.name + " (screen)" : it.name), h("small", null, KB(it.size) + " · " + users))));
    });
    if (!group.scenes.length && !group.files.length) sec.appendChild(h("p", null, "Nothing here yet."));
    var input = h("input", { type: "file", multiple: true, hidden: true });
    var drop = h("div", { class: "drop" }, "Drop files here or ", h("button", { onclick: function () { input.click(); } }, "choose"), input);
    var send = function (files) {
      Promise.all(Array.prototype.map.call(files, function (f) {
        return fetch("/api/media-file?area=" + area + "&guide=" + encodeURIComponent(S.guideId) + "&name=" + encodeURIComponent(f.name), { method: "POST", headers: { "x-cueflow": "studio" }, body: f })
          .then(function (r) { return r.ok ? null : r.json().then(function (d) { throw new Error(d.error); }); });
      })).then(function () { flash("Uploaded.", "ok"); renderMedia(); }).catch(function (e) { flash(e.message, "err"); });
    };
    input.addEventListener("change", function () { send(input.files); });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("over"); });
    drop.addEventListener("drop", function (e) { e.preventDefault(); drop.classList.remove("over"); send(e.dataTransfer.files); });
    sec.appendChild(drop);
    return sec;
  }
  function drawMedia() {
    var g = video(), m = mediaData; if (!g || !m) return;
    var side = $("#media-side"); side.textContent = "";
    side.appendChild(mediaSection("Media — " + text(g.title, S.lang), "Only this tutorial uses these.", "media", m.media));
    side.appendChild(mediaSection("Shared media", "Used by several tutorials: the site's styles, fonts, icons, shared screens.", "shared", m.shared));
    if (!S.sel) { var first = m.media.scenes[0] || m.shared.scenes[0]; if (first) S.sel = { area: m.media.scenes[0] ? "media" : "shared", kind: "scene", name: first.name }; }
    var item = S.sel && (S.sel.area === "media" ? m.media : m.shared)[S.sel.kind === "scene" ? "scenes" : "files"].filter(function (x) { return x.name === S.sel.name; })[0];
    if (!item) { S.sel = null; item = null; }
    var stage = $("#mstage"), panel = $("#media-panel"); panel.textContent = ""; $("#mpick").textContent = "";
    var mv = $("#mview");
    if (item && item.kind === "scene") {
      stage.querySelectorAll(".imgview,.filebox").forEach(function (n) { n.remove(); }); mv.hidden = false;
      var key = item.name + ":" + S.lang;
      if (mv.dataset.key !== key) { mv.dataset.key = key; mv.src = "/scene/" + item.name + "?lang=" + S.lang; mv.onload = function () { armPicker(mv, function (sel) { showPick(sel); }); }; }
      $("#mpick").appendChild(h("span", null, "Click an element in the screen to get its selector."));
    } else {
      mv.hidden = true; mv.dataset.key = ""; stage.querySelectorAll(".imgview,.filebox").forEach(function (n) { n.remove(); });
      if (!item) stage.appendChild(h("div", { class: "filebox" }, "Select a screen or a file."));
      else if (item.kind === "image") stage.appendChild(h("div", { class: "imgview" }, h("img", { src: item.url, alt: item.name })));
      else if (item.kind === "audio") stage.appendChild(h("div", { class: "filebox" }, h("audio", { controls: true, src: item.url })));
      else if (item.kind === "font") { stage.appendChild(h("div", { class: "filebox" }, h("style", null, "@font-face{font-family:cfprev;src:url('" + item.url + "')}"), h("div", { style: "font:48px cfprev,serif;color:var(--ink)" }, "Aa Bb Cc 0123"))); }
      else { var pre = h("pre", { class: "filebox", style: "overflow:auto;height:100%;margin:0;white-space:pre-wrap;font-size:12px" }, "Loading…"); stage.appendChild(pre); fetch(item.url).then(function (r) { return r.text(); }).then(function (t) { pre.textContent = t.slice(0, 20000); }); }
    }
    if (!item) return;
    panel.appendChild(h("h3", null, item.name));
    panel.appendChild(h("p", null, (item.kind === "scene" ? "A screen of the product" : item.kind) + " · " + KB(item.size) + " · " + (S.sel.area === "media" ? "only in this tutorial" : "shared")));
    panel.appendChild(h("p", null, item.usedBy.length ? "Used by: " + item.usedBy.join(", ") + "." : "No tutorial uses it yet."));
    if (item.languages && item.languages.length) panel.appendChild(h("p", null, "Translated screens: " + item.languages.join(", ")));
    if (item.kind !== "scene") panel.appendChild(h("div", { class: "row" }, h("button", { class: "btn", disabled: item.usedBy.length > 0, title: item.usedBy.length ? "A tutorial uses it: remove it from the scene first" : "", onclick: function () {
      if (!confirm("Delete " + item.name + "?")) return;
      api("/api/media-file?area=" + S.sel.area + "&guide=" + encodeURIComponent(S.guideId) + "&name=" + encodeURIComponent(item.name), { method: "DELETE" }).then(function () { S.sel = null; renderMedia(); }).catch(function (e) { flash(e.message, "err"); });
    } }, "Delete")));
    if (item.kind === "scene") {
      panel.appendChild(h("h3", { style: "margin-top:18px" }, "Elements"));
      var list = h("div", null, h("p", null, "Loading…")); panel.appendChild(list);
      api("/api/elements/" + item.name + "?lang=" + S.lang).then(function (els) {
        list.textContent = "";
        els.slice(0, 80).forEach(function (e) { list.appendChild(h("button", { class: "el", title: "Copy the selector", onclick: function () { showPick(e.selector); } }, h("code", null, e.selector), h("span", null, e.text || e.tag))); });
        if (!els.length) list.appendChild(h("p", null, "No targetable elements: give elements an id or a data-cue."));
      });
    } else panel.appendChild(h("p", { style: "margin-top:12px" }, S.sel.area === "media" ? "Refer to it from a screen as ../media/" + S.guideId + "/" + item.name : "Refer to it from a screen as ../shared/" + item.name));
  }
  function showPick(sel) {
    var box = $("#mpick"); box.textContent = "";
    box.appendChild(h("code", { title: sel }, sel));
    box.appendChild(h("button", { class: "btn", onclick: function () { navigator.clipboard && navigator.clipboard.writeText(sel); flash("Copied " + sel, "ok"); } }, "Copy"));
  }

  /* ---------- the project (brief) and the whole export ---------- */
  function projectDialog() {
    dialog("The project", function (body, close) {
      var b = S.state.brief, f = {};
      var inp = function (k, label, val, tag) { var el = h(tag || "input", tag ? { rows: 3 } : { type: "text" }); el.value = val || ""; f[k] = el; return h("label", { class: "lab" }, label, el); };
      body.appendChild(h("p", null, "What was agreed with the people who watch these videos. It guides the narration and the voice for every tutorial."));
      body.appendChild(h("div", { class: "fields" },
        inp("audience", "Who watches", b.audience), inp("tone", "Tone of the narration", b.tone),
        inp("languages", "Languages (commas; the first is the main)", (b.languages || []).join(", ")),
        inp("maxSeconds", "Longest video (seconds)", String(b.maxSeconds)),
        inp("rules", "Rules for every video (one per line)", (b.rules || []).join("\n"), "textarea"),
        inp("pronunciation", "Pronunciation: written = said (one per line)", Object.keys(b.pronunciation || {}).map(function (k) { return k + " = " + b.pronunciation[k]; }).join("\n"), "textarea")));
      var msg = h("div", { class: "msg" });
      body.appendChild(h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: function () {
          var pron = {}; f.pronunciation.value.split("\n").forEach(function (l) { var i = l.indexOf("="); if (i > 0) pron[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
          api("/api/brief", { method: "POST", body: { audience: f.audience.value.trim() || undefined, tone: f.tone.value.trim() || undefined, languages: f.languages.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean), maxSeconds: +f.maxSeconds.value || 90, rules: f.rules.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean), pronunciation: pron } })
            .then(function (br) { S.state.brief = br; close(); flash("Project saved.", "ok"); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
        } }, "Save"), h("button", { class: "btn", onclick: close }, "Cancel")));
      body.appendChild(msg);
    });
  }
  function exportAll() {
    api("/api/voices").then(function (v) {
      var external = v.table.filter(function (r) { return ["browser", "none"].indexOf(r.provider) < 0; });
      dialog("Export everything", function (body, close) {
        body.appendChild(h("p", null, "Builds every tutorial (" + S.state.guides.length + ") and the dashboard that gathers them: the home with all the videos, one page per tutorial. The files go to " + S.state.outDir + "."));
        if (external.length) body.appendChild(h("p", { class: "msg warn" }, "Audio will be generated with external voices (" + external.map(function (r) { return r.guide + "/" + r.language + ": " + r.provider; }).join(", ") + "): the narration text is sent to that service and it may cost. Texts already generated are not paid again."));
        var posters = h("input", { type: "checkbox" });
        body.appendChild(h("label", { class: "lab" }, posters, " Make a cover picture for each tutorial (needs a browser, Playwright)"));
        var result = h("div", { class: "result" });
        var go = h("button", { class: "btn primary", onclick: function () {
          go.disabled = true; result.textContent = "Building…";
          api("/api/export-all", { method: "POST", body: { posters: posters.checked } }).then(function (r) {
            result.textContent = "";
            result.appendChild(h("div", { class: "msg ok" }, "✓ " + r.guides.length + " tutorial(s) and " + r.pages + " dashboard page(s) built" + (r.siteCreated ? " (the catalog was created)" : r.siteAdded.length ? " (added to the catalog: " + r.siteAdded.join(", ") + ")" : "") + "."));
            r.warnings.forEach(function (w) { result.appendChild(h("div", { class: "msg warn" }, "! " + w)); });
            result.appendChild(h("a", { href: r.url, target: "_blank", rel: "noopener", class: "btn" }, "Open the dashboard"));
            go.disabled = false;
          }).catch(function (e) { result.textContent = ""; result.appendChild(h("div", { class: "msg err" }, e.message)); go.disabled = false; });
        } }, "Export");
        body.appendChild(h("div", { class: "row" }, go, h("button", { class: "btn", onclick: close }, "Close")));
        body.appendChild(result);
      });
    });
  }

  /* ---------- preview: the tutorial as it will be seen ---------- */
  var prevKey = "";
  function renderPreview() {
    var bar = $("#prev-bar"), fr = $("#prev-view"), g = video();
    bar.textContent = "";
    if (!g) { fr.removeAttribute("src"); prevKey = ""; bar.appendChild(h("span", null, "Select or create a tutorial.")); return; }
    var key = "draft:" + g.id + ":" + S.lang;
    if (prevKey !== key && prevKey.indexOf("final:") !== 0) { prevKey = key; fr.src = "/preview/" + g.id + "?lang=" + S.lang; }
    var external = (S.voicesTable || []).filter(function (r) { return r.guide === g.id && ["browser", "none"].indexOf(r.provider) < 0; });
    bar.appendChild(h("b", null, text(g.title, S.lang)));
    bar.appendChild(h("button", { class: "btn", onclick: function () { prevKey = "draft:" + g.id + ":" + S.lang; fr.src = "/preview/" + g.id + "?lang=" + S.lang + "&t=" + Date.now(); } }, "Play from the start (working copy, browser voice)"));
    bar.appendChild(h("button", { class: "btn", onclick: function () {
      if (external.length && !confirm("This builds the video with the external voice chosen (" + external.map(function (r) { return r.language + ": " + r.provider; }).join(", ") + "): the narration text is sent to that service and it may cost. Continue?")) return;
      flash("Building with the final voices…", "");
      api("/api/build", { method: "POST", body: { target: "guide", guide: g.id } }).then(function (r) { prevKey = "final:" + g.id; fr.src = r.url + "?t=" + Date.now(); flash(r.silent ? "Built: no recorded audio, the browser reads it." : "Built with " + r.audioFiles + " audio file(s).", "ok"); }).catch(function (e) { flash(e.message, "err"); });
    } }, "With the final voices"));
    bar.appendChild(h("a", { class: "btn", href: "/preview/" + g.id + "?lang=" + S.lang, target: "_blank", rel: "noopener" }, "Open in a new tab"));
    bar.appendChild(h("span", { style: "color:var(--muted);font-size:12.5px" }, "Plays exactly what viewers get: scenes, camera, cursor, captions, chapters."));
    if (!S.voicesTable) api("/api/voices").then(function (v) { S.voicesTable = v.table; });
  }

  /* ---------- export ---------- */
  function renderExport() {
    var body = $("#export-body"); body.textContent = "";
    if (!video()) { body.appendChild(h("p", { class: "empty" }, "Select or create a tutorial.")); return; }
    body.appendChild(h("h3", null, "Export “" + text(video().title, S.lang) + "”"));
    var holder = h("div"); body.appendChild(holder);
    checkTab(holder);
  }

  /* ---------- wiring ---------- */
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { S.tab = b.getAttribute("data-tab"); renderPanel(); }); });
  document.querySelectorAll(".pagebar button").forEach(function (b) { b.addEventListener("click", function () { showPage(b.getAttribute("data-page")); }); });
  $("#theme").addEventListener("click", function () {
    var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("cueflow-studio-theme", next); } catch (e) { /* private window */ }
  });
  $("#m-video").addEventListener("click", function () { setMode("video"); });
  $("#m-pick").addEventListener("click", function () { setMode("pick"); });
  $("#lang").addEventListener("change", function (e) { S.lang = e.target.value; S.msg = null; viewKey = ""; $("#mview").dataset.key = ""; renderSide(); renderView(false); renderPanel(); renderStrip(); renderPage(); });
  var events = new EventSource("/events");
  events.onmessage = function () {
    // someone else changed the kit (an assistant, an editor); the file watcher also reports our own saves, which we skip
    if (S.ownSave && Date.now() - S.ownSave < 2500) return;
    if (S.dirty) { var b = $("#banner"); b.hidden = false; b.className = "banner"; b.textContent = "The kit changed on disk. Save or discard your edit, then reload this page."; return; }
    loadState().then(function () { viewKey = ""; prevKey = ""; renderView(true); flash("The kit changed: updated.", "ok"); });
  };
  loadState().catch(function (e) { document.body.textContent = "Studio could not load: " + e.message; });
})();
