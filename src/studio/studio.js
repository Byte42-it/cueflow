/* Cueflow Studio: plain browser JS. The kit's files are the single source of truth; this page only reads and writes them. */
(function () {
  "use strict";

  var S = { kind: "video", state: null, guideId: null, guide: null, version: 0, step: 0, lang: null, mode: "video", tab: "narration", dirty: false, picked: null, voices: null, page: "timeline", pending: null, draft: null, zoom: 60, scene: null, check: null, busy: null };
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
  var fantasticoPortal = "https://cueflow.fantastico.cc";
  function portalLink(label) { return h("a", { href: fantasticoPortal, target: "_blank", rel: "noopener" }, label || "Get a key or recharge credit"); }
  function voiceError(msg, error) {
    msg.className = "msg err"; msg.textContent = error.message;
    var form = msg.closest(".voice-form");
    if ((error.status === 402 || error.message.indexOf(fantasticoPortal) >= 0) && !(form && form.querySelector('a[href="' + fantasticoPortal + '"]'))) msg.appendChild(h("p", null, portalLink("Recharge Fantastico credit")));
  }
  function api(path, opts) {
    opts = opts || {};
    if (opts.method && opts.method !== "GET") S.ownSave = Date.now();
    var init = { method: opts.method || "GET", headers: { "x-cueflow": "studio" } };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers["content-type"] = "application/json"; }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || (data.errors && data.errors.join("; ")) || "request failed (" + r.status + ")"); e.data = data; e.status = r.status; if (r.status === 402) flash(e.message, "err"); throw e; }
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
      $("#where").textContent = st.projectRoot; $("#where").title = "The project. Its Cueflow files are in " + st.kitRoot;
      var chip = $("#notes"); chip.hidden = !st.pending; chip.textContent = "✎ " + st.pending + " note" + (st.pending === 1 ? "" : "s") + " for the assistant";
      if (!S.guideId || !video()) S.guideId = st.guides[0] ? st.guides[0].id : null;
      return S.guideId ? loadGuide(S.guideId) : null;
    }).then(function () {
      renderAll();
      if (S.kind !== "doc") return;
      if (!docItem()) { leaveDocMode(); renderAll(); return; }
      return (D.dirty ? Promise.resolve() : loadDoc()).then(renderDocAll);
    });
  }
  function loadGuide(id) {
    return api("/api/guide/" + id).then(function (r) {
      S.guide = r.guide; S.version = r.version; S.history = r.history; renderHistory(); S.dirty = false;
      if (S.step >= S.guide.steps.length) S.step = 0;
      var langs = r.guide.languages;
      if (!S.lang || langs.indexOf(S.lang) < 0) S.lang = langs[0];
    });
  }

  function renderHistory() {
    ["undo", "redo"].forEach(function (direction) {
      var button = $("#" + direction), label = S.history && S.history[direction];
      button.disabled = S.kind === "doc" || !S.guideId || !label || !!S.historyBusy;
      button.title = label ? direction + ": " + label : "Nothing to " + direction;
    });
  }
  function historyMove(direction) {
    if (S.kind === "doc" || S.historyBusy || !S.history || !S.history[direction] || !confirmLeave()) return;
    var p = player(); if (p) p.pause();
    S.historyBusy = true; S.ownSave = Date.now(); renderHistory();
    api("/api/history", { method: "POST", body: { guide: S.guideId, direction: direction } }).then(function (r) {
      S.dirty = false; S.elementDirty = false; S.draft = null; S.pending = null; S.picked = null; S.check = null; S.msg = null;
      viewKey = ""; prevKey = ""; $("#mview").dataset.key = ""; mediaData = null;
      return loadState().then(function () { flash((direction === "undo" ? "Undone: " : "Redone: ") + r.label, "ok"); });
    }).catch(function (e) { flash(e.message, "err"); }).finally(function () { S.historyBusy = false; renderHistory(); });
  }
  $("#undo").addEventListener("click", function () { historyMove("undo"); });
  $("#redo").addEventListener("click", function () { historyMove("redo"); });
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || S.kind === "doc" || e.target.closest("input, textarea, select, [contenteditable]")) return;
    var key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    var direction = key === "y" || e.shiftKey ? "redo" : "undo";
    if (S.history && S.history[direction]) { e.preventDefault(); historyMove(direction); }
  });

  /* ---------- rendering ---------- */
  /* first start: no tutorial yet, so a prompt to give the assistant; the first tutorial brings the normal view */
  function renderWelcome() {
    var empty = !S.state.guides.length;
    document.body.classList.toggle("no-tutorials", empty);
    $("#welcome").hidden = !empty;
    if (!empty) return;
    S.welcomeShown = true;
    api("/api/agent-prompt").then(function (r) { S.welcomePrompt = r.short || r.prompt; $("#welcome-prompt").textContent = r.short || r.prompt; });
  }
  function copyText(t, okMsg, el) {
    return (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { flash(okMsg, "ok"); }, function () { if (el) { var r = document.createRange(); r.selectNodeContents(el); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } flash("Select the text and copy it (Ctrl+C).", ""); });
  }
  /* the assistant: is one connected to Studio (waiting for what we send), what was asked, what it says */
  function refreshAgent() {
    return api("/api/agent").then(function (a) {
      var before = S.agent;
      S.agent = a;
      var dot = $("#aidot"); if (dot) { dot.className = "dot" + (a.connected ? " on" : ""); dot.title = a.connected ? "An assistant is connected" : "No assistant connected"; }
      if (before) {
        a.tasks.forEach(function (t) { var o = before.tasks.filter(function (x) { return x.id === t.id; })[0]; if (t.status === "done" && (!o || o.status !== "done")) flash("Your assistant finished: " + t.title + (t.summary ? " — " + t.summary : ""), "ok"); });
        var seen = before.log.length ? before.log[before.log.length - 1].at : "";
        var fresh = a.log.filter(function (l) { return l.at > seen && !/^Done/.test(l.text); });
        if (fresh.length) flash("Assistant: " + fresh[fresh.length - 1].text, "");
      }
      if ($("#dlg").open && $("#dlg").dataset.agent) renderAgentDialog();
    }).catch(function () { /* Studio is going away */ });
  }
  function renderAgentDialog() {
    var d = $("#dlg"), live = d.querySelector(".alive");
    if (!live) return;
    var a = S.agent || { connected: false, tasks: [], log: [] };
    live.textContent = "";
    live.appendChild(h("div", { class: "agentstate" }, h("i", { class: "dot" + (a.connected ? " on" : "") }), a.connected ? (a.listening ? "An assistant is connected and waiting for you" : "An assistant is connected and working") : "No assistant connected"));
    if (a.tasks.length) { var last = a.tasks.slice(-3).reverse(); var box = h("div", { class: "alog" }); last.forEach(function (t) { box.appendChild(h("div", null, "• " + t.title + " — " + t.status + (t.summary ? ": " + t.summary : ""))); }); live.appendChild(box); }
    if (a.log.length) { var lg = h("div", { class: "alog" }); a.log.slice(-8).forEach(function (l) { lg.appendChild(h("div", null, l.text)); }); live.appendChild(lg); }
  }
  function agentDialog() {
    var q = "/api/agent-prompt?lang=" + encodeURIComponent(S.lang || "") + (S.guideId && S.kind !== "doc" ? "&guide=" + encodeURIComponent(S.guideId) + "&step=" + S.step : "");
    Promise.all([api(q), refreshAgent()]).then(function (res) {
      var r = res[0];
      var d = dialog("Your AI assistant", function (body, close) {
        body.parentNode.classList.add("big");
        body.appendChild(h("div", { class: "alive" }));
        body.appendChild(h("p", null, "Paste this into your assistant (Claude Code in the terminal or in VS Code, or another that can run curl or MCP). The link in it carries the key and returns the full instructions: where the kit is, what exists, what you are looking at and how to talk to Studio. It keeps working if Studio is restarted. Once it is connected, what you ask from Studio (a new tutorial, a request) goes to it directly, without copying. Paste it again in a new session to carry on without starting over."));
        var pre = h("pre", { class: "prompt" }, r.short || r.prompt);
        body.appendChild(pre);
        body.appendChild(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: function () { copyText(r.short || r.prompt, "Copied. Paste it in your assistant.", pre); } }, "Copy"), h("button", { class: "btn", onclick: function () { d.dataset.agent = ""; close(); } }, "Close")));
      });
      d.dataset.agent = "1";
      renderAgentDialog();
    }).catch(function (e) { flash(e.message, "err"); });
  }
  var aiDialog = agentDialog;
  function renderAll() { pickInfo(); renderHistory(); renderWelcome(); renderLang(); renderSide(); renderView(false); renderPanel(); renderStrip(); renderPage(); }
  /* the bottom bar: Media, Timeline, Voice, Export (as in a video editor) */
  function showPage(name) {
    if (name !== S.page && !confirmLeave()) return;
    S.page = name;
    document.querySelectorAll(".page").forEach(function (el) { el.hidden = el.id !== "page-" + name; });
    document.querySelectorAll(".videobar button").forEach(function (b) { b.className = b.getAttribute("data-page") === name ? "on" : ""; });
    renderPage();
  }
  function renderPage() {
    if (S.page === "media") renderMedia();
    else if (S.page === "voice") voicesTab($("#voice-body"));
    else if (S.page === "avatar") avatarPage($("#avatar-body"));
    else if (S.page === "preview") renderPreview();
    else if (S.page === "export") renderExport();
  }
  function renderLang() {
    var sel = $("#lang"); sel.textContent = "";
    var all = {};
    S.state.guides.forEach(function (g) { g.languages.forEach(function (l) { all[l] = 1; }); });
    if (S.state.catalog && S.state.catalog.languages) S.state.catalog.languages.forEach(function (l) { all[l] = 1; });
    Object.keys(all).forEach(function (l) { sel.appendChild(h("option", { value: l, selected: l === S.lang }, l)); });
  }
  function renderSide() { renderFilm(); }
  /* every tutorial, written guide and announcement as thumbnails, in the order of the dashboard, with one "+" on top.
     Dragging a thumbnail changes the order here and on the dashboard (and the row, when it is dropped in another one). */
  function renderFilm() {
    var film = $("#film"); film.textContent = "";
    film.appendChild(h("button", { class: "btn newbtn", onclick: newDialog, title: "A video tutorial, a written guide, or an announcement" }, "+  New"));
    var c = catalog(), shown = {};
    var place = function (wrap, itemId, rowId) {
      wrap.dataset.item = itemId; wrap.dataset.row = rowId || ""; wrap.draggable = true;
      wrap.addEventListener("dragstart", function (e) { S.dragItem = itemId; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", itemId); setTimeout(function () { wrap.classList.add("dragging"); }, 0); });
      wrap.addEventListener("dragend", function () { S.dragItem = null; wrap.classList.remove("dragging"); var l = film.querySelector(".filmline"); if (l) l.hidden = true; });
      film.appendChild(wrap);
    };
    var videoTile = function (g, itemId, rowId) {
      shown[g.id] = true;
      var on = S.kind !== "doc" && g.id === S.guideId;
      var vp = g.viewport || { width: 1280, height: 720 };
      var thumb = h("div", { class: "thumb", style: "aspect-ratio:" + vp.width + " / " + vp.height }, h("span", { class: "kindbadge video" }, g.format === "slides" ? "Slides" : "Video"));
      var fr = h("iframe", { src: "/scene/" + g.scene + "?lang=" + S.lang, loading: "lazy", tabindex: "-1", title: "" });
      fr.style.width = vp.width + "px"; fr.style.height = vp.height + "px";
      thumb.appendChild(fr);
      var total = (g.timing[S.lang] || g.timing[g.languages[0]] || []).reduce(function (n, t) { return n + t.total; }, 0);
      var tile = h("button", { class: "tile" + (on ? " on" : ""), title: text(g.title, S.lang) + " — drag to change the order", onclick: function () { selectGuide(g.id); } },
        thumb, h("span", { class: "cap" }, text(g.title, S.lang)), h("span", { class: "sub" }, g.format === "slides" ? g.steps.length + " slides" : g.steps.length + " steps · " + fmt(total)));
      var del = h("button", { class: "del", title: "Delete this tutorial", "aria-label": "Delete this tutorial", onclick: function (e) { e.stopPropagation(); deleteTutorialDialog(g); } }, h("span", null, "🗑"));
      place(h("div", { class: "tilewrap" }, tile, del), itemId, rowId);
      requestAnimationFrame(function () { fr.style.transform = "scale(" + thumb.clientWidth / vp.width + ")"; });
    };
    var docTile = function (it) {
      var on = S.kind === "doc" && it.id === D.id;
      var missing = c.languages.filter(function (l) { return !it.files[l]; });
      var tile = h("button", { class: "tile" + (on ? " on" : ""), title: text(it.title, S.lang) + " — drag to change the order", onclick: function () { if (S.kind !== "doc" || D.id !== it.id) { D.page = "write"; selectDoc(it.id); } } },
        h("div", { class: "thumb doc" }, h("span", { class: "kindbadge guide" }, it.status === "video" ? "Written part" : "Guide"), it.kicker ? h("i", null, text(it.kicker, S.lang)) : null, h("b", null, text(it.title, S.lang))),
        h("span", { class: "cap" }, text(it.title, S.lang)),
        h("span", { class: "sub" }, missing.length ? "not yet in: " + missing.join(", ") : "in " + c.languages.join(", ")));
      var del = h("button", { class: "del", title: "Take it off the dashboard", "aria-label": "Take it off the dashboard", onclick: function (e) { e.stopPropagation(); deleteItemDialog(it); } }, h("span", null, "🗑"));
      place(h("div", { class: "tilewrap" }, tile, del), it.id, it.row);
    };
    var soonTile = function (it) {
      var tile = h("button", { class: "tile", title: (text(it.desc, S.lang) || text(it.title, S.lang)) + " — drag to change the order", onclick: function () { if (confirmLeave()) { D.page = "details"; selectDoc(it.id); } } },
        h("div", { class: "thumb soonthumb" }, h("span", { class: "kindbadge soon" }, "Coming soon"), h("b", null, text(it.title, S.lang))),
        h("span", { class: "cap" }, text(it.title, S.lang)), h("span", { class: "sub" }, "announced: not written yet"));
      var write = h("button", { class: "del wr", title: "Start writing it: it becomes a written guide", onclick: function (e) { e.stopPropagation(); if (confirmLeave()) startWriting(it); } }, h("span", null, "✎"));
      var del = h("button", { class: "del", title: "Take it off the dashboard", "aria-label": "Take it off the dashboard", onclick: function (e) { e.stopPropagation(); deleteItemDialog(it); } }, h("span", null, "🗑"));
      place(h("div", { class: "tilewrap" }, tile, write, del), it.id, it.row);
    };
    var byId = {}; S.state.guides.forEach(function (g) { byId[g.id] = g; });
    if (c) {
      // as the home page shows them: row by row, the items of a row in the order of the catalog
      var rowIds = c.rows.map(function (r) { return r.id; });
      c.items.forEach(function (it) { if (rowIds.indexOf(it.row) < 0) rowIds.push(it.row); });
      c.rows.length > 0 && rowIds.forEach(function (rid) {
        var items = c.items.filter(function (it) { return it.row === rid; });
        if (!items.length) return;
        var row = c.rows.filter(function (r) { return r.id === rid; })[0];
        if (rowIds.length > 1) film.appendChild(h("div", { class: "rowcap", "data-row": rid }, row ? text(row.title, S.lang) : rid));
        items.forEach(function (it) {
          if (it.status === "soon") return soonTile(it);
          if (it.status === "video" && it.guide && byId[it.guide]) { videoTile(byId[it.guide], it.id, it.row); if (hasArticle(it)) docTile(it); return; }
          if (it.status === "guide" && hasArticle(it)) docTile(it);
        });
      });
    }
    var rest = S.state.guides.filter(function (g) { return !shown[g.id]; });
    if (rest.length) {
      if (c) film.appendChild(h("div", { class: "rowcap", "data-row": "" }, "Not on the dashboard yet"));
      rest.forEach(function (g) { videoTile(g, g.id, ""); });
    }
    film.appendChild(h("div", { class: "filmline", hidden: true }));
    if (S.kind === "doc") return;
    var g = video();
    $("#current").textContent = g ? text(g.title, S.lang) : "";
  }
  /* where a dragged thumbnail would land: before the first one whose middle is below the pointer; its row follows its neighbours */
  function dropTarget(e) {
    var film = $("#film"), wraps = [].slice.call(film.querySelectorAll(".tilewrap:not(.dragging)"));
    var before = null;
    for (var i = 0; i < wraps.length; i++) { var r = wraps[i].getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) { before = wraps[i]; break; } }
    var prev = before ? wraps[wraps.indexOf(before) - 1] : wraps[wraps.length - 1];
    var row = "";
    if (prev && before && prev.dataset.row !== before.dataset.row) {
      var gap = (prev.getBoundingClientRect().bottom + before.getBoundingClientRect().top) / 2;
      row = e.clientY > gap ? before.dataset.row : prev.dataset.row;
    } else row = (prev || before) ? (prev || before).dataset.row : "";
    return { before: before, prev: prev, row: row, wraps: wraps };
  }
  function moveOnDashboard(e) {
    var id = S.dragItem; if (!id) return;
    var t = dropTarget(e), ids = [];
    t.wraps.forEach(function (w) { if (t.before === w) ids.push(id); if (w.dataset.item !== id && ids[ids.length - 1] !== w.dataset.item) ids.push(w.dataset.item); });
    if (!t.before) ids.push(id);
    var dragged = $("#film").querySelector('.tilewrap[data-item="' + id + '"]');
    var changeRow = t.row && dragged && dragged.dataset.row !== t.row;
    api("/api/order", { method: "POST", body: { ids: ids, moved: id, row: changeRow ? t.row : undefined } })
      .then(function () { return loadState(); }).then(function () { flash("Order saved" + (changeRow ? (dragged.dataset.row ? ", in another row of the dashboard" : ", and added to the dashboard") : "") + ". It is the order of the dashboard: Build to publish it.", "ok"); })
      .catch(function (err) { flash(err.message, "err"); });
  }
  function deleteTutorialDialog(g) {
    dialog("Delete “" + text(g.title, S.lang) + "”?", function (body, close) {
      body.appendChild(h("p", null, "Its " + g.steps.length + " steps, its narration and its own media move to the trash folder of the kit (trash/), and it leaves the dashboard. Nothing is erased: you can put it back from there. The screens and shared files stay, because other tutorials may use them."));
      var msg = h("div", { class: "msg" });
      body.appendChild(h("div", { class: "row" },
        h("button", { class: "btn danger", onclick: function () {
          api("/api/guide/" + g.id, { method: "DELETE" }).then(function (r) {
            close();
            if (S.guideId === g.id) { S.guideId = null; S.guide = null; S.step = 0; mediaData = null; prevKey = ""; }
            return loadState().then(function () { flash("Moved to " + r.trash + (r.removedFromCatalog.length ? " and removed from the dashboard." : "."), "ok"); });
          }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
        } }, "Delete"),
        h("button", { class: "btn", onclick: close }, "Cancel")));
      body.appendChild(msg);
    });
  }
  function dialog(title, build) {
    var d = $("#dlg"); d.textContent = ""; d.className = "";
    d.appendChild(h("h3", null, title));
    var body = h("div"); d.appendChild(body);
    build(body, function () { d.close(); });
    if (!d.open) d.showModal();
    return d;
  }
  var slug = function (t) { return String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); };
  /* "+ New": first what kind of thing, then the few facts; with the person's own assistant it creates nothing here but asks it */
  var KINDS = [
    { kind: "video", title: "Video tutorial", text: "Narrated and animated, made of screens of your product." },
    { kind: "guide", title: "Written guide", text: "A page of text with sections, on the dashboard." },
    { kind: "soon", title: "Coming soon", text: "Announce on the dashboard a guide that is not ready yet." }
  ];
  var useAgent = function () { try { return localStorage.getItem("cueflow-studio-use-agent") !== "0"; } catch (e) { return true; } };
  var rememberAgent = function (v) { try { localStorage.setItem("cueflow-studio-use-agent", v ? "1" : "0"); } catch (e) { /* private window */ } };
  function newDialog() {
    dialog("New", function (body, close) {
      var show = function (kind) {
        body.textContent = "";
        if (!kind) {
          body.appendChild(h("p", null, "What do you want to make?"));
          KINDS.forEach(function (k) { body.appendChild(h("button", { class: "kindcard", onclick: function () { show(k.kind); } }, h("b", null, k.title), h("span", null, k.text))); });
          body.appendChild(h("div", { class: "row" }, h("button", { class: "btn", onclick: close }, "Cancel")));
          return;
        }
        var c = catalog(), rows = c ? c.rows : [];
        var f = {};
        var input = function (k, label, ph, tag) { var el = h(tag || "input", tag ? { rows: 2, placeholder: ph } : { type: "text", placeholder: ph }); f[k] = el; return h("label", { class: "lab" }, label, el); };
        var fields = [input("title", "Title", kind === "video" ? "How to … (the title)" : kind === "soon" ? "What it will explain" : "How to … (the title)"), input("id", "Id", "letters, digits, - (the address of its page)")];
        f.title.addEventListener("input", function () { if (!f.id.dataset.touched) f.id.value = slug(f.title.value); });
        f.id.addEventListener("input", function () { f.id.dataset.touched = "1"; });
        if (kind === "video") {
          f.scene = h("select", null, [h("option", { value: "" }, S.state.scenes.length ? "(choose, or leave it to the assistant)" : "(no screens yet: the assistant makes them)")].concat(S.state.scenes.map(function (n) { return h("option", { value: n }, n); })));
          f.vertical = h("input", { type: "checkbox" });
          fields.push(h("label", { class: "lab" }, f.vertical, "Vertical video (portrait, for mobile devices; fixed at creation)"));
          f.slides = h("input", { type: "checkbox" });
          fields.push(h("label", { class: "lab" }, f.slides, "Slides instead of a video (no voice, advanced by hand, full screen)"));
          fields.push(h("label", { class: "lab" }, "First screen", f.scene));
          f.langs = h("input", { type: "text" }); f.langs.value = (S.state.brief.languages.length ? S.state.brief.languages : [S.lang || "en"]).join(", ");
          fields.push(h("label", { class: "lab" }, "Languages, separated by commas", f.langs));
        } else {
          fields.push(input("kicker", "Category (optional)", "e.g. Documents"), input("desc", "Description (optional)", "One or two sentences", "textarea"));
          if (rows.length) {
            var pref = kind === "soon" ? (rows.filter(function (r) { return /soon|arriv|coming|next/i.test(r.id); })[0] || rows[rows.length - 1]) : rows[0];
            f.row = h("select", null, rows.map(function (r) { return h("option", { value: r.id, selected: pref && r.id === pref.id }, text(r.title, S.lang) + " (" + r.id + ")"); }));
            fields.push(h("label", { class: "lab" }, "Row of the home page", f.row));
          }
        }
        var k0 = KINDS.filter(function (k) { return k.kind === kind; })[0];
        body.appendChild(h("p", null, h("b", null, k0.title), " — " + k0.text));
        body.appendChild(h("div", { class: "fields" }, fields));
        var agent = h("input", { type: "checkbox" }); agent.checked = useAgent();
        var msg = h("div", { class: "msg" });
        var go = h("button", { class: "btn primary" });
        var label = function () { go.textContent = !agent.checked ? "Create" : (S.agent && S.agent.connected ? "Send to my assistant" : "Get the prompt for my assistant"); };
        agent.addEventListener("change", function () { rememberAgent(agent.checked); label(); });
        label();
        body.appendChild(h("label", { class: "agentbox" }, agent, h("span", null, h("b", null, "Create it with my local assistant"), h("small", null, "Nothing is created here: you get (or send) a request for your assistant, which asks what you want to make and does it. Remembered for next time."))));
        var request = function () {
          return { kind: kind, vertical: f.vertical ? f.vertical.checked : undefined, format: f.slides && f.slides.checked ? "slides" : undefined, title: f.title.value.trim() || undefined, id: f.id.value.trim() || undefined, scene: f.scene && f.scene.value || undefined,
            languages: f.langs ? f.langs.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : undefined,
            kicker: f.kicker && f.kicker.value.trim() || undefined, desc: f.desc && f.desc.value.trim() || undefined, row: f.row && f.row.value || undefined };
        };
        go.addEventListener("click", function () {
          msg.className = "msg"; msg.textContent = "";
          if (agent.checked) {
            var showPrompt = function () {
              api("/api/agent/request-prompt", { method: "POST", body: { request: request(), lang: S.lang } }).then(function (r) { close(); promptDialog(r.prompt); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
            };
            if (!(S.agent && S.agent.connected)) return showPrompt();
            return api("/api/agent/send", { method: "POST", body: { request: request(), lang: S.lang } })
              .then(function () { close(); flash("Sent to your assistant: it will ask you what you want to make.", "ok"); agentDialog(); })
              .catch(function (e) { if (e.status === 409) showPrompt(); else { msg.className = "msg err"; msg.textContent = e.message; } });
          }
          var t = f.title.value.trim(), id = f.id.value.trim();
          var done = function (r, after) { close(); return loadState().then(after); };
          if (kind === "video") {
            api("/api/guide-create", { method: "POST", body: { id: id, title: t, scene: f.scene.value, vertical: f.vertical.checked, format: f.slides.checked ? "slides" : "video", languages: f.langs.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean) } })
              .then(function (r) { S.guideId = r.id; S.step = 0; S.kind = "video"; leaveDocMode(); return done(r, function () { showPage("timeline"); }); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
          } else {
            api("/api/article-create", { method: "POST", body: { id: id, title: t, kicker: f.kicker.value.trim(), desc: f.desc.value.trim(), row: rows.length ? f.row.value : undefined, status: kind } })
              .then(function (r) { return done(r, function () { if (kind !== "soon") { D.page = "write"; selectDoc(r.id); } else flash("Announced on the dashboard.", "ok"); }); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
          }
        });
        body.appendChild(h("div", { class: "row" }, go, h("button", { class: "btn", onclick: function () { show(null); } }, "Back"), h("button", { class: "btn", onclick: close }, "Cancel")));
        body.appendChild(msg);
      };
      show(null);
    });
  }
  function promptDialog(prompt) {
    dialog("Paste this into your assistant", function (body, close) {
      body.parentNode.classList.add("big");
      body.appendChild(h("p", null, "Open your assistant (Claude Code, in the terminal or in VS Code, or another) in your project, and paste it. It connects to Cueflow, asks you what you want to make, and does it: you see the result here as it appears."));
      var pre = h("pre", { class: "prompt" }, prompt);
      body.appendChild(pre);
      body.appendChild(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: function () { copyText(prompt, "Prompt copied.", pre); } }, "Copy the prompt"), h("button", { class: "btn", onclick: close }, "Close")));
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
  var viewKey = "", viewRevision = 0;
  function renderView(force) {
    if (!S.guide) { view.removeAttribute("src"); return; }
    var key = S.mode === "video" ? "v:" + S.guideId + ":" + S.lang : "p:" + currentScene() + ":" + S.lang;
    if (!force && key === viewKey) { if (S.mode === "video") gotoStep(); return; }
    viewKey = key;
    var revision = "&rev=" + (++viewRevision);
    var src = S.mode === "video" ? "/preview/" + S.guideId + "?lang=" + S.lang + "&studio=1" + revision + "#step-" + (S.step + 1) : "/scene/" + currentScene() + "?lang=" + S.lang + revision;
    view.onload = S.mode === "pick" ? function () { armPicker(view); } : null;
    view.src = src;
  }
  // the step's start, paused: a hash would make the player play from there
  function gotoStep() { seekGlobal(PH ? PH.starts[S.step] || 0 : 0); }

  /* ---------- actions ---------- */
  function selectGuide(id) {
    if (!confirmLeave()) return;
    if (S.kind === "doc") { leaveDocMode(); if (S.guideId === id) { renderAll(); return; } }
    S.guideId = id; S.step = 0; S.picked = null; S.elementDirty = false; S.sel = null; S.check = null; mediaData = null; prevKey = "";
    loadGuide(id).then(function () { renderAll(); });
  }
  function selectStep(i) { if (!confirmLeave()) return; S.msg = null; S.draft = null; S.pending = null; S.step = i; S.dirty = false; S.elementDirty = false; S.picked = null; renderSide(); renderView(false); renderPanel(); pickInfo(); }
  function confirmLeave() {
    if (S.elementDirty && !confirm("This element has unsaved changes. Discard them?")) return false;
    if (S.kind === "doc") { pullEditor(); return !D.dirty || confirm("This written guide has changes you have not saved. Leave without saving?"); }
    return !S.dirty || confirm("The narration of this step has changes you have not saved. Leave without saving?");
  }
  function setMode(m) {
    if (S.elementDirty && !confirmLeave()) return;
    S.elementDirty = false;
    if (m === "video") { S.picked = null; S.pending = null; }
    S.mode = m; viewKey = "";
    $("#m-video").className = m === "video" ? "on" : ""; $("#m-pick").className = m === "pick" ? "on" : "";
    pickInfo(); renderView(false); renderPanel();
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
    frame = frame || view; onPick = onPick || function (sel) {
      if (S.elementDirty && !confirmLeave()) return;
      S.elementDirty = false; S.picked = sel; pickInfo(); renderPanel();
    };
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
      onPick(uniqueSelector(doc, e.target), e.target);
    }, true);
  }
  function pickInfo() {
    var el = $("#pickinfo");
    if (S.mode !== "pick") { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false; el.textContent = "";
    var pend = S.pending;
    if (!S.picked) { el.appendChild(h("span", null, pend ? pendingText() : "Click an element to edit its text or delete it.")); return; }
    if (!pend) { el.appendChild(h("span", null, "Edit the selected element in the side panel.")); return; }
    el.appendChild(h("code", { title: S.picked }, S.picked));
    el.appendChild(h("button", { class: "btn", onclick: function () { copyText(S.picked, "Selector copied. The tutorial is unchanged.", el.querySelector("code")); } }, "Copy selector"));
    if (pend && pend.kind === "field") {
      el.appendChild(h("button", { class: "btn primary", onclick: function () { S.draft[pend.index][pend.field] = S.picked; S.dirty = true; finishPick(); } }, "Use it for action " + (pend.index + 1)));
    } else if (pend && pend.kind === "add") {
      el.appendChild(h("button", { class: "btn primary", onclick: function () {
        var a = { do: pend.type }; a[pend.type === "camera" ? "target" : "to"] = S.picked; a.at = defaultAt();
        if (pend.type === "count") a.end = 0; // the only field without a default: the card asks for it
        if (pend.type === "reorder" || pend.type === "drag") a.into = ""; // the card asks where
        if (pend.type === "tween") { a.prop = "width"; a.from = "0%"; a.end = "100%"; }
        S.draft.push(a); S.dirty = true; finishPick();
      } }, "Add “" + pend.type + "” on it"));
    }
    if (pend) el.appendChild(h("button", { class: "btn", onclick: function () { S.pending = null; finishPick(true); } }, "Cancel"));
  }
  function pendingText() { var p = S.pending; return p.kind === "add" ? "Click the element the new “" + p.type + "” is about." : "Click the element for action " + (p.index + 1) + "."; }
  function finishPick(cancel) { S.picked = null; S.pending = null; S.tab = "actions"; setMode("video"); renderPanel(); }
  function defaultAt() { var last = S.draft.length ? S.draft[S.draft.length - 1].at : 0; return typeof last === "string" ? Math.min(90, parseFloat(last) + 15) + "%" : "20%"; }
  function flash(message, kind) {
    var b = $("#banner"); b.hidden = false; b.textContent = message; b.className = "banner " + (kind || "");
    if (String(message).indexOf(fantasticoPortal) >= 0) b.appendChild(h("span", null, " ", portalLink("Recharge Fantastico credit")));
    clearTimeout(flash.t); flash.t = setTimeout(function () { b.hidden = true; }, kind === "err" ? 9000 : 3500);
  }

  /* ---------- the panel ---------- */
  function renderPanel() {
    document.querySelectorAll(".tabs button").forEach(function (b) { b.className = b.getAttribute("data-tab") === S.tab ? "on" : ""; });
    var p = $("#panel"); p.textContent = "";
    if (S.mode === "pick" && !S.pending) {
      if (!S.picked) { p.appendChild(h("h3", null, "Edit scene")); p.appendChild(h("p", null, "Click text or an element in the scene to edit it.")); return; }
      var selected; try { selected = view.contentDocument.querySelector(S.picked); } catch (e) {}
      if (selected) p.appendChild(elementForm(currentScene(), S.picked, selected, function () {
        S.picked = null; viewKey = ""; prevKey = ""; pickInfo();
      }));
      return;
    }
    if (S.tab !== "narration" && S.tab !== "actions" && S.tab !== "voice" && S.tab !== "avatar") S.tab = "narration";
    if (S.tab === "narration") narrationTab(p);
    else if (S.tab === "actions") actionsTab(p);
    else if (S.tab === "avatar") avatarStepTab(p);
    else voiceTab(p);
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
    var ownSpeech = step.speech && step.speech[S.lang];
    p.appendChild(h("p", null, (ownSpeech ? "What is shown as captions, in “" + S.lang + "”. The voice reads its own text: see Voice." : "What is said, and shown as captions, in “" + S.lang + "”.") + " One idea, one or two sentences."));
    p.appendChild(area);
    if (S.focusNarr) { S.focusNarr = false; setTimeout(function () { area.focus(); }, 0); }
    p.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: function () {
        var value = area.value.trim(), title = titleIn.value.trim();
        save(function (g) { var st0 = g.steps[S.step], tt = st0.title; if (title) { var o = (tt && typeof tt === "object") ? Object.assign({}, tt) : (typeof tt === "string" ? (function () { var x = {}; g.languages.forEach(function (l) { x[l] = tt; }); return x; })() : {}); o[S.lang] = title; st0.title = o; } var n = g.steps[S.step].narration; g.steps[S.step].narration = typeof n === "object" && n ? Object.assign({}, n, (function () { var o = {}; o[S.lang] = value; return o; })()) : (function () { var o = {}; o[S.lang] = value; return o; })(); })
          .then(function (r) { S.msg = { kind: r.warnings.length ? "warn" : "ok", text: r.warnings.length ? "Saved. " + r.warnings.join(" ") : "Saved." }; renderPanel(); })
          .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
      } }, "Save"),
      listenButton(function () { return area.value; }, msg)));
    if (S.msg) { msg.className = "msg " + S.msg.kind; msg.textContent = S.msg.text; }
    p.appendChild(msg);
  }
  /* the browser's voice, chosen as the player chooses it (same language, a natural voice when there is one) */
  // the browser loads its voices late: asking once now makes the list ready by the first Listen
  if (window.speechSynthesis) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = function () {}; }
  function browserVoice(lang) {
    var base = String(lang).slice(0, 2).toLowerCase();
    var mine = speechSynthesis.getVoices().filter(function (v) { return String(v.lang).toLowerCase().indexOf(base) === 0; });
    return mine.filter(function (v) { return /Google|Natural|Online/i.test(v.name); })[0] || mine[0] || null;
  }
  function speak(t, lang, onend) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(t); u.lang = lang;
    var v = browserVoice(lang); if (v) u.voice = v;
    if (onend) u.onend = u.onerror = onend;
    speechSynthesis.speak(u);
  }
  var SPEAKER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
  var STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
  var playing = null; // what Listen is playing now: an <audio>, or the browser voice
  function stopListening() {
    if (playing && playing.pause) playing.pause();
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (playing && playing.done) playing.done();
    playing = null;
  }
  /** Listen: the narration with the tutorial's own voice and pronunciation; a second click stops it. */
  function listenButton(textOf, msg) {
    var b = h("button", { class: "btn icon", title: "Listen with the voice of this tutorial" });
    var idle = function () { b.innerHTML = SPEAKER + "<span>Listen</span>"; };
    idle();
    b.onclick = function () {
      if (playing) return stopListening();
      var t = (textOf() || "").trim();
      if (!t || !S.guide) return;
      b.innerHTML = STOP + "<span>Stop</span>";
      var mine = { done: idle };
      playing = mine;
      fetch("/api/listen", { method: "POST", headers: { "x-cueflow": "studio", "content-type": "application/json" }, body: JSON.stringify({ guide: S.guide.id, language: S.lang, text: t }) })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.error); });
          return /json/.test(r.headers.get("content-type") || "") ? r.json() : r.blob();
        })
        .then(function (d) {
          if (playing !== mine) return;
          if (d && d.browser && d.silent && msg) { msg.className = "msg"; msg.textContent = "This video has no voice in this language: the browser reads it here, the viewers will only see captions."; }
          if (d && d.browser) return speak(d.text, S.lang, function () { if (playing === mine) { playing = null; idle(); } });
          var a = new Audio(URL.createObjectURL(d));
          a.onended = a.onerror = function () { if (playing === a) { playing = null; idle(); } };
          a.done = idle;
          playing = a;
          a.play();
        })
        .catch(function (e) { if (playing === mine) playing = null; idle(); if (msg) voiceError(msg, e); });
    };
    return b;
  }

  /* ---------- the voice of one step ---------- */
  var enc = encodeURIComponent;
  /* the voice a step gets when it is left on Auto: the tutorial's own choice (all languages, then this language), else what the project file says, else the browser's */
  function tutorialVoice(gid, lang) {
    var cur = S.voices && S.voices.current; if (!cur) return { spec: { provider: "browser" }, from: "the default" };
    var own = (cur.guides || {})[gid] || {};
    if ((own.languages || {})[lang]) return { spec: own.languages[lang], from: "this tutorial, in “" + lang + "”" };
    if (own.default) return { spec: own.default, from: "this tutorial" };
    if ((cur.languages || {})[lang]) return { spec: cur.languages[lang], from: "the project file, for “" + lang + "”" };
    if (cur.default) return { spec: cur.default, from: "the project file" };
    return { spec: { provider: "browser" }, from: "the default (browser voice)" };
  }
  function voicesChanged() { flash("Voice saved.", "ok"); S.voices = null; S.voicesRev = (S.voicesRev || 0) + 1; renderPage(); renderStrip(); if (S.tab === "voice") renderPanel(); }
  function uploadStepAudio(file) {
    var st = S.guide.steps[S.step], ext = (file.name.split(".").pop() || "").toLowerCase();
    S.ownSave = Date.now();
    return fetch("/api/step-audio?guide=" + enc(S.guide.id) + "&step=" + enc(st.id) + "&lang=" + enc(S.lang) + "&ext=" + enc(ext), { method: "POST", headers: { "x-cueflow": "studio" }, body: file })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); S.audioRev = (S.audioRev || 0) + 1; return d; }); });
  }
  /* writes (or, with null, removes) this step's own voice in the language being edited */
  function saveStepVoice(voice) {
    var i = S.step, lang = S.lang;
    return save(function (g) {
      var st = g.steps[i], m = Object.assign({}, st.voice || {});
      if (voice) m[lang] = voice; else delete m[lang];
      if (Object.keys(m).length) st.voice = m; else delete st.voice;
    }).then(function (r) { S.audioRev = (S.audioRev || 0) + 1; S.msg = { kind: r.warnings.length ? "warn" : "ok", text: voice ? "Saved: this step has its own voice." : "This step follows the tutorial's voice again." }; renderPanel(); renderStrip(); });
  }
  /* what the voice reads: starts as the caption; only a different text is stored, so a caption edited later is followed */
  function speechForm(p, st, lang) {
    var caption = text(st.narration, lang), mine = st.speech && st.speech[lang];
    var area = h("textarea", { id: "speech", lang: lang }); area.value = mine || caption;
    area.addEventListener("input", function () { S.dirty = true; });
    var msg = h("div", { class: "msg" });
    var store = function (value) {
      var i = S.step;
      return save(function (g) {
        var one = g.steps[i], m = Object.assign({}, one.speech || {});
        if (value && value !== (one.narration[lang] || "").trim()) m[lang] = value; else delete m[lang];
        if (Object.keys(m).length) one.speech = m; else delete one.speech;
      }).then(function () { S.audioRev = (S.audioRev || 0) + 1; S.msg = { kind: "ok", text: value && value !== caption.trim() ? "Saved: the voice reads this text, the caption stays as it is." : "Saved: the voice reads the caption." }; renderPanel(); renderStrip(); })
        .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
    };
    p.appendChild(h("h4", null, "What the voice reads"));
    p.appendChild(h("p", null, "Change a word here to correct how it sounds, such as a term in another language. Captions and transcript keep the text of the Narration tab."));
    p.appendChild(area);
    var buttons = h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: function () { store(area.value.trim()); } }, "Save spoken text"),
      listenButton(function () { return area.value; }, msg));
    if (mine) buttons.appendChild(h("button", { class: "btn", onclick: function () { store(""); } }, "Use the caption again"));
    p.appendChild(buttons);
    p.appendChild(msg);
  }
  function voiceTab(p) {
    if (!S.guide || !S.guide.steps.length) { p.appendChild(h("p", { class: "empty" }, "Select a video with steps.")); return; }
    if (!S.voices) { p.appendChild(h("p", { class: "empty" }, "Loading…")); api("/api/voices").then(function (v) { S.voices = v; if (S.tab === "voice") renderPanel(); }); return; }
    var g = S.guide, st = g.steps[S.step], lang = S.lang, own = st.voice && st.voice[lang];
    p.appendChild(h("h3", null, "Voice · step " + (S.step + 1) + " · “" + lang + "”"));
    autoVoiceForm(p, S.voices, { scope: "step", guide: g.id, language: lang }, own, saveStepVoice, function () {});
    if (own && own.provider === "file") p.appendChild(h("audio", { controls: true, src: "/api/step-audio/" + enc(g.id) + "/" + enc(st.id) + "/" + enc(lang) + "?t=" + (S.audioRev || 0), style: "width:100%" }));
    if (!(own && (own.provider === "file" || own.provider === "none"))) speechForm(p, st, lang);
    if (S.msg) p.appendChild(h("div", { class: "msg " + S.msg.kind }, S.msg.text));
  }

  /* ---------- actions ---------- */
  var ACTION_TYPES = ["move", "hover", "click", "type", "highlight", "show", "hide", "value", "select", "check", "count", "grow", "draw", "reorder", "drag", "camera", "set", "scroll", "tween"];
  var WITH_DURATION = { move: 1, hover: 1, type: 1, highlight: 1, tween: 1, scroll: 1, camera: 1, show: 1, hide: 1, count: 1, reorder: 1, drag: 1, grow: 1, draw: 1 };
  var WITH_EASING = { move: 1, tween: 1, scroll: 1, camera: 1, show: 1, hide: 1, count: 1, reorder: 1, drag: 1, grow: 1, draw: 1 };
  var WITH_STAGGER = { show: 1, hide: 1, grow: 1, draw: 1 };
  var PLACES = ["into", "before", "after"];
  var WITH_ANIMATE = { set: 1, check: 1, select: 1, value: 1 };
  var EASINGS = ["", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "spring"];
  var EFFECTS = ["none", "fade", "slide-up", "slide-down", "slide-left", "slide-right", "scale"];
  var DEFAULT_MS = { move: 800, hover: 600, type: 1200, highlight: 1800, tween: 1500, scroll: 450, camera: 700, show: 300, hide: 200, count: 1200, reorder: 500, drag: 1200, grow: 900, draw: 1200 };
  /* how long an action takes on the timeline, the player's rule without the stagger count (that needs the scene) */
  function actionMs(a) { return a.do === "click" ? 350 : a.animate != null ? a.animate : a.duration != null ? a.duration : WITH_DURATION[a.do] ? DEFAULT_MS[a.do] : 0; }
  function actionTip(a) {
    var parts = [a.do + " at " + (typeof a.at === "string" ? a.at : Math.round(a.at) + " ms")];
    if (a.do !== "click" && actionMs(a)) parts.push(actionMs(a) + " ms");
    if (a.effect) parts.push(a.effect);
    if (a.style) parts.push(a.style);
    PLACES.forEach(function (k) { if (a[k] != null) parts.push(k + " " + a[k]); });
    if (a.stagger != null) parts.push("stagger " + a.stagger + " ms");
    if (a.easing) parts.push(a.easing);
    return parts.join(" · ") + " — click to edit";
  }
  function selectField(label, value, options, set) {
    var sel = h("select", null, options.map(function (o) { return h("option", { value: o }, o === "" ? "default" : o); }));
    sel.value = value == null ? "" : value;
    sel.addEventListener("change", function () { S.dirty = true; set(sel.value); renderSaveState(); });
    return h("label", { class: "lab" }, label, sel);
  }
  function msField(label, value, set, width) {
    var inp = h("input", { type: "number", min: "0", style: "width:" + (width || 90) + "px" }); inp.value = value == null ? "" : value;
    inp.addEventListener("input", function () { S.dirty = true; set(inp.value === "" ? undefined : +inp.value); renderSaveState(); });
    return h("label", { class: "lab" }, label, inp);
  }
  function actionsTab(p) {
    if (!S.guide || !S.guide.steps.length) { p.appendChild(h("p", { class: "empty" }, "Select a step first.")); return; }
    if (!S.draft) S.draft = JSON.parse(JSON.stringify(S.guide.steps[S.step].actions));
    var d = S.draft;
    p.appendChild(h("h3", null, "Actions of step " + (S.step + 1)));
    p.appendChild(h("p", null, "What happens on screen, in order. “At” is a time in ms, or a percentage of the narration (40%), so it stays in sync with any voice."));
    if (!d.length) p.appendChild(h("p", { class: "empty" }, "No actions: the step only shows its camera and narration."));
    d.forEach(function (a, i) {
      var c = actionCard(a, i); p.appendChild(c);
      if (S.focusAction === i) { c.classList.add("focus"); setTimeout(function () { c.scrollIntoView({ block: "nearest" }); }, 0); }
    });
    S.focusAction = null;
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
        h("button", { title: "Play this action", onclick: function () { replayAction(a); } }, "▶"),
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
      var du = h("input", { type: "number", min: "0", placeholder: String(DEFAULT_MS[a.do]), style: "width:90px" }); du.value = a.duration == null ? "" : a.duration;
      du.addEventListener("input", function () { if (du.value === "") delete a.duration; else a.duration = +du.value; touch(); });
      row.appendChild(h("label", { class: "lab" }, "Duration (ms)", du));
    }
    if (WITH_EASING[a.do]) row.appendChild(selectField("Easing", a.easing, EASINGS, function (v) { if (v) a.easing = v; else delete a.easing; }));
    if (WITH_ANIMATE[a.do]) row.appendChild(msField("Animate (ms)", a.animate, function (v) { if (v == null) delete a.animate; else a.animate = v; }));
    card.appendChild(row);
    if (WITH_STAGGER[a.do]) {
      var extra = h("div", { class: "pickrow" });
      if (a.do === "show" || a.do === "hide") extra.appendChild(selectField("Effect", a.effect || (a.do === "show" ? "fade" : "none"), EFFECTS, function (v) { a.effect = v; }));
      if (a.do === "grow") extra.appendChild(selectField("Grows from", a.from || "bottom", ["bottom", "left", "top", "right", "center"], function (v) { a.from = v; }));
      extra.appendChild(msField("Stagger (ms, all the matches)", a.stagger, function (v) { if (v == null) delete a.stagger; else a.stagger = v; }, 110));
      card.appendChild(extra);
    }
    if (a.do === "highlight") card.appendChild(selectField("Style", a.style || "ring", ["ring", "glow", "spotlight"], function (v) { a.style = v; }));
    if (a.do === "reorder" || a.do === "drag") {
      var place = PLACES.filter(function (k) { return a[k] != null; })[0] || "into";
      var dest = h("input", { type: "text", placeholder: "the container, or the sibling" }); dest.value = a[place] || "";
      dest.addEventListener("input", function () { a[place] = dest.value; touch(); });
      var kind = h("select", null, PLACES.map(function (k) { return h("option", { value: k }, k === "into" ? "into (a container)" : k + " (a sibling)"); })); kind.value = place;
      kind.addEventListener("change", function () { var v = a[place]; delete a[place]; place = kind.value; a[place] = v || ""; if (place !== "into") delete a.index; touch(); renderPanel(); });
      var row2 = h("div", { class: "pickrow" }, h("label", { class: "lab" }, "Goes", kind), h("label", { class: "lab", style: "flex:1" }, "Where", h("div", { class: "pickrow" }, dest,
        h("button", { class: "btn", onclick: function () { S.pending = { kind: "field", index: i, field: place }; S.picked = null; setMode("pick"); } }, "Pick"))));
      if (place === "into") row2.appendChild(msField("Position (0 = first, empty = last)", a.index, function (v) { if (v == null) delete a.index; else a.index = v; }, 70));
      card.appendChild(row2);
    }
    if (a.do === "count") {
      var fmt = function () { return a.format || (a.format = {}); };
      var from = h("input", { type: "number", step: "any", placeholder: "as shown", style: "width:110px" }); from.value = a.from == null ? "" : a.from;
      from.addEventListener("input", function () { if (from.value === "") delete a.from; else a.from = +from.value; touch(); });
      var end = h("input", { type: "number", step: "any", style: "width:110px" }); end.value = a.end == null ? "" : a.end;
      end.addEventListener("input", function () { a.end = end.value === "" ? 0 : +end.value; touch(); });
      card.appendChild(h("div", { class: "pickrow" }, h("label", { class: "lab" }, "From", from), h("label", { class: "lab" }, "To", end),
        msField("Decimals", a.format && a.format.decimals, function (v) { if (v == null) delete fmt().decimals; else fmt().decimals = v; }, 70)));
      card.appendChild(h("div", { class: "pickrow" },
        localizedField("Before (“" + S.lang + "”)", a.format && a.format.prefix, function (v) { fmt().prefix = setLocalized(fmt().prefix, v); }),
        localizedField("After (“" + S.lang + "”)", a.format && a.format.suffix, function (v) { fmt().suffix = setLocalized(fmt().suffix, v); })));
    }
    if (a.do === "set") {
      card.appendChild(localizedField("Text (“" + S.lang + "”)", a.text, function (v) { if (v === "" && typeof a.text !== "object") delete a.text; else a.text = setLocalized(a.text, v); }));
      var classes = function (label, key) {
        var inp = h("input", { type: "text", placeholder: "classes, space separated" }); inp.value = (a[key] || []).join(" ");
        inp.addEventListener("input", function () { var v = inp.value.trim(); if (v) a[key] = v.split(/\s+/); else delete a[key]; touch(); });
        return h("label", { class: "lab" }, label, inp);
      };
      card.appendChild(h("div", { class: "pickrow" }, classes("Add classes", "add"), classes("Remove classes", "remove")));
    }
    if (a.do === "type") card.appendChild(localizedField("Text typed (“" + S.lang + "”)", a.text, function (v) { a.text = setLocalized(a.text, v); }));
    if (a.do === "value") card.appendChild(localizedField("Value (“" + S.lang + "”)", a.value, function (v) { a.value = setLocalized(a.value, v); }));
    if (a.do === "select") card.appendChild(localizedField("Option (“" + S.lang + "”)", a.option, function (v) { a.option = setLocalized(a.option, v); }));
    if (a.do === "check") {
      var cb = h("input", { type: "checkbox", checked: a.checked !== false });
      cb.addEventListener("change", function () { a.checked = cb.checked; touch(); });
      card.appendChild(h("label", { class: "lab" }, cb, " ticked"));
    }
    if (["scroll", "tween"].indexOf(a.do) >= 0 || (a.do === "set" && (a.html != null || a.attr != null)) || typeof (a.target) === "object") {
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
  var mp4Exports = {};
  function paintMp4(id, lang, size) {
    var key = id + "|" + lang + "|" + size, box = $("#mp4-result"), state = mp4Exports[key];
    if (!box || box.dataset.key !== key) return;
    box.textContent = "";
    var button = $("#export-mp4");
    if (button) button.disabled = !!S.busy || !!(state && state.running);
    if (!state) return;
    if (state.progress) {
      var pct = state.progress.percent;
      box.appendChild(h("div", { class: "mp4-progress-label", role: "status" }, pct + "% · " + state.progress.phase));
      box.appendChild(h("progress", { class: "mp4-progress", max: 100, value: pct, "aria-label": "MP4 export progress" }));
    }
    if (state.error) { var exportError = h("div"); voiceError(exportError, new Error(state.error)); box.appendChild(exportError); }
    if (state.result) {
      box.appendChild(h("a", { class: "btn", href: state.result.url, download: "" }, "Download MP4"));
      state.result.warnings.forEach(function (w) { box.appendChild(h("div", { class: "msg warn" }, w)); });
    }
  }
  async function runMp4(id, lang, size) {
    var key = id + "|" + lang + "|" + size;
    if (mp4Exports[key] && mp4Exports[key].running) return;
    var state = mp4Exports[key] = { running: true, progress: { percent: 0, phase: "Preparing export…" } };
    paintMp4(id, lang, size);
    try {
      var response = await fetch("/api/export-mp4", { method: "POST", headers: { "x-cueflow": "studio", "content-type": "application/json" }, body: JSON.stringify({ guide: id, lang: lang, size: size, progress: true }) });
      if (!response.ok) { var failure = await response.json(); throw new Error(failure.error || "Export failed"); }
      var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = "";
      try {
        while (true) {
          var chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          var lines = buffer.split("\n"); buffer = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            var event = JSON.parse(lines[i]);
            if (event.error) throw new Error(event.error);
            if (event.progress) state.progress = event.progress;
            if (event.result) state.result = event.result;
            paintMp4(id, lang, size);
          }
          if (chunk.done) break;
        }
        if (!state.result) throw new Error("The connection closed before the export completed.");
      } finally { reader.releaseLock(); }
    } catch (e) { state.error = e.message; }
    finally { state.running = false; paintMp4(id, lang, size); }
  }

  /* slides: a PDF, one page per slide as it is left (every press done) */
  var pdfExports = {};
  function paintPdf(id, lang) {
    var key = id + "|" + lang, box = $("#pdf-result"), state = pdfExports[key];
    if (!box || box.dataset.key !== key) return;
    box.textContent = "";
    var button = $("#export-pdf");
    if (button) button.disabled = !!S.busy || !!(state && state.running);
    if (!state) return;
    if (state.running && state.progress) progressBar(box, state.progress);
    if (state.error) { var e = h("div"); voiceError(e, new Error(state.error)); box.appendChild(e); }
    if (state.result) {
      box.appendChild(h("div", { class: "msg ok" }, "✓ " + state.result.pages + " pages."));
      box.appendChild(h("div", { class: "row" }, h("a", { class: "btn", href: state.result.url, target: "_blank", rel: "noopener" }, "Open it"), h("a", { class: "btn", href: state.result.url, download: "" }, "Download PDF")));
    }
  }
  function runPdf(id, lang) {
    var key = id + "|" + lang;
    if (pdfExports[key] && pdfExports[key].running) return;
    var state = pdfExports[key] = { running: true, progress: { percent: 0, phase: "Preparing…" } };
    paintPdf(id, lang);
    streamed("/api/export-pdf", { guide: id, lang: lang }, function (pr) { state.progress = pr; paintPdf(id, lang); })
      .then(function (r) { state.result = r; })
      .catch(function (e) { state.error = e.message; })
      .then(function () { state.running = false; paintPdf(id, lang); });
  }

  // a POST whose answer is lines of {progress}, then {result} or {error}; resolves with the result
  async function streamed(path, body, onProgress) {
    S.ownSave = Date.now();
    var response = await fetch(path, { method: "POST", headers: { "x-cueflow": "studio", "content-type": "application/json" }, body: JSON.stringify(Object.assign({ progress: true }, body)) });
    if (!response.ok) { var failure = await response.json().catch(function () { return {}; }); throw new Error(failure.error || "request failed (" + response.status + ")"); }
    var reader = response.body.getReader(), decoder = new TextDecoder(), buffer = "", result = null;
    while (true) {
      var chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      var lines = buffer.split("\n"); buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        var event = JSON.parse(lines[i]);
        if (event.error) throw new Error(event.error);
        if (event.progress) onProgress(event.progress);
        if (event.result) result = event.result;
      }
      if (chunk.done) break;
    }
    if (!result) throw new Error("The connection closed before the build completed.");
    return result;
  }
  function progressBar(box, pr) {
    box.textContent = "";
    box.appendChild(h("div", { class: "mp4-progress-label", role: "status" }, pr.percent + "% · " + pr.phase));
    box.appendChild(h("progress", { class: "mp4-progress", max: 100, value: pr.percent, "aria-label": "Build progress" }));
  }

  function checkTab(p) {
    if (!S.guide) { p.appendChild(h("p", { class: "empty" }, "Select a video first.")); return; }
    var id = S.guideId;
    var external = (S.voicesTable || []).filter(function (r) { return r.guide === id && ["browser", "none"].indexOf(r.provider) < 0; });
    p.appendChild(h("h3", null, "Check and build"));
    p.appendChild(h("p", null, "Check finds selectors that do not exist, languages without narration, long steps. Build writes the files you publish."));
    var busy = S.busy;
    var btn = function (label, kind, fn) { return h("button", { class: "btn" + (kind ? " " + kind : ""), disabled: !!busy, onclick: fn }, label); };
    p.appendChild(h("div", { class: "row" },
      btn(S.guide.format === "slides" ? "Check this presentation" : "Check this video", "primary", function () { runCheck(false); }),
      btn("Check layout (opens a browser)", "", function () { runCheck(true); })));
    p.appendChild(h("div", { class: "row" },
      btn(S.guide.format === "slides" ? "Build this presentation (to present it)" : "Build this video", "", function () { runBuild({ target: "guide", guide: id }); }),
      btn("Build the whole site", "", function () { runBuild({ target: "site" }); })));
    checkResults(p, busy); // right under the buttons: further down it is out of sight on a small screen
    if (S.guide.format === "slides") {
      // slides: no voice to generate, no MP4, no page for phones; the file built above is the one to present, the PDF the one to send
      p.appendChild(h("h3", null, "PDF"));
      p.appendChild(h("p", null, "In " + S.lang + ": one page per slide, as it is left after the last press (the steps of the animations are not pages). Pictures of the slides, so it looks exactly like the presentation. Requires Chromium."));
      p.appendChild(h("button", { id: "export-pdf", class: "btn primary", disabled: !!busy || !!(pdfExports[id + "|" + S.lang] && pdfExports[id + "|" + S.lang].running), onclick: function () { runPdf(id, S.lang); } }, "Export PDF"));
      p.appendChild(h("div", { id: "pdf-result", class: "result", "data-key": id + "|" + S.lang }));
      paintPdf(id, S.lang);
      return;
    }
    if (external.length) p.appendChild(h("p", { class: "msg warn" }, "Building generates audio with the external voice chosen for this video (" + external.map(function (r) { return r.language + ": " + r.provider; }).join(", ") + "): the narration text is sent to that service, and it may cost. Texts already generated are not paid again."));
    var narrLangs = (S.voicesTable || []).filter(function (r) { return r.guide === S.guide.id && r.provider === "narrator"; }).map(function (r) { return r.language; });
    var genSteps = S.guide && narrLangs.length ? S.guide.steps.filter(function (st, i) { var sh = S.state.guides.filter(function (x) { return x.id === S.guide.id; })[0]; var a = sh && sh.steps[i] && sh.steps[i].shown; return a && a.provider !== "none" && a.mode !== "off" && a.image; }).length : 0;
    if (genSteps) p.appendChild(h("p", { class: "msg warn" }, "The voice is the narrator's (" + narrLangs.join(", ") + "): building makes a video of the person for " + genSteps + " step(s) × " + narrLangs.length + " language(s) with Fantastico. The picture and the words of each step are sent to the model, and it costs per second of video (about $0.05/s). Steps already made are not paid again."));
    p.appendChild(h("h3", null, "MP4 video"));
    p.appendChild(h("p", null, S.guide.vertical ? "Format: vertical (portrait)." : "Format: horizontal (landscape)."));
    p.appendChild(h("p", null, "Export in " + S.lang + ". Includes recorded audio; browser voices cannot be included. Requires Chromium; FFmpeg is included with Cueflow. Rendering may take several minutes."));
    var size = S.mp4Size || "medium", presets = S.state.videoPresets;
    var sizeSelect = h("select", { id: "mp4-size", onchange: function () { S.mp4Size = this.value; renderPage(); } });
    Object.keys(presets).forEach(function (key) {
      var preset = presets[key];
      sizeSelect.appendChild(h("option", { value: key }, preset.label + " · " + (S.guide.vertical ? preset.height : preset.width) + " × " + (S.guide.vertical ? preset.width : preset.height)));
    });
    sizeSelect.value = size;
    p.appendChild(h("div", { class: "row" }, h("label", { for: "mp4-size" }, "Video size"), sizeSelect));
    var mp4Key = id + "|" + S.lang + "|" + size;
    p.appendChild(h("button", { id: "export-mp4", class: "btn", disabled: !!busy || !!(mp4Exports[mp4Key] && mp4Exports[mp4Key].running), onclick: function () { runMp4(id, S.lang, size); } }, "Export MP4"));
    p.appendChild(h("div", { id: "mp4-result", class: "result", "data-key": mp4Key }));
    paintMp4(id, S.lang, size);
    p.appendChild(h("h3", null, "Page for phones"));
    p.appendChild(h("p", null, "A page ready to send: the picture fills the screen and turns when the phone turns, with the captions over it. It has its own picture and title for the link card of a chat. Publish the whole folder it makes."));
    p.appendChild(h("div", { class: "row" }, btn("Make the page for phones", "", function () { runShare(); })));
    if (S.share) {
      var sh = h("div", { class: "result" });
      sh.appendChild(h("div", { class: "msg ok" }, "✓ Ready in " + S.share.dir + (S.share.link ? ". Once published: " + S.share.link : ".")));
      sh.appendChild(h("a", { href: S.share.url, target: "_blank", rel: "noopener", class: "btn" }, "Open it"));
      S.share.warnings.forEach(function (x) { sh.appendChild(h("div", { class: "msg warn" }, "! " + x)); });
      p.appendChild(sh);
    }
  }
  /* what the last check or build said, under the export section */
  function checkResults(p, busy) {
    if (busy) p.appendChild(h("p", { class: "msg" }, busy));
    if (busy && S.buildProgress) { var bar = h("div", { id: "build-progress" }); progressBar(bar, S.buildProgress); p.appendChild(bar); }
    var c = S.check;
    if (c) {
      var box = h("div", { class: "result" });
      if (c.errors) c.errors.forEach(function (x) { var error = h("div"); voiceError(error, new Error("✕ " + x)); box.appendChild(error); });
      (c.warnings || []).forEach(function (x) { box.appendChild(h("div", { class: "msg warn" }, "! " + x)); });
      (c.layout || []).forEach(function (x) { box.appendChild(h("div", { class: "msg warn" }, "▢ " + x)); });
      if (c.layoutError) box.appendChild(h("div", { class: "msg err" }, c.layoutError));
      if (c.errors && !c.errors.length && !(c.warnings || []).length && !(c.layout || []).length && !c.layoutError) box.appendChild(h("div", { class: "msg ok" }, "✓ Nothing to fix."));
      if (c.built) {
        box.appendChild(h("div", { class: "msg ok" }, "✓ Built" + (c.built.target === "guide" ? (S.guide && S.guide.format === "slides" ? "" : c.built.silent ? " (no recorded audio: the browser reads it)" : " with " + c.built.audioFiles + " audio file(s)" + (c.built.clips ? ", " + c.built.clips + " narrator clip(s)" + (c.built.clipsMade ? " (" + c.built.clipsMade + " made now)" : " (all from before)") : "")) : " (" + c.built.pages + " pages)") + "."));
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
  function runShare() {
    S.busy = "Making the page for phones…"; S.share = null; renderPage();
    api("/api/share", { method: "POST", body: { guide: S.guideId, lang: S.lang } })
      .then(function (r) { S.share = r; }).catch(function (e) { S.check = { errors: [e.message], warnings: [] }; })
      .then(function () { S.busy = null; renderPage(); });
  }
  function runBuild(body) {
    S.busy = body.target === "site" ? "Building the site…" : "Building the video…"; S.check = null; S.buildProgress = body.target === "site" ? null : { percent: 0, phase: "Preparing…" }; renderPage();
    streamed("/api/build", body, function (pr) { S.buildProgress = pr; var bar = $("#build-progress"); if (bar) progressBar(bar, pr); else renderPage(); })
      .then(function (r) { S.check = { errors: [], warnings: [], built: r }; }).catch(function (e) { S.check = { errors: [e.message], warnings: [] }; })
      .then(function () { S.busy = null; S.buildProgress = null; S.voicesTable = null; renderPage(); });
  }

  /* ---------- voices ---------- */
  var label = function (spec) {
    if (!spec) return null;
    if (spec.provider === "narrator") return "The narrator speaks" + (spec.voice ? ": " + spec.voice : " (voice picked at export)") + (spec.otherwise && spec.otherwise.provider !== "browser" ? " · elsewhere " + label(spec.otherwise) : "");
    if (spec.provider === "fantastico") {
      var vendor = (spec.model || "").split("/")[0];
      var name = { heygen: "HeyGen", elevenlabs: "ElevenLabs", google: "Google", mistralai: "Mistral", openai: "OpenAI" }[vendor] || "Fantastico";
      return name + (spec.voice ? ": " + spec.voice : "");
    }
    return { browser: "Browser voice", none: "Silent", file: "Audio file", say: "macOS voice", command: "Local program" }[spec.provider] || spec.provider;
  };
  // Resolve the parent only: the choice at the level being edited must not label its own Auto switch.
  function inheritedVoice(v, target) {
    var cur = v.current, lang = target.language || S.lang, own = (cur.guides || {})[target.guide] || {};
    if (target.scope === "step" && (own.languages || {})[lang]) return { spec: own.languages[lang], from: "this tutorial, in “" + lang + "”" };
    if (target.scope === "step" && own.default) return { spec: own.default, from: "this tutorial" };
    if ((cur.languages || {})[lang]) return { spec: cur.languages[lang], from: "project settings, in “" + lang + "”" };
    return { spec: cur.default || { provider: "browser" }, from: "project settings" };
  }
  function autoVoiceForm(container, v, target, spec, saveVoice, done) {
    var inherited = inheritedVoice(v, target);
    var auto = h("input", { type: "checkbox", checked: !spec });
    var editor = h("div", { class: "voice-custom", hidden: !spec });
    var note = h("p", { class: "voice-auto-note" });
    var message = h("div", { class: "msg", "aria-live": "polite" });
    function describe() {
      note.textContent = auto.checked ? "From " + inherited.from + ". Turn off Auto to choose a different voice" + (target.scope === "step" ? ", mute this step or upload a recording." : ".") : "Choose a voice for " + (target.scope === "step" ? "this step" : target.language ? "this tutorial in “" + target.language + "”" : "this tutorial") + ". Turn on Auto to follow " + inherited.from + " again.";
    }
    function edit() {
      if (!editor.firstChild) buildForm(editor, v, target, spec || inherited.spec, done, { save: saveVoice });
    }
    auto.addEventListener("change", function () {
      stopListening();
      editor.hidden = auto.checked; describe();
      if (!auto.checked) { edit(); return; }
      if (!spec) return;
      auto.disabled = true;
      saveVoice(null).then(function () { spec = null; editor.textContent = ""; done(); }).catch(function (error) { auto.checked = false; editor.hidden = false; describe(); voiceError(message, error); }).then(function () { auto.disabled = false; });
    });
    container.appendChild(h("label", { class: "voice-auto" }, auto, h("span", null, "Auto: " + label(inherited.spec))));
    container.appendChild(note); container.appendChild(editor); container.appendChild(message);
    describe(); if (spec) edit();
  }
  function voicesTab(p) {
    var g = video();
    if (!g) { p.textContent = ""; p.appendChild(h("p", { class: "empty" }, "Select or create a tutorial.")); return; }
    var lang = S.lang;
    api("/api/voices").then(function (v) {
      if (S.lang !== lang || !video() || video().id !== g.id) return;
      S.voices = v; p.textContent = "";
      p.appendChild(h("h3", null, "Audio of this tutorial · “" + lang + "”"));
      p.appendChild(h("p", null, "Auto uses the project voice for the language selected above. Turn off Auto to choose a voice just for this tutorial in “" + lang + "”."));
      var own = v.current.guides[g.id] || {};
      p.appendChild(level(v, { scope: "video", guide: g.id, language: lang }, "Voice · “" + lang + "”", (own.languages || {})[lang] || own.default));
    }).catch(function (e) { p.textContent = e.message; });
  }
  /* ---------- the narrator: chosen like a voice, at three levels (project, video, step), the same in every language ---------- */
  var AV_DEFAULTS = { provider: "none", mode: "pip", position: "bottom-right", x: 0.7, y: 0.6, size: 0.28, shape: "round", background: "#1f2a44" };
  function avatarMerge() { var out = {}; Array.prototype.forEach.call(arguments, function (l) { Object.keys(l || {}).forEach(function (k) { if (l[k] !== undefined && l[k] !== null) out[k] = l[k]; }); }); return out; }
  function avatarWords(a) {
    if (!a || a.provider === "none" || !a.provider) return "No narrator";
    if (a.mode === "off") return "Hidden";
    var where = a.mode === "pip" ? "Corner " + ({ "bottom-right": "↘", "bottom-left": "↙", "top-right": "↗", "top-left": "↖", custom: "at " + Math.round(a.x * 100) + "%, " + Math.round(a.y * 100) + "%" }[a.position] || "↘")
      : a.mode === "side" ? "Side " + (a.position === "left" ? "left" : "right") : a.mode === "band" ? "Band " + (a.position === "top" ? "top" : "bottom") : "Full screen";
    return a.mode === "full" ? where : where + " · " + Math.round(a.size * 100) + "%";
  }
  function isImagePath(v) { return typeof v === "string" && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(v); }
  /* uploads a picture to shared/avatar/ and gives back its kit path */
  function avatarUpload(cb) {
    var inp = h("input", { type: "file", accept: "image/*" });
    inp.addEventListener("change", function () {
      var f = inp.files[0]; if (!f) return;
      S.ownSave = Date.now();
      fetch("/api/media-file?area=shared&name=" + encodeURIComponent("avatar/" + f.name), { method: "POST", headers: { "x-cueflow": "studio" }, body: f })
        .then(function (r) { return r.json(); }).then(function (r) { if (r.error) throw new Error(r.error); cb("shared/" + r.saved); }).catch(function (e) { flash(e.message, "err"); });
    });
    inp.click();
  }
  /**
   * The form of one level. `own` is what this level says (fields may be missing = inherited), `above` what the levels
   * above resolve to (shown as the Auto value). Every control has Auto unless `root` (the project, which has no above).
   */
  function avatarForm(own, above, root, save) {
    var box = h("section", { class: "nar", "aria-label": "Narrator" });
    var v = Object.assign({}, own);
    var resolved = function () { return avatarMerge(AV_DEFAULTS, above, v); };
    var store = function () { save(v); };
    var sel = function (label, key, options) {
      var el = h("select", null, (root ? [] : [h("option", { value: "" }, "Auto (" + (above[key] != null ? above[key] : AV_DEFAULTS[key]) + ")")]).concat(options.map(function (o) { return h("option", { value: o[0] }, o[1]); })));
      el.value = v[key] != null ? v[key] : ""; if (el.value !== (v[key] != null ? String(v[key]) : "")) el.value = root ? AV_DEFAULTS[key] : "";
      el.addEventListener("change", function () { if (el.value === "") delete v[key]; else v[key] = el.value; store(); render(); });
      return h("label", { class: "lab" }, label, el);
    };
    var num = function (label, key, min, max, step) {
      var el = h("input", { type: "range", min: String(min), max: String(max), step: String(step) }), out = h("span", { class: "cur" });
      var cur = v[key] != null ? v[key] : (above[key] != null ? above[key] : AV_DEFAULTS[key]);
      el.value = Math.round(cur * 100); out.textContent = Math.round(cur * 100) + "%" + (v[key] == null && !root ? " (Auto)" : "");
      el.addEventListener("input", function () { v[key] = +el.value / 100; out.textContent = el.value + "%"; });
      el.addEventListener("change", store);
      var wrap = h("label", { class: "lab" }, label, el, out);
      if (!root) wrap.appendChild(h("button", { class: "btn small", title: "Follow the level above", onclick: function () { delete v[key]; store(); render(); } }, "Auto"));
      return wrap;
    };
    var body = h("div");
    function render() {
      body.textContent = "";
      var r = resolved();
      body.appendChild(h("p", { class: "cur" }, "Now: " + avatarWords(r)));
      body.appendChild(h("div", { class: "pickrow" },
        sel("Narrator", "provider", [["none", "None"], ["svg", "Cartoon face, drawn by the player"], ["image", "A picture of the person"], ["command", "A picture, animated by a local program"]]),
        sel("Where", "mode", [["off", "Hidden"], ["pip", "Small, in a corner"], ["side", "Half bust, on a side"], ["band", "A band"], ["full", "Full screen"]])));
      if (r.provider === "image" || r.provider === "command") {
        var img = h("input", { type: "text", placeholder: "shared/avatar/me.png" }); img.value = v.image || "";
        img.addEventListener("change", function () { if (img.value.trim()) v.image = img.value.trim(); else delete v.image; store(); });
        var picRow = h("div", { class: "pickrow" }, img,
          h("button", { class: "btn", onclick: function () { avatarUpload(function (p) { v.image = p; img.value = p; store(); }); } }, "Upload…"),
          h("button", { class: "btn", title: "Describe the person: Fantastico draws a portrait, saved in the kit like an uploaded picture", onclick: function () { portraitDialog(function (p) { v.image = p; img.value = p; store(); render(); }); } }, "Generate a portrait…"));
        body.appendChild(h("div", { class: "pickrow" }, h("label", { class: "lab", style: "flex:1" }, "Picture of the person" + (v.image == null && above.image ? " (Auto: " + above.image + ")" : ""), picRow)));
        if (r.image) body.appendChild(h("img", { class: "avpreview", src: "/kit/" + r.image, alt: "" }));
        if (r.provider === "image") body.appendChild(h("p", { class: "cur" }, "The picture sways and nods as the step is read. With the voice “The narrator speaks” (Voice page), every step that shows it becomes instead a short video of this person saying it, voice and lips together, made at export."));
        if (r.provider === "command") body.appendChild(h("p", { class: "cur" }, "At build, CUEFLOW_AVATAR_COMMAND makes the clip of every step that shows the narrator ({image}, {audio}, {out}; optional {background}, {silence}, {aspect})."));
      }
      if (r.mode === "pip") {
        body.appendChild(h("div", { class: "pickrow" },
          sel("Corner", "position", [["bottom-right", "bottom right"], ["bottom-left", "bottom left"], ["top-right", "top right"], ["top-left", "top left"], ["custom", "where I say (x, y)"]]),
          sel("Shape", "shape", [["round", "round"], ["rounded", "rounded square"]])));
        if (r.position === "custom") body.appendChild(h("div", { class: "pickrow" }, num("Left", "x", 0, 100, 1), num("Top", "y", 0, 100, 1)));
        body.appendChild(num("Size (height of the picture)", "size", 5, 100, 1));
      } else if (r.mode === "side") {
        body.appendChild(sel("Side", "position", [["right", "right"], ["left", "left"]]));
        body.appendChild(num("Width of the panel", "size", 10, 100, 1));
      } else if (r.mode === "band") {
        body.appendChild(sel("Edge", "position", [["bottom", "bottom"], ["top", "top"]]));
        body.appendChild(num("Height of the band", "size", 10, 100, 1));
      }
      if (r.mode !== "off" && r.provider !== "none") {
        var isImg = isImagePath(r.background), clear = r.background === "transparent";
        var color = h("input", { type: "color" }); color.value = /^#[0-9a-f]{6}$/i.test(r.background) ? r.background : "#1f2a44";
        color.addEventListener("change", function () { v.background = color.value; store(); render(); });
        var state = clear ? "transparent" : isImg ? "picture " + r.background.split("/").pop() : "colour";
        // a small palette: transparent (no panel, no shadow: a cut-out floats on the scene), a few colours, any colour
        var palette = h("div", { class: "swatches" });
        [["transparent", "Transparent: no panel, no shadow"], ["#1f2a44", "Navy"], ["#111111", "Black"], ["#ffffff", "White"], ["#2563eb", "Blue"], ["#0f766e", "Teal"], ["#b45309", "Amber"]].forEach(function (c) {
          palette.appendChild(h("button", { class: "sw" + (c[0] === "transparent" ? " clear" : "") + (r.background === c[0] ? " on" : ""), title: c[1], style: c[0] === "transparent" ? "" : "background:" + c[0], onclick: function () { v.background = c[0]; store(); render(); } }));
        });
        palette.appendChild(color);
        var row = h("div", { class: "pickrow" }, h("label", { class: "lab" }, "Background: " + state + (v.background == null && !root ? " (Auto)" : ""), palette),
          h("button", { class: "btn", onclick: function () { avatarUpload(function (p) { v.background = p; store(); render(); }); } }, isImg ? "Change picture…" : "A picture…"));
        if (isImg || clear) row.appendChild(h("button", { class: "btn", onclick: function () { if (root) v.background = color.value; else delete v.background; store(); render(); } }, root ? "Remove: colour" : "Remove"));
        if (!root && v.background != null && !isImg && !clear) row.appendChild(h("button", { class: "btn small", onclick: function () { delete v.background; store(); render(); } }, "Auto"));
        body.appendChild(row);
      }
    }
    render();
    box.appendChild(body);
    return box;
  }
  /* a portrait from words: Fantastico draws it, the kit keeps it */
  function portraitDialog(done) {
    dialog("Generate a portrait", function (body, close) {
      body.appendChild(h("p", null, "Describe the narrator: who they are, how they look, the framing (head and shoulders, facing the camera, plain background). Fantastico draws the picture; you can generate again until it is right. It uses credit."));
      var prompt = h("textarea", { rows: 4, placeholder: "A woman in her forties, short grey hair, glasses, dark blazer, head and shoulders, looking at the camera, soft studio light, plain background" });
      var style = h("input", { type: "text", placeholder: "photo, illustration, flat cartoon… (optional)" });
      var out = h("div", { class: "result" }), msg = h("div", { class: "msg" }), current = null;
      var go = h("button", { class: "btn primary", onclick: function () {
        if (!prompt.value.trim()) { msg.className = "msg err"; msg.textContent = "Describe the person first."; return; }
        go.disabled = true; msg.className = "msg"; msg.textContent = "Drawing…";
        api("/api/avatar-portrait", { method: "POST", body: { prompt: prompt.value.trim(), style: style.value.trim() || undefined } })
          .then(function (r) { current = r.image; out.textContent = ""; out.appendChild(h("img", { class: "avpreview big", src: "/kit/" + r.image + "?t=" + Date.now(), alt: "" })); msg.textContent = r.image; use.disabled = false; go.textContent = "Generate again"; })
          .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; }).then(function () { go.disabled = false; });
      } }, "Generate");
      var use = h("button", { class: "btn", disabled: true, onclick: function () { done(current); close(); } }, "Use this picture");
      body.appendChild(h("label", { class: "lab" }, "The person", prompt));
      body.appendChild(h("label", { class: "lab" }, "Style", style));
      body.appendChild(h("div", { class: "row" }, go, use, h("button", { class: "btn", onclick: close }, "Cancel")));
      body.appendChild(out); body.appendChild(msg);
    });
  }
  /* the Avatar page of the bottom bar: this video's narrator, Auto = the project's */
  function avatarPage(p) {
    var g = video();
    p.textContent = "";
    if (!g) { p.appendChild(h("p", { class: "empty" }, "Select or create a tutorial.")); return; }
    if (g.format === "slides") { p.appendChild(h("p", { class: "empty" }, "A presentation has no voice, so no narrator.")); return; }
    var own = g.avatar || {}, project = S.state.avatar || {};
    p.appendChild(h("h3", null, "Narrator of this tutorial"));
    p.appendChild(h("p", null, "A face over the picture that speaks the narration: a cartoon drawn by the player, or a picture of yours. The same in every language. Auto follows the project (Settings); a step can still differ on its own Avatar tab."));
    var auto = h("input", { type: "checkbox", checked: !Object.keys(own).length });
    var msg = h("div", { class: "msg" });
    var save = function (v) {
      api("/api/avatar", { method: "POST", body: { scope: "video", guide: g.id, avatar: Object.keys(v).length ? v : null } })
        .then(function () { S.ownSave = Date.now(); return loadState(); }).then(function () { return loadGuide(S.guideId); }).then(function () { msg.className = "msg ok"; msg.textContent = Object.keys(v).length ? "Saved: this tutorial has its own narrator." : "Saved: this tutorial follows the project."; viewKey = ""; prevKey = ""; renderStrip(); })
        .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
    };
    auto.addEventListener("change", function () { if (auto.checked) { save({}); form.hidden = true; } else form.hidden = false; });
    p.appendChild(h("label", { class: "lab" }, auto, " Auto: the project's narrator (" + avatarWords(avatarMerge(AV_DEFAULTS, project)) + ")"));
    var form = avatarForm(own, avatarMerge(AV_DEFAULTS, project), false, save); form.hidden = auto.checked;
    p.appendChild(form);
    p.appendChild(msg);
  }
  /* the Avatar tab of one step */
  function avatarStepTab(p) {
    if (!S.guide || !S.guide.steps.length) { p.appendChild(h("p", { class: "empty" }, "Select a step first.")); return; }
    var g = video(), st = S.guide.steps[S.step], own = st.avatar || {};
    var above = avatarMerge(AV_DEFAULTS, S.state.avatar, g && g.avatar);
    p.appendChild(h("h3", null, "Narrator · step " + (S.step + 1)));
    p.appendChild(h("p", null, "Where the narrator is in this step: hidden where it would cover what the step shows, full screen for an intro, a corner elsewhere. Auto follows the tutorial (Avatar page)."));
    var auto = h("input", { type: "checkbox", checked: !Object.keys(own).length });
    var msg = h("div", { class: "msg" });
    var save = function (v) {
      api("/api/avatar", { method: "POST", body: { scope: "step", guide: S.guideId, step: st.id, avatar: Object.keys(v).length ? v : null } })
        .then(function () { S.ownSave = Date.now(); return loadState(); }).then(function () { return loadGuide(S.guideId); }).then(function () { msg.className = "msg ok"; msg.textContent = "Saved."; viewKey = ""; prevKey = ""; renderView(true); renderStrip(); })
        .catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
    };
    auto.addEventListener("change", function () { if (auto.checked) { save({}); form.hidden = true; } else form.hidden = false; });
    p.appendChild(h("label", { class: "lab" }, auto, " Auto: as the tutorial (" + avatarWords(above) + ")"));
    var form = avatarForm(own, above, false, save); form.hidden = auto.checked;
    p.appendChild(form);
    p.appendChild(msg);
  }
  function level(v, target, title, spec) {
    var box = h("div", { class: "lvl" });
    box.appendChild(h("h4", null, title));
    if (target.scope === "global") {
      var form = h("div");
      buildForm(form, v, target, spec, voicesChanged);
      box.appendChild(form);
    } else {
      autoVoiceForm(box, v, target, spec, function (voice) {
        return api("/api/voice", { method: "POST", body: Object.assign({}, target, { voice: voice }) });
      }, voicesChanged);
    }
    return box;
  }
  function buildForm(form, v, target, spec, done, hooks) {
    form.classList.add("voice-form");
    var name = "o" + Math.random().toString(36).slice(2);
    var choice = spec ? spec.provider : target.scope === "global" || target.scope === "step" ? "browser" : "inherit";
    var fields = {}, previewButton, models = [], loadingModels = false, creditStatus, creditButton, creditRevision = 0;
    var msg = h("div", { class: "msg" });
    function opt(value, title, summary, extra) {
      var input = h("input", { type: "radio", name: name, value: value, checked: choice === value });
      input.addEventListener("change", function () { choice = value; refresh(); });
      var box = h("div", { class: "opt voice-option", "data-provider": value }, h("label", { class: "voice-option-heading" }, input, h("span", null, h("b", null, title), h("small", null, summary))));
      if (extra) box.appendChild(extra);
      return box;
    }
    function fld(key, ph, val, type) { var i = h("input", { type: type || "text", placeholder: ph }); i.value = val || ""; fields[key] = i; return i; }
    function refresh() {
      stopListening();
      form.querySelectorAll(".fields").forEach(function (f) { f.hidden = f.getAttribute("data-for") !== choice; });
      if ((choice === "fantastico" || choice === "narrator") && v.hasKey) {
        if (!models.length && !loadingModels) loadModels();
        loadCredit();
      }
      if (fields.oFields) fields.oFields.hidden = fields.otherwise.value !== "fantastico";
    }
    function narratorVoice() {
      var other = fields.otherwise.value, otherwise;
      if (other === "none") otherwise = { provider: "none" };
      else if (other === "fantastico") {
        if (!fields.oModel.value || !fields.oVoice.value) throw new Error("Choose the model and the voice that read the steps where the narrator is not shown (connect your Fantastico key first).");
        otherwise = { provider: "fantastico", model: fields.oModel.value, voice: fields.oVoice.value, style: fields.oStyle.value.trim() || undefined };
      }
      return { provider: "narrator", voice: fields.nVoice.value.trim() || undefined, model: fields.nModel.value.trim() || undefined, otherwise: otherwise };
    }
    function selectedVoice() {
      if (!fields.model.value || !fields.voice.value) throw new Error("Connect your Fantastico key and choose a model and voice first.");
      return { provider: "fantastico", model: fields.model.value, voice: fields.voice.value, style: fields.style.value.trim() || undefined };
    }
    function fillVoices() {
      stopListening();
      [[fields.model, fields.voice, spec], [fields.oModel, fields.oVoice, spec && spec.otherwise]].forEach(function (pair) {
        var modelSel = pair[0], voiceSel = pair[1], chosen = pair[2];
        if (!modelSel) return;
        var model = models.filter(function (m) { return m.id === modelSel.value; })[0];
        voiceSel.textContent = "";
        (model ? model.voices : []).forEach(function (voice) { voiceSel.appendChild(h("option", { value: voice }, voice)); });
        if (chosen && chosen.model === modelSel.value && model && model.voices.indexOf(chosen.voice) >= 0) voiceSel.value = chosen.voice;
      });
    }
    function loadModels() {
      loadingModels = true; msg.className = "msg"; msg.textContent = "Loading Fantastico models and voices…";
      return api("/api/speech-models").then(function (data) {
        models = data.models;
        [[fields.model, spec], [fields.oModel, spec && spec.otherwise]].forEach(function (pair) {
          var modelSel = pair[0], chosen = pair[1];
          if (!modelSel) return;
          modelSel.textContent = "";
          models.forEach(function (model) { modelSel.appendChild(h("option", { value: model.id }, model.name || model.id)); });
          if (chosen && models.some(function (m) { return m.id === chosen.model; })) modelSel.value = chosen.model;
        });
        fillVoices(); msg.textContent = models.length ? "" : "No speech models with selectable voices are currently available.";
      }).catch(function (error) { voiceError(msg, error); }).then(function () { loadingModels = false; });
    }
    function loadCredit() {
      if (!creditStatus || !v.hasKey) return;
      var revision = ++creditRevision;
      creditButton.disabled = true; creditStatus.className = "voice-credit-status";
      creditStatus.textContent = "Loading credit…";
      api("/api/credit").then(function (credit) {
        if (revision !== creditRevision) return;
        if (!credit.available) { creditStatus.textContent = credit.reason; return; }
        var amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(credit.remainingUsd);
        creditStatus.textContent = "Remaining credit: " + amount;
        if (credit.remainingUsd <= 0) { creditStatus.classList.add("err"); creditStatus.textContent += " · Credit exhausted"; }
        else if (credit.lowBalance) { creditStatus.classList.add("warn"); creditStatus.textContent += " · Low credit"; }
        if (credit.status && credit.status !== "active") creditStatus.textContent += " · Status: " + credit.status;
      }).catch(function () {
        if (revision === creditRevision) { creditStatus.className = "voice-credit-status err"; creditStatus.textContent = "Credit unavailable. Refresh to try again."; }
      }).then(function () { if (revision === creditRevision) creditButton.disabled = false; });
    }
    function saveKey() {
      if (fields.key.readOnly) return Promise.resolve();
      var key = fields.key.value.trim();
      if (!key) return Promise.resolve();
      return api("/api/key", { method: "POST", body: { key: key } }).then(function () {
        v.hasKey = true; S.state.hasKey = true; lockKey(); loadCredit();
      });
    }
    function lockKey() {
      fields.key.type = "text"; fields.key.value = "********"; fields.key.readOnly = true;
      fields.key.setAttribute("aria-label", "Fantastico API key");
      fields.keyChange.hidden = false; fields.keyChange.textContent = "Change";
    }
    function extra(prov, kids) { return h("div", { class: "fields", "data-for": prov, hidden: choice !== prov }, kids); }

    var order = { fantastico: 0, narrator: 1 };
    v.options.slice().sort(function (a, b) { return (order[a.provider] == null ? 2 : order[a.provider]) - (order[b.provider] == null ? 2 : order[b.provider]); }).forEach(function (o) {
      if (o.provider === "narrator") {
        if (target.scope === "step") return; // one person for the whole tutorial: a step mutes or records, it does not change narrator
        var nv = fld("nVoice", "auto: picked at the first export", "");
        if (spec && spec.provider === "narrator" && spec.voice) nv.value = spec.voice;
        var nm = fld("nModel", "heygen/avatar-iv", spec && spec.provider === "narrator" ? spec.model : "");
        var other = spec && spec.provider === "narrator" && spec.otherwise ? spec.otherwise.provider : "browser";
        fields.otherwise = h("select", { "aria-label": "Voice where the narrator is not shown", onchange: refresh },
          h("option", { value: "browser" }, "Browser voice (free)"), h("option", { value: "fantastico" }, "A professional voice · Fantastico"), h("option", { value: "none" }, "Silent: captions only"));
        fields.otherwise.value = other;
        fields.oModel = h("select", { "aria-label": "Fantastico speech model", onchange: fillVoices }, h("option", { value: "" }, "Connect a key to load models"));
        fields.oVoice = h("select", { "aria-label": "Fantastico voice", onchange: stopListening }, h("option", { value: "" }, "Choose a model first"));
        fields.oFields = h("div", { class: "voice-selectors", hidden: other !== "fantastico" }, h("label", { class: "voice-field" }, "Model", fields.oModel), h("label", { class: "voice-field" }, "Voice", fields.oVoice), h("label", { class: "voice-field" }, "Speaking style (optional)", fld("oStyle", "e.g. calm and professional", spec && spec.otherwise && spec.otherwise.style)));
        var nkids = [
          h("p", { class: "voice-note" }, v.hasKey ? "Uses the Fantastico key set under Professional voices." : "Connect your Fantastico key under Professional voices first."),
          h("div", { class: "voice-selectors" }, h("label", { class: "voice-field" }, "Voice id of the video model (optional)", nv), h("label", { class: "voice-field" }, "Video model (optional)", nm)),
          h("label", { class: "voice-field" }, "Where the narrator is not shown, the step is read by", fields.otherwise),
          fields.oFields,
          h("p", { class: "voice-note" }, "At export, every step that shows the narrator becomes a short video of the person saying it; that voice is the step's audio. About $0.05 per second of clip, paid once per text. Needs the narrator's picture (Avatar page).")
        ];
        form.appendChild(opt("narrator", o.title, o.summary, extra("narrator", nkids)));
        return;
      }
      if (o.provider === "fantastico") {
        fields.model = h("select", { "aria-label": "Fantastico speech model", onchange: fillVoices }, h("option", { value: "" }, "Connect a key to load models"));
        fields.voice = h("select", { "aria-label": "Fantastico voice", onchange: stopListening }, h("option", { value: "" }, "Choose a model first"));
        var key = fld("key", "ck-fant-…", "", "password");
        key.setAttribute("autocomplete", "new-password"); key.setAttribute("aria-label", "Fantastico API key");
        fields.keyChange = h("button", { type: "button", class: "btn", hidden: !v.hasKey, onclick: function () {
          if (!key.readOnly) { lockKey(); return; }
          key.readOnly = false; key.type = "password"; key.value = "";
          fields.keyChange.textContent = "Cancel"; key.focus();
        } }, "Change");
        if (v.hasKey) lockKey();
        var connect = h("button", { type: "button", class: "btn voice-connect", onclick: function (e) {
          e.preventDefault(); stopListening();
          if (!fields.key.readOnly && !fields.key.value.trim() && !v.hasKey) { voiceError(msg, new Error("Enter a Fantastico key first.")); return; }
          saveKey().then(loadModels).catch(function (error) { voiceError(msg, error); });
        } }, "Connect and load voices");
        creditStatus = h("span", { class: "voice-credit-status", role: "status", "aria-live": "polite" }, "Connect a key to view your credit.");
        creditButton = h("button", { type: "button", class: "btn credit-refresh", title: "Refresh credit", "aria-label": "Refresh credit", onclick: loadCredit });
        creditButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17"/></svg>';
        var kids = [
          h("div", { class: "voice-key" }, h("label", { class: "voice-field" }, "Fantastico key", key), h("div", { class: "row voice-key-actions" }, fields.keyChange, connect), h("div", { class: "voice-key-link" }, portalLink())),
          h("div", { class: "voice-credit" }, creditStatus, creditButton),
          h("div", { class: "voice-selectors" }, h("label", { class: "voice-field" }, "Model", fields.model), h("label", { class: "voice-field" }, "Voice", fields.voice)),
          h("label", { class: "voice-field" }, "Speaking style (optional)", fld("style", "How it should speak, e.g. calm and professional", spec && spec.style)),
          h("p", { class: "voice-note" }, "Previews and new audio use your Fantastico credit. Generated audio is cached.")
        ];
        form.appendChild(opt("fantastico", o.title, o.summary, extra("fantastico", kids)));
      } else if (o.provider === "command") {
        form.appendChild(opt("command", o.title, o.summary, extra("command", [fld("command", "piper --model voice.onnx --output_file {out} < {text}", spec && spec.command)])));
      } else if (o.provider === "say") {
        return;
      } else form.appendChild(opt(o.provider, o.provider === "none" && target.scope === "step" ? "Muted" : o.title, o.provider === "none" && target.scope === "step" ? "No voice for this step: only its captions, whatever the tutorial's voice is." : o.summary, null));
    });
    if (target.scope === "step") {
      var fi = h("input", { type: "file", accept: "audio/*,.mp3,.m4a,.wav,.ogg,.aac" }); fields.file = fi;
      form.appendChild(opt("file", "An audio file", "Your own recording for this step in “" + target.language + "” (mp3, m4a, wav, ogg). Its length sets the length of the step.", extra("file", [spec && spec.provider === "file" ? h("p", { class: "msg" }, "Now: " + spec.file) : null, fi])));
    }
    refresh();
    var actions = h("div", { class: "row voice-actions" });
    form.appendChild(actions);
    actions.appendChild(h("div", { class: "row voice-primary-actions" },
      h("button", { class: "btn primary", onclick: function () {
        var voice = null, work = Promise.resolve();
        if (choice === "inherit") voice = target.scope === "global" ? { provider: "browser" } : null;
        else if (choice === "fantastico") { try { voice = selectedVoice(); } catch (error) { voiceError(msg, error); return; } }
        else if (choice === "narrator") { try { voice = narratorVoice(); } catch (error) { voiceError(msg, error); return; } }
        else if (choice === "command") voice = { provider: "command", command: fields.command.value.trim(), format: "wav" };
        else if (choice === "file") {
          var picked = fields.file.files[0];
          if (!picked && !(spec && spec.provider === "file")) { msg.className = "msg err"; msg.textContent = "Choose an audio file first."; return; }
          if (picked) work = uploadStepAudio(picked).then(function (r) { voice = { provider: "file", file: r.file }; }); else voice = spec;
        } else voice = { provider: choice };
        stopListening();
        if (choice === "fantastico") work = work.then(saveKey);
        work.then(function () { return hooks && hooks.save ? hooks.save(voice) : api("/api/voice", { method: "POST", body: Object.assign({}, target, { voice: voice }) }); })
          .then(function () { done(); }).catch(function (e) { voiceError(msg, e); });
      } }, "Save"),
      previewButton = h("button", { type: "button", class: "btn", onclick: function () {
        if (playing) return stopListening();
        if (choice === "none") return;
        if (choice === "file") {
          var f2 = fields.file.files[0], st2 = S.guide && S.guide.steps[S.step];
          var src = f2 ? URL.createObjectURL(f2) : (spec && spec.provider === "file" && st2 ? "/api/step-audio/" + enc(S.guide.id) + "/" + enc(st2.id) + "/" + enc(target.language) + "?t=" + Date.now() : null);
          if (src) new Audio(src).play(); else { msg.className = "msg err"; msg.textContent = "Choose an audio file first."; }
          return;
        }
        var sample = text((S.guide && S.guide.steps[S.step] || { narration: "" }).narration, target.language || S.lang) || "Hello, this is how the tutorial will sound.";
        var language = target.language || S.lang || (S.state.brief.languages || [])[0] || "en";
        if (choice === "browser" || choice === "inherit") return speak(sample, target.language || S.lang);
        if (choice === "narrator") {
          var nvc; try { nvc = narratorVoice().otherwise; } catch (error) { voiceError(msg, error); return; }
          msg.className = "msg"; msg.textContent = "The narrator's own voice is heard only in the exported clips; this is the voice of the other steps.";
          if (!nvc) return speak(sample, target.language || S.lang);
          if (nvc.provider === "none") return;
        }
        msg.className = "msg"; msg.textContent = "Generating a sample…";
        var vc;
        try { vc = choice === "fantastico" ? selectedVoice() : choice === "narrator" ? narratorVoice().otherwise : choice === "command" ? { provider: "command", command: fields.command.value.trim(), format: "wav" } : { provider: choice }; }
        catch (error) { voiceError(msg, error); return; }
        var previewAudio = null;
        var mine = { done: function () { previewButton.textContent = "Preview"; msg.textContent = ""; } };
        playing = mine; previewButton.textContent = "Stop";
        var ready = choice === "fantastico" ? saveKey() : Promise.resolve();
        ready.then(function () {
          if (playing !== mine) return null;
          return fetch("/api/voice-sample", { method: "POST", headers: { "x-cueflow": "studio", "content-type": "application/json" }, body: JSON.stringify({ voice: vc, text: sample.slice(0, 200), language: language }) });
        })
          .then(function (r) { if (!r) return null; if (!r.ok) return r.json().then(function (d) { var error = new Error(d.error); error.status = r.status; throw error; }); return r.blob(); })
          .then(function (b) {
            if (!b || playing !== mine) return;
            msg.textContent = ""; if (choice === "fantastico") loadCredit();
            var url = URL.createObjectURL(b), audio = new Audio(url);
            previewAudio = audio;
            audio.done = function () { URL.revokeObjectURL(url); mine.done(); };
            audio.onended = audio.onerror = function () { if (playing === audio) stopListening(); };
            playing = audio;
            return audio.play();
          })
          .catch(function (e) { if (playing !== mine && playing !== previewAudio) return; stopListening(); voiceError(msg, e); if (choice === "fantastico") loadCredit(); });
      } }, "Preview")));
    form.appendChild(msg);
  }

  /* ---------- the timeline strip ---------- */
  var fmt = function (ms) { var s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  var PH = null; // the strip as drawn: where each step starts (ms), the scale, the playhead and the transport's parts
  var seeking = false, wanted = null;
  function player() { try { return view.contentWindow.__cueflow || null; } catch (e) { return null; } }
  /* moves the video to a point of the whole timeline (ms), paused; many requests in a row collapse into the last one */
  function seekGlobal(ms, after) {
    if (!PH) return;
    var i = 0; for (var k = 0; k < PH.starts.length - 1; k++) if (ms >= PH.starts[k]) i = k;
    wanted = { i: i, t: Math.max(0, ms - PH.starts[i]), after: after };
    PH.at = ms;
    if (!seeking) runSeek();
  }
  function runSeek() {
    var p = player(); if (!p || !wanted) { wanted = null; return; }
    var w = wanted; wanted = null; seeking = true;
    Promise.resolve(p.seek(w.i, w.t)).catch(function () {}).then(function () { seeking = false; if (wanted) runSeek(); else if (w.after) w.after(); });
  }
  function markOn() {
    document.querySelectorAll("#strip [data-i]").forEach(function (el) { el.classList.toggle("on", +el.getAttribute("data-i") === S.step); });
  }
  /* makes step i the selected one (and shows `tab` in the side panel); false when the person keeps their unsaved edits */
  function focusStep(i, tab) {
    var changes = i !== S.step || (tab && tab !== S.tab);
    if (changes) {
      if (!confirmLeave()) return false;
      S.draft = null; S.pending = null; S.msg = null; S.dirty = false; S.picked = null;
    }
    S.step = i; if (tab) S.tab = tab;
    markOn(); renderPanel();
    if (S.mode === "pick") renderView(false);
    return true;
  }
  /* plays one action of the selected step and stops right after it: the quickest way to judge an effect */
  function replayAction(a) {
    var p = player(); if (!p || !PH || !PH.timing) return;
    var i = S.step, tm = PH.timing[i], at = typeof a.at === "string" ? parseFloat(a.at) / 100 * tm.narration : a.at;
    var from = Math.max(0, at - 150);
    seekGlobal(PH.starts[i] + from, function () {
      p.play();
      setTimeout(function () { p.pause(); }, at - from + actionMs(a) + 250);
    });
  }
  function transport(act) {
    var p = player(); if (!p || !PH) return;
    var st = p.state();
    if (act === "play") { if (st.playing) p.pause(); else p.play(); return; }
    var at = PH.starts[st.step] + Math.min(st.t, st.total);
    var go = act === "next" ? PH.starts[Math.min(st.step + 1, PH.starts.length - 2)]
      : (at - PH.starts[st.step] > 1000 ? PH.starts[st.step] : PH.starts[Math.max(st.step - 1, 0)]);
    if (act === "next" && st.step >= PH.starts.length - 2) return;
    var was = st.playing;
    var i = 0; for (var k = 0; k < PH.starts.length - 1; k++) if (go >= PH.starts[k]) i = k;
    if (i !== S.step) focusStep(i);
    seekGlobal(go, function () { if (was) p.play(); });
  }
  /* the playhead follows the video; while the person drags it, it follows the pointer */
  function frameLoop() {
    requestAnimationFrame(frameLoop);
    if (!PH || S.page !== "timeline" || S.kind === "doc") return;
    var p = player(), st = p && p.state(), ms = PH.at;
    if (st && !seeking && !PH.scrub && !wanted) {
      ms = PH.starts[st.step] + Math.min(st.t, st.total);
      if (st.playing && st.step !== S.step && !S.dirty) { S.draft = null; S.pending = null; S.msg = null; S.step = st.step; markOn(); renderPanel(); }
      PH.at = ms;
    }
    var x = ms * PH.px;
    PH.head.style.left = LBL + x + "px";
    var label = fmt(ms) + " / " + fmt(PH.total);
    if (PH.time.textContent !== label) PH.time.textContent = label;
    var playing = !!(st && st.playing);
    if (PH.playing !== playing) { PH.playing = playing; PH.play.innerHTML = playing ? ICON.pause : ICON.play; PH.play.title = playing ? "Pause (space)" : "Play (space)"; }
    if (playing && !PH.scrub) {
      var sc = PH.scroll;
      if (x + LBL < sc.scrollLeft || x + LBL > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - 40);
    }
  }
  var LBL = 78; // room for the lane names, as in .lanes
  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5l12 7.5-12 7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h2.5v16H5zM19 4.5v15L8.5 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 4H19v16h-2.5zM5 4.5l10.5 7.5L5 19.5z"/></svg>',
    text: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };
  document.addEventListener("keydown", function (e) {
    if (e.key !== " " || S.page !== "timeline" || S.kind === "doc" || e.target.closest("input, textarea, select, button, a, [contenteditable]")) return;
    e.preventDefault(); transport("play");
  });
  requestAnimationFrame(frameLoop);

  /* ---- the sound of each step: a waveform when there is audio (an uploaded file, or what a voice already generated) ---- */
  var audioCtx = null;
  function decodeWave(buf) {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    return new Promise(function (resolve, reject) { audioCtx.decodeAudioData(buf, resolve, reject); }).then(function (a) {
      var ch = a.getChannelData(0), n = 800, size = Math.max(1, Math.floor(ch.length / n)), peaks = [];
      for (var i = 0; i < n; i++) { var m = 0; for (var j = i * size, e = Math.min(ch.length, j + size); j < e; j += Math.max(1, size >> 5)) m = Math.max(m, Math.abs(ch[j])); peaks.push(m); }
      var top = Math.max.apply(null, peaks) || 1;
      return { peaks: peaks.map(function (x) { return x / top; }), dur: a.duration * 1000 };
    });
  }
  S.wave = S.wave || {};
  function waveKey(i) {
    var st = S.guide.steps[i];
    return [S.guide.id, st.id, S.lang, S.version, S.audioRev || 0, S.voicesRev || 0, JSON.stringify(st.voice && st.voice[S.lang] || null), st.narration && st.narration[S.lang] || "", st.speech && st.speech[S.lang] || ""].join("|");
  }
  var waveOf = function (i) { var w = S.wave[waveKey(i)]; return w && w.peaks ? w : null; };
  function loadWaves() {
    var g = S.guide, lang = S.lang, changed = false, pending = 0;
    g.steps.forEach(function (st, i) {
      var key = waveKey(i); if (S.wave[key]) return;
      S.wave[key] = { loading: true }; pending++;
      fetch("/api/step-audio/" + enc(g.id) + "/" + enc(st.id) + "/" + enc(lang) + "?v=" + (S.audioRev || 0))
        .then(function (r) { return r.status === 200 ? r.arrayBuffer().then(decodeWave) : null; })
        .catch(function () { return null; })
        .then(function (w) { S.wave[key] = w || { none: true }; if (w) changed = true; if (--pending === 0 && changed && S.guide && S.guide.id === g.id && S.lang === lang) renderStrip(); });
    });
  }
  function drawWave(cv, peaks) {
    var w = Math.max(2, Math.round(cv.clientWidth || cv.width)), hgt = 34; cv.width = w; cv.height = hgt;
    var c = cv.getContext("2d"); c.clearRect(0, 0, w, hgt); c.fillStyle = "rgba(205,196,255,.85)";
    for (var x = 0; x < w; x += 2) { var pk = peaks[Math.min(peaks.length - 1, Math.floor(x / w * peaks.length))], bh = Math.max(1, pk * (hgt - 4)); c.fillRect(x, (hgt - bh) / 2, 1.4, bh); }
  }
  /* the same rule as the player: a step lasts its narration or its last action, whichever is later, plus its hold */
  function stepTiming(st, lang, narr) {
    var end = 0;
    st.actions.forEach(function (a) { var at = typeof a.at === "string" ? parseFloat(a.at) / 100 * narr : a.at; end = Math.max(end, at + actionMs(a)); });
    return { narration: narr, total: Math.max(narr, end) + (st.hold != null ? st.hold : 600) };
  }
  function renderStrip() {
    var strip = $("#strip"), old = strip.querySelector(".scroll"), keep = old ? { l: old.scrollLeft, t: old.scrollTop } : null;
    strip.textContent = ""; PH = null;
    var g = video();
    if (!g) { strip.appendChild(h("div", { class: "stripbar" }, "Create a tutorial with “+” on the left.")); return; }
    var timing = (g.timing[S.lang] || g.timing[g.languages[0]]).slice();
    // a step that has real audio lasts as long as its audio, as in the player
    var full = S.guide && S.guide.id === g.id && S.guide.steps.length === g.steps.length ? S.guide : null;
    if (full) timing = timing.map(function (t, i) { var w = waveOf(i); return w && w.dur ? stepTiming(full.steps[i], S.lang, w.dur) : t; });
    if (full && !S.voices) api("/api/voices").then(function (v) { S.voices = v; renderStrip(); }).catch(function () {});
    var total = timing.reduce(function (n, t) { return n + t.total; }, 0);
    var px = S.zoom / 1000;
    var btn = function (act, icon, title) { var b = h("button", { class: "tp", title: title, "aria-label": title, onclick: function () { transport(act); } }); b.innerHTML = icon; return b; };
    var playBtn = btn("play", ICON.play, "Play (space)"), timeEl = h("span", { class: "tptime" }, "0:00 / " + fmt(total));
    strip.appendChild(h("div", { class: "stripbar" },
      h("span", { class: "transport" }, btn("prev", ICON.prev, "Previous step"), playBtn, btn("next", ICON.next, "Next step"), timeEl),
      h("b", null, text(g.title, S.lang)), "· " + fmt(total) + " (estimated where there is no audio yet)",
      h("span", { style: "flex:1" }),
      h("span", null, g.steps.length ? "Drag a step to change the order" : ""),
      h("button", { class: "wide", title: "Add a step after the selected one", onclick: addStep }, "+ Step"),
      h("button", { class: "wide", title: "Delete the selected step", disabled: !g.steps.length, onclick: function () { deleteStep(S.step); } }, "Delete"),
      h("button", { title: "Zoom out", onclick: function () { S.zoom = Math.max(20, S.zoom * 0.7); renderStrip(); } }, "−"),
      h("button", { title: "Zoom in", onclick: function () { S.zoom = Math.min(400, S.zoom * 1.4); renderStrip(); } }, "+")));
    if (!g.steps.length) { strip.appendChild(h("div", { class: "stripbar" }, "No steps yet: add the first with “+ Step”.")); return; }
    var lanes = h("div", { class: "lanes", style: "width:" + Math.ceil(total * px + 100 + LBL) + "px" });
    var ruler = h("div", { class: "ruler", title: "Drag to move through the video" });
    var stepSec = S.zoom >= 120 ? 1 : S.zoom >= 50 ? 5 : 10;
    for (var t = 0; t * 1000 <= total; t += stepSec) ruler.appendChild(h("i", { style: "left:" + t * S.zoom + "px" }, fmt(t * 1000)));
    lanes.appendChild(ruler);
    // the narrator first: it is drawn over the picture, so it sits over the other lanes too
    var lAv = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Avatar"));
    if (g.format !== "slides") lanes.appendChild(lAv);
    var lSteps = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Steps"));
    var lNarr = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Text"));
    var lTr = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Voice"));
    var lAct = h("div", { class: "lane" }, h("span", { class: "lbl" }, "Actions"));
    var line = h("div", { class: "dropline", hidden: true });
    var starts = [], x = 0;
    var msAt = function (clientX) { return (clientX - lanes.getBoundingClientRect().left - LBL) / px; };
    // a click on a block selects its step and moves the video to where it was clicked
    var clickAt = function (e, i, tab) {
      if (tab === "narration") S.focusNarr = true;
      if (!focusStep(i, tab)) { S.focusNarr = false; return; }
      seekGlobal(Math.max(starts[i], Math.min(starts[i + 1] - 1, msAt(e.clientX))));
    };
    g.steps.forEach(function (st, i) {
      starts.push(x);
      var tm = timing[i], on = i === S.step, x0 = x;
      var drag = function (cls, style, label, tip, tab) {
        var el = h("div", { class: "blk " + cls + (on ? " on" : ""), "data-i": i, draggable: "true", style: style, title: tip, onclick: function (e) { clickAt(e, i, tab); } }, label);
        el.addEventListener("dragstart", function (e) { S.dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); el.classList.add("dragging"); });
        el.addEventListener("dragend", function () { el.classList.remove("dragging"); line.hidden = true; S.dragFrom = null; });
        return el;
      };
      lSteps.appendChild(drag("step", "left:" + x * px + "px;width:" + Math.max(8, tm.total * px - 2) + "px", (i + 1) + " · " + (text(st.title, S.lang) || st.id), (text(st.title, S.lang) || st.id) + " — drag to move"));
      if (g.format !== "slides") {
        var shown = (g.steps[i] && g.steps[i].shown) || avatarMerge(AV_DEFAULTS, S.state.avatar, g.avatar), ownAv = g.steps[i] && g.steps[i].avatar && Object.keys(g.steps[i].avatar).length;
        var hidden = shown.provider === "none" || shown.mode === "off";
        lAv.appendChild(h("div", { class: "blk av" + (on ? " on" : "") + (hidden ? " av-off" : " av-" + shown.mode), "data-i": i, style: "left:" + x * px + "px;width:" + Math.max(8, tm.total * px - 2) + "px",
          title: avatarWords(shown) + (ownAv ? " (this step's own)" : " (Auto)") + " — click to change", onclick: function (e) { clickAt(e, i, "avatar"); } }, (ownAv ? "" : "Auto · ") + avatarWords(shown)));
      }
      lNarr.appendChild(drag("narr", "left:" + x * px + "px;width:" + Math.max(4, tm.narration * px - 2) + "px", text(st.narration, S.lang), text(st.narration, S.lang), "narration"));
      var own = full && full.steps[i].voice && full.steps[i].voice[S.lang], vs = own || (S.voices ? tutorialVoice(g.id, S.lang).spec : null), wv = waveOf(i);
      var vtxt = !vs ? "Auto" : vs.provider === "none" ? "Muted" : vs.provider === "file" ? "Audio file" : (own ? "" : "Auto · ") + label(vs) + (full && full.steps[i].speech && full.steps[i].speech[S.lang] ? " · own text" : "");
      var vbar = h("div", { class: "blk vo" + (wv ? " has" : "") + (vs && vs.provider === "none" ? " muted" : ""), "data-i": i, style: "left:" + x * px + "px;width:" + Math.max(4, tm.narration * px - 2) + "px", title: vtxt + (wv ? "" : " — no audio yet: it is generated when you build") + " — click to change", onclick: function (e) { clickAt(e, i, "voice"); } });
      if (wv) { var cv = h("canvas"); vbar.appendChild(cv); vbar._wave = { cv: cv, peaks: wv.peaks }; }
      vbar.appendChild(h("span", { class: "vlbl" }, vtxt));
      lTr.appendChild(vbar);
      st.actions.forEach(function (a, ai) {
        var at = typeof a.at === "string" ? parseFloat(a.at) / 100 * tm.narration : a.at;
        var wpx = a.do === "click" ? 0 : actionMs(a) * px; // a bar as long as the action; a point when it is short
        lAct.appendChild(h("div", { class: "mk " + a.do + (on ? " on" : "") + (wpx > 24 ? " bar" : "") + (a.stagger ? " stag" : ""), "data-i": i,
          style: "left:" + (x + at) * px + "px" + (wpx > 24 ? ";width:" + wpx + "px" : ""), title: actionTip(a),
          onclick: function (e) { e.stopPropagation(); S.focusAction = ai; if (!focusStep(i, "actions")) { S.focusAction = null; return; } seekGlobal(x0 + at); } }, a.do.charAt(0).toUpperCase()));
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
    lanes.appendChild(wrap); lanes.appendChild(lTr); lanes.appendChild(lAct);
    var head = h("div", { class: "playhead" });
    lanes.appendChild(head);
    var scroll = h("div", { class: "scroll" }, lanes);
    strip.appendChild(scroll);
    lTr.querySelectorAll(".vo").forEach(function (b) { if (b._wave) drawWave(b._wave.cv, b._wave.peaks); });
    if (full) loadWaves();
    if (keep) { scroll.scrollLeft = keep.l; scroll.scrollTop = keep.t; }
    PH = { starts: starts, px: px, total: total, timing: timing, head: head, time: timeEl, play: playBtn, scroll: scroll, at: starts[S.step] || 0, playing: false, scrub: false };
    // drag on the ruler: the video follows; the step under the playhead becomes the selected one when it is let go
    ruler.addEventListener("pointerdown", function (e) {
      if (S.dirty && !confirmLeave()) return;
      var p = player(); if (p) p.pause();
      PH.scrub = true; ruler.setPointerCapture(e.pointerId);
      var go = function (ev) { seekGlobal(Math.max(0, Math.min(total - 1, msAt(ev.clientX)))); };
      go(e);
      var move = function (ev) { go(ev); };
      var up = function () {
        ruler.removeEventListener("pointermove", move); ruler.removeEventListener("pointerup", up); ruler.removeEventListener("pointercancel", up);
        PH.scrub = false;
        var i = 0; for (var k = 0; k < starts.length - 1; k++) if (PH.at >= starts[k]) i = k;
        if (i !== S.step) { S.dirty = false; focusStep(i); }
      };
      ruler.addEventListener("pointermove", move); ruler.addEventListener("pointerup", up); ruler.addEventListener("pointercancel", up);
    });
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
        S.ownSave = Date.now(); return fetch("/api/media-file?area=" + area + "&guide=" + encodeURIComponent(S.guideId) + "&name=" + encodeURIComponent(f.name), { method: "POST", headers: { "x-cueflow": "studio" }, body: f })
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
      if (mv.dataset.key !== key) { mv.dataset.key = key; mv.src = "/scene/" + item.name + "?lang=" + S.lang; mv.onload = function () { armPicker(mv, function (sel, el) { showPick(sel, el); }); }; }
      $("#mpick").appendChild(h("span", null, "Click an element to edit its text or delete it."));
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
    if (item.kind !== "scene") {
      var rep = h("input", { type: "file", hidden: true });
      rep.addEventListener("change", function () {
        if (!rep.files[0]) return;
        S.ownSave = Date.now(); fetch("/api/media-file?area=" + S.sel.area + "&guide=" + encodeURIComponent(S.guideId) + "&name=" + encodeURIComponent(item.name), { method: "POST", headers: { "x-cueflow": "studio" }, body: rep.files[0] })
          .then(function (r) { return r.ok ? null : r.json().then(function (d) { throw new Error(d.error); }); }).then(function () { flash("Replaced " + item.name + ". The assistant is told.", "ok"); renderMedia(); loadState(); }).catch(function (e) { flash(e.message, "err"); });
      });
      panel.appendChild(h("div", { class: "row" }, h("button", { class: "btn", onclick: function () { rep.click(); } }, "Replace with another file…"), rep,
        /\.(css|js)$/.test(item.name) ? h("button", { class: "btn", onclick: function () { editTextFile(S.sel.area, item.name); } }, "Edit the text…") : null));
    }
    if (item.kind !== "scene") panel.appendChild(h("div", { class: "row" }, h("button", { class: "btn", disabled: item.usedBy.length > 0, title: item.usedBy.length ? "A tutorial uses it: remove it from the scene first" : "", onclick: function () {
      if (!confirm("Delete " + item.name + "?")) return;
      api("/api/media-file?area=" + S.sel.area + "&guide=" + encodeURIComponent(S.guideId) + "&name=" + encodeURIComponent(item.name), { method: "DELETE" }).then(function () { S.sel = null; renderMedia(); }).catch(function (e) { flash(e.message, "err"); });
    } }, "Delete")));
    if (item.kind === "scene") {
      panel.appendChild(h("h3", { style: "margin-top:18px" }, "Elements"));
      var list = h("div", null, h("p", null, "Loading…")); panel.appendChild(list);
      api("/api/elements/" + item.name + "?lang=" + S.lang).then(function (els) {
        list.textContent = "";
        els.slice(0, 80).forEach(function (e) { list.appendChild(h("button", { class: "el", title: "Copy the selector", onclick: function () { showPick(e.selector, null); } }, h("code", null, e.selector), h("span", null, e.text || e.tag))); });
        if (!els.length) list.appendChild(h("p", null, "No targetable elements: give elements an id or a data-cue."));
      });
    } else panel.appendChild(h("p", { style: "margin-top:12px" }, S.sel.area === "media" ? "Refer to it from a screen as ../media/" + S.guideId + "/" + item.name : "Refer to it from a screen as ../shared/" + item.name));
  }
  var ATTRS = ["placeholder", "title", "alt", "aria-label", "value", "label"];
  var ownTextOf = function (el) { return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.nodeValue; }).join(" ").replace(/\s+/g, " ").trim(); };
  function showPick(sel, el) {
    var box = $("#mpick"); box.textContent = "";
    box.appendChild(h("code", { title: sel }, sel));
    box.appendChild(h("button", { class: "btn", onclick: function () { navigator.clipboard && navigator.clipboard.writeText(sel); flash("Copied " + sel, "ok"); } }, "Copy"));
    var panel = $("#media-panel");
    var old = panel.querySelector(".eledit"); if (old) old.remove();
    if (!el) { var doc = $("#mview").contentDocument; try { el = doc && doc.querySelector(sel); } catch (e) { el = null; } }
    if (!el || S.sel.kind !== "scene") return;
    panel.insertBefore(elementForm(S.sel.name, sel, el, function () {
      $("#mview").dataset.key = ""; mv2reload();
    }), panel.firstChild);
  }
  function elementForm(scene, sel, el, done) {
    var g = video(), own = ownTextOf(el);
    var f = h("div", { class: "eledit" });
    f.appendChild(h("h3", null, "Edit element"));
    var textIn = null, attrIn = {};
    if (own || !el.children.length) { textIn = h("textarea", { rows: 3, "aria-label": "Element text" }); textIn.value = own; f.appendChild(h("label", { class: "lab" }, "Text", textIn)); }
    else f.appendChild(h("p", null, "This element contains other elements. Select its text to edit it, or delete this whole element."));
    ATTRS.forEach(function (a) { if (el.hasAttribute(a)) { var i = h("input", { type: "text" }); i.value = el.getAttribute(a); attrIn[a] = i; f.appendChild(h("label", { class: "lab" }, a, i)); } });
    f.addEventListener("input", function () { S.elementDirty = true; });
    var msg = h("div", { class: "msg" }), buttons = h("div", { class: "row" });
    f.appendChild(h("p", { class: "msg" }, "Changes apply to this scene in “" + S.lang + "”. Undo restores the previous version."));
    function submit(remove) {
      var body = { scene: scene, lang: S.lang, selector: sel, tutorial: g && g.id, attrs: {}, remove: remove };
      if (!remove) {
        if (textIn && textIn.value !== own) body.text = textIn.value;
        Object.keys(attrIn).forEach(function (a) { if (attrIn[a].value !== el.getAttribute(a)) body.attrs[a] = attrIn[a].value; });
        if (body.text === undefined && !Object.keys(body.attrs).length) { msg.textContent = "Nothing changed."; return; }
      }
      buttons.querySelectorAll("button").forEach(function (button) { button.disabled = true; });
      S.ownSave = Date.now();
      api("/api/scene-edit", { method: "POST", body: body }).then(function () {
        S.elementDirty = false; S.picked = null; viewKey = ""; prevKey = "";
        done();
        return loadState().then(function () { flash(remove ? "Element deleted. Undo can restore it." : "Scene saved for “" + S.lang + "”.", "ok"); });
      }).catch(function (e) {
        msg.className = "msg err"; msg.textContent = e.message;
        buttons.querySelectorAll("button").forEach(function (button) { button.disabled = false; });
      });
    }
    buttons.appendChild(h("button", { class: "btn primary", onclick: function () { submit(false); } }, "Save element"));
    buttons.appendChild(h("button", { class: "btn", disabled: ["HTML", "HEAD", "BODY"].indexOf(el.tagName) >= 0, onclick: function () { submit(true); } }, "Delete element"));
    f.appendChild(buttons); f.appendChild(msg);
    return f;
  }
  function mv2reload() { if (S.page === "media") renderMedia(); }

  function editTextFile(area, name) {
    var url = (area === "shared" ? "/files/shared/" : "/files/media/" + S.guideId + "/") + name;
    fetch(url).then(function (r) { return r.text(); }).then(function (t) {
      dialog("Edit " + name, function (body, close) {
        body.parentNode.classList.add("big");
        var ta = h("textarea", { class: "code", spellcheck: "false" }); ta.value = t;
        var msg = h("div", { class: "msg" });
        body.appendChild(h("p", null, "Used by the screens that link it. The assistant is told which lines changed."));
        body.appendChild(ta);
        body.appendChild(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: function () {
          S.ownSave = Date.now(); fetch("/api/media-text?area=" + area + "&guide=" + encodeURIComponent(S.guideId) + "&name=" + encodeURIComponent(name), { method: "PUT", headers: { "x-cueflow": "studio" }, body: ta.value })
            .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); return d; }); })
            .then(function (d) { close(); flash(d.lines ? "Saved (" + d.lines + " line(s) changed)." : "Nothing changed.", "ok"); renderMedia(); loadState(); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
        } }, "Save"), h("button", { class: "btn", onclick: close }, "Cancel")));
        body.appendChild(msg);
      });
    });
  }
  function dashboardDialog() {
    api("/api/site").then(function (site) {
      dialog("The dashboard", function (body, close) {
        body.parentNode.classList.add("big");
        body.appendChild(h("p", null, "What the home page and each tutorial page say, in “" + S.lang + "”. Each language has its own text."));
        var pickL = function (v) { return typeof v === "string" ? v : (v && (v[S.lang] != null ? v[S.lang] : "")) || ""; };
        site.items.forEach(function (it) {
          var f = {};
          var box = h("div", { class: "item" }, h("b", null, it.id));
          [["title", "Title"], ["kicker", "Category"], ["desc", "Description"]].forEach(function (pair) {
            var el = h(pair[0] === "desc" ? "textarea" : "input", pair[0] === "desc" ? { rows: 2 } : { type: "text" });
            el.value = pickL(it[pair[0]]); f[pair[0]] = { el: el, orig: el.value };
            box.appendChild(h("label", { class: "lab" }, pair[1], el));
          });
          var msg = h("span", { class: "msg" });
          box.appendChild(h("div", { class: "row" }, h("button", { class: "btn", onclick: function () {
            var jobs = Object.keys(f).filter(function (k) { return f[k].el.value !== f[k].orig; });
            if (!jobs.length) { msg.textContent = "Nothing changed."; return; }
            Promise.all(jobs.map(function (k) { return api("/api/site-text", { method: "POST", body: { id: it.id, field: k, lang: S.lang, value: f[k].el.value } }); }))
              .then(function () { jobs.forEach(function (k) { f[k].orig = f[k].el.value; }); msg.className = "msg ok"; msg.textContent = "Saved."; loadState(); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
          } }, "Save"), msg));
          body.appendChild(box);
        });
        body.appendChild(h("div", { class: "row" }, h("button", { class: "btn", onclick: close }, "Close")));
      });
    }).catch(function (e) { flash(e.message, "err"); });
  }
  /* the counter in the header follows the notes at once, without reloading the page */
  function refreshNotes() {
    return api("/api/changes").then(function (list) {
      S.state.pending = list.length;
      var chip = $("#notes"); chip.hidden = !list.length; chip.textContent = "✎ " + list.length + " note" + (list.length === 1 ? "" : "s") + " for the assistant";
    });
  }
  function notesDialog() {
    api("/api/changes").then(function (list) {
      dialog("Edits the assistant has not read yet", function (body, close) {
        body.appendChild(h("p", null, "Your hand edits are saved. They are kept here as notes for your assistant, which reads them (get_changes), understands why you made them and takes them into account: for example a narration that still names the old button."));
        body.appendChild(h("p", null, "Delete a note when the assistant should not read it: the edit itself stays saved."));
        var box = h("div", { class: "notes" }), empty = h("p", { class: "empty" }, "None.");
        var discard = function (body2) {
          return api("/api/changes/discard", { method: "POST", body: body2 }).then(function () { if (!box.children.length) { box.replaceWith(empty); all.disabled = true; } return refreshNotes(); }).catch(function (e) { flash(e.message, "err"); });
        };
        list.forEach(function (c) {
          var row = h("div", { class: "note" }, h("span", null, c.sentence));
          row.appendChild(h("button", { class: "note-del", title: "Delete this note", "aria-label": "Delete this note", onclick: function () { row.remove(); discard({ ids: [c.id] }); } }, "×"));
          box.appendChild(row);
        });
        body.appendChild(list.length ? box : empty);
        var all = h("button", { class: "btn", onclick: function () { if (!confirm("Delete all the notes? Your edits stay saved; the assistant will not be told about them.")) return; box.textContent = ""; discard({ all: true }); } }, "Delete all");
        all.disabled = !list.length;
        body.appendChild(h("div", { class: "row" }, all, h("button", { class: "btn", onclick: close }, "Close")));
      });
    });
  }

  /* ---------- the project (brief) and the whole export ---------- */
  function projectDialog() {
    dialog("Settings", function (body, close) {
      var b = S.state.brief, f = {};
      var inp = function (k, label, val, tag) { var el = h(tag || "input", tag ? { rows: 3 } : { type: "text" }); el.value = val || ""; f[k] = el; return h("label", { class: "lab" }, label, el); };
      var audioSettings = h("section", { "aria-label": "General audio settings" }, h("h3", null, "General audio settings"));
      body.appendChild(audioSettings);
      api("/api/voices").then(function (voices) {
        audioSettings.appendChild(level(voices, { scope: "global" }, "Default voice for every tutorial", voices.current.default));
      }).catch(function (error) { voiceError(audioSettings, error); });
      // the project's narrator: its face, its background, its usual place; a video or a step can differ
      var avSection = h("section", { "aria-label": "Narrator settings" }, h("h3", null, "Narrator for every tutorial"),
        h("p", null, "A face over the picture that speaks the narration. Upload your own picture, or use the cartoon face drawn by the player; the background is used wherever the narrator has a panel. Each tutorial and each step can still differ."));
      var avMsg = h("div", { class: "msg" });
      avSection.appendChild(avatarForm(S.state.avatar || {}, {}, true, function (v) {
        api("/api/avatar", { method: "POST", body: { scope: "global", avatar: v } }).then(function (r) { S.state.avatar = r.avatar; avMsg.className = "msg ok"; avMsg.textContent = "Narrator saved: " + avatarWords(avatarMerge(AV_DEFAULTS, r.avatar)) + "."; prevKey = ""; renderStrip(); })
          .catch(function (e) { avMsg.className = "msg err"; avMsg.textContent = e.message; });
      }));
      avSection.appendChild(avMsg);
      body.appendChild(avSection);
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
      dialog("Build everything", function (body, close) {
        body.appendChild(h("p", null, "Builds every tutorial (" + S.state.guides.length + ") and the dashboard that gathers them: the home with all the videos, one page per tutorial. The files go to " + S.state.outDir + "."));
        if (external.length) body.appendChild(h("p", { class: "msg warn" }, "Audio will be generated with external voices (" + external.map(function (r) { return r.guide + "/" + r.language + ": " + r.provider; }).join(", ") + "): the narration text is sent to that service and it may cost. Texts already generated are not paid again."));
        var posters = h("input", { type: "checkbox" });
        body.appendChild(h("label", { class: "lab" }, posters, " Make a cover picture for each tutorial (needs a browser, Playwright)"));
        var result = h("div", { class: "result" });
        var go = h("button", { class: "btn primary", onclick: function () {
          go.disabled = true; progressBar(result, { percent: 0, phase: "Preparing…" });
          streamed("/api/export-all", { posters: posters.checked }, function (pr) { progressBar(result, pr); }).then(function (r) {
            result.textContent = "";
            result.appendChild(h("div", { class: "msg ok" }, "✓ " + r.guides.length + " tutorial(s) and " + r.pages + " dashboard page(s) built" + (r.siteCreated ? " (the catalog was created)" : r.siteAdded.length ? " (added to the catalog: " + r.siteAdded.join(", ") + ")" : "") + "."));
            r.warnings.forEach(function (w) { result.appendChild(h("div", { class: "msg warn" }, "! " + w)); });
            result.appendChild(h("a", { href: r.url, target: "_blank", rel: "noopener", class: "btn" }, "Open the dashboard"));
            go.disabled = false;
          }).catch(function (e) { result.textContent = ""; result.appendChild(h("div", { class: "msg err" }, e.message)); go.disabled = false; });
        } }, "Build");
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
    var final = prevKey.indexOf("final:") === 0;
    var key = (final ? "final:" : "draft:") + g.id + ":" + S.lang;
    if (prevKey !== key) { prevKey = key; fr.src = (final ? "/out/" + g.id + ".html" : "/preview/" + g.id) + "?lang=" + S.lang; }
    var external = (S.voicesTable || []).filter(function (r) { return r.guide === g.id && ["browser", "none"].indexOf(r.provider) < 0; });
    bar.appendChild(h("b", null, text(g.title, S.lang)));
    bar.appendChild(h("button", { class: "btn", onclick: function () { prevKey = "draft:" + g.id + ":" + S.lang; fr.src = "/preview/" + g.id + "?lang=" + S.lang + "&t=" + Date.now(); } }, "Play from the start (working copy, browser voice)"));
    bar.appendChild(h("button", { class: "btn", onclick: function () {
      if (external.length && !confirm("This builds the video with the external voice chosen (" + external.map(function (r) { return r.language + ": " + r.provider; }).join(", ") + "): the narration text is sent to that service and it may cost. Continue?")) return;
      flash("Building with the final voices…", "");
      api("/api/build", { method: "POST", body: { target: "guide", guide: g.id } }).then(function (r) { prevKey = "final:" + g.id + ":" + S.lang; fr.src = r.url + "?lang=" + S.lang + "&t=" + Date.now(); flash(r.silent ? "Built: no recorded audio, the browser reads it." : "Built with " + r.audioFiles + " audio file(s).", "ok"); }).catch(function (e) { flash(e.message, "err"); });
    } }, "With the final voices"));
    bar.appendChild(h("a", { class: "btn", href: "/preview/" + g.id + "?lang=" + S.lang, target: "_blank", rel: "noopener" }, "Open in a new tab"));
    bar.appendChild(h("span", { style: "color:var(--muted);font-size:12.5px" }, "Plays exactly what viewers get: scenes, camera, cursor, captions, chapters."));
    if (!S.voicesTable) api("/api/voices").then(function (v) { S.voicesTable = v.table; });
  }

  /* ---------- export ---------- */
  /* where the built files go: a folder of the project, cueflow-dist unless changed; files already built stay where they were */
  function outDirBox(p) {
    var st = S.state, msg = h("div", { class: "result" });
    var input = h("input", { type: "text", value: st.outDirShown, spellcheck: "false", style: "min-width:260px" });
    var save = function (value) {
      api("/api/out-dir", { method: "POST", body: { outDir: value } }).then(function () { return loadState(); }).then(function () { flash("The files will go to " + S.state.outDir + ".", "ok"); })
        .catch(function (e) { msg.textContent = ""; msg.appendChild(h("div", { class: "msg err" }, e.message)); });
    };
    p.appendChild(h("h3", null, "Where the files go"));
    p.appendChild(h("p", null, "A folder of the project (" + st.projectRoot + "), " + st.defaultOutDirShown + " unless you choose another. It is where the videos and the site are written, ready to publish."));
    p.appendChild(h("div", { class: "row" }, input,
      h("button", { class: "btn", onclick: function () { save(input.value); } }, "Save"),
      st.outDirShown === st.defaultOutDirShown ? null : h("button", { class: "btn", onclick: function () { save(""); } }, "Back to " + st.defaultOutDirShown)));
    p.appendChild(h("p", { style: "color:var(--muted);font-size:12.5px" }, "Full path: " + st.outDir + ". Files built before stay in the old folder."));
    p.appendChild(msg);
  }

  function renderExport() {
    var body = $("#export-body"); body.textContent = "";
    if (!video()) { body.appendChild(h("p", { class: "empty" }, "Select or create a tutorial.")); return; }
    body.appendChild(h("h3", null, "Export “" + text(video().title, S.lang) + "”"));
    outDirBox(body);
    var holder = h("div"); body.appendChild(holder);
    checkTab(holder);
  }

  /* ---------- written guides: a text editor, not a timeline ---------- */
  /*
   * A written guide is an article in pages/: <section id data-title> blocks with an h2 and h3[id] subheadings,
   * optionally an opening before the first section. It is edited one section at a time, in a frame that carries the
   * docs site's stylesheet and the kit's theme, so it looks as it will be read. Saving writes the whole file back.
   */
  var D = { id: null, page: "write", src: null, parts: null, sel: 0, dirty: false, html: false, frameLang: null };
  var catalog = function () { return S.state && S.state.catalog && S.state.catalog.exists ? S.state.catalog : null; };
  var docItem = function () { var c = catalog(); return c && c.items.filter(function (i) { return i.id === D.id; })[0]; };
  var hasArticle = function (it) { return it.status === "guide" || Object.keys(it.files).some(function (l) { return it.files[l]; }); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  /* the article, as parts: an opening (what comes before the first section) and the sections */
  function parseArticle(html) {
    var box = document.createElement("div"); box.innerHTML = html;
    var opening = [], sections = [];
    Array.prototype.forEach.call(box.childNodes, function (n) {
      if (n.nodeType === 1 && n.tagName === "SECTION" && n.id) {
        var attrs = {};
        Array.prototype.forEach.call(n.attributes, function (a) { if (a.name !== "id" && a.name !== "data-title") attrs[a.name] = a.value; });
        sections.push({ id: n.id, dataTitle: n.getAttribute("data-title"), attrs: attrs, html: n.innerHTML.replace(/^\s+|\s+$/g, "") });
      } else if (!sections.length) opening.push(n.nodeType === 1 ? n.outerHTML : n.textContent);
    });
    if (!sections.length && box.innerHTML.trim()) return { opening: null, sections: [{ id: "article", dataTitle: null, attrs: {}, html: box.innerHTML.trim() }] };
    var op = opening.join("").trim();
    return { opening: op ? op : null, sections: sections };
  }
  /* the h2 of a section, and the title a reader sees for it (a numbered h2 keeps its "N · " in the index) */
  function sectionTitle(s) {
    var box = document.createElement("div"); box.innerHTML = s.html;
    var h2 = box.querySelector("h2");
    if (!h2) return s.dataTitle || s.id;
    var num = h2.querySelector(".num"), words = h2.textContent.replace(num ? num.textContent : "", "").trim();
    return num ? num.textContent.trim() + " · " + words : words;
  }
  function serialize(parts) {
    var used = {};
    var out = parts.opening ? [parts.opening, ""] : [];
    // numbered sections (an h2 with a .num) are renumbered in their order, so a move keeps 1, 2, 3
    var n = 0;
    parts.sections.forEach(function (s) {
      var box = document.createElement("div"); box.innerHTML = s.html;
      var num = box.querySelector("h2 .num");
      if (num) num.textContent = String(++n);
      // every subheading needs an id: the side index of the site links to it
      Array.prototype.forEach.call(box.querySelectorAll("h3"), function (h3) {
        var id = h3.id || (s.id + "-" + slug(h3.textContent || "part"));
        var base = id, k = 2; while (used[id]) id = base + "-" + k++;
        used[id] = 1; h3.id = id;
      });
      s.html = box.innerHTML.trim();
      var attrs = Object.keys(s.attrs).map(function (k) { return " " + k + '="' + esc(s.attrs[k]) + '"'; }).join("");
      out.push('<section id="' + esc(s.id) + '" data-title="' + esc(sectionTitle(s)) + '"' + attrs + ">\n" + s.html + "\n</section>", "");
    });
    return out.join("\n");
  }

  function selectDoc(id) {
    if (!confirmLeave()) return;
    S.kind = "doc"; D.id = id; D.sel = 0; D.html = false;
    document.body.classList.add("doc-mode");
    var it = docItem();
    if (it && !hasArticle(it)) D.page = "details";
    loadDoc().then(renderDocAll);
  }
  function leaveDocMode() { S.kind = "video"; D.id = null; document.body.classList.remove("doc-mode"); }
  function loadDoc() {
    var c = catalog();
    if (!c || !D.id) return Promise.resolve();
    if (!S.lang || c.languages.indexOf(S.lang) < 0) S.lang = c.lang;
    return api("/api/article/" + D.id + "?lang=" + S.lang).then(function (r) {
      D.src = r; D.parts = parseArticle(r.html); D.dirty = false;
      if (D.sel >= D.parts.sections.length + (D.parts.opening ? 1 : 0)) D.sel = 0;
    });
  }
  function renderDocAll() {
    var it = docItem();
    $("#current").textContent = it ? text(it.title, S.lang) : "";
    document.querySelectorAll(".docbar button").forEach(function (b) { b.className = b.getAttribute("data-docpage") === D.page ? "on" : ""; });
    $("#doc-write").hidden = D.page !== "write"; $("#doc-details").hidden = D.page !== "details"; $("#doc-preview").hidden = D.page !== "preview";
    renderFilm();
    if (D.page === "write") renderWrite(); else if (D.page === "details") renderDetails(); else renderDocPreview();
  }
  function showDocPage(name) {
    if (name === D.page) return;
    pullEditor();
    D.page = name; renderDocAll();
  }

  /* --- write --- */
  // index of the selected part: with an opening, 0 is the opening and sections start at 1
  var selSection = function () { return D.parts.opening != null ? D.sel - 1 : D.sel; };
  function renderOutline() {
    var nav = $("#doc-outline"); nav.textContent = "";
    nav.appendChild(h("h4", null, "Sections"));
    if (D.parts.opening != null) nav.appendChild(h("div", { class: "osec" + (D.sel === 0 ? " on" : ""), onclick: function () { pickPart(0); } }, h("span", { class: "grip" }, " "), h("span", { class: "t" }, "Opening", h("small", null, "before the first section"))));
    var off = D.parts.opening != null ? 1 : 0;
    D.parts.sections.forEach(function (s, i) {
      var row = h("div", { class: "osec" + (D.sel === i + off ? " on" : ""), draggable: "true", onclick: function () { pickPart(i + off); } },
        h("span", { class: "grip", title: "Drag to move" }, "⋮⋮"), h("span", { class: "t" }, sectionTitle(s) || s.id),
        h("button", { class: "x", title: "Delete this section", "aria-label": "Delete this section", onclick: function (e) { e.stopPropagation(); deleteSection(i); } }, "×"));
      row.addEventListener("dragstart", function (e) { pullEditor(); D.drag = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); });
      row.addEventListener("dragover", function (e) { if (D.drag == null) return; e.preventDefault(); row.classList.add("drop-before"); });
      row.addEventListener("dragleave", function () { row.classList.remove("drop-before"); });
      row.addEventListener("drop", function (e) { e.preventDefault(); row.classList.remove("drop-before"); moveSection(D.drag, i); D.drag = null; });
      nav.appendChild(row);
    });
    var end = h("div", { class: "oend" }); // drop here to move a section to the end
    end.addEventListener("dragover", function (e) { if (D.drag == null) return; e.preventDefault(); end.classList.add("drop-before"); });
    end.addEventListener("dragleave", function () { end.classList.remove("drop-before"); });
    end.addEventListener("drop", function (e) { e.preventDefault(); end.classList.remove("drop-before"); moveSection(D.drag, D.parts.sections.length); D.drag = null; });
    nav.appendChild(end);
    nav.appendChild(h("div", { class: "side-actions" },
      h("button", { class: "btn", onclick: addSection }, "+ Section"),
      D.parts.opening == null ? h("button", { class: "btn", title: "A short introduction before the first section", onclick: function () { pullEditor(); D.parts.opening = "<p></p>"; D.sel = 0; markDirty(); renderWrite(); } }, "+ Opening") : null));
  }
  function pickPart(i) { pullEditor(); D.sel = i; renderWrite(); }
  function addSection() {
    var title = prompt("Title of the new section:");
    if (title === null || !title.trim()) return;
    pullEditor();
    var ids = D.parts.sections.map(function (s) { return s.id; }), id = slug(title) || "section", base = id, k = 2;
    while (ids.indexOf(id) >= 0) id = base + "-" + k++;
    var numbered = D.parts.sections.some(function (s) { return /<h2[^>]*>\s*<span class="num">/.test(s.html); });
    var at = Math.max(0, selSection() + 1);
    D.parts.sections.splice(at, 0, { id: id, dataTitle: null, attrs: {}, html: "<h2>" + (numbered ? '<span class="num">0</span> ' : "") + esc(title.trim()) + "</h2>\n<p></p>" });
    D.parts.sections = parseArticle(serialize(D.parts)).sections; // numbered sections get their number at once
    D.sel = at + (D.parts.opening != null ? 1 : 0);
    markDirty(); renderWrite();
  }
  function deleteSection(i) {
    pullEditor();
    if (!confirm("Delete the section “" + sectionTitle(D.parts.sections[i]) + "”? It leaves the guide when you save.")) return;
    D.parts.sections.splice(i, 1);
    D.sel = Math.max(0, Math.min(D.sel, D.parts.sections.length - 1 + (D.parts.opening != null ? 1 : 0)));
    markDirty(); renderWrite();
  }
  function moveSection(from, before) {
    if (from == null) return;
    var to = before > from ? before - 1 : before;
    if (to === from) return;
    var s = D.parts.sections.splice(from, 1)[0]; D.parts.sections.splice(to, 0, s);
    D.sel = to + (D.parts.opening != null ? 1 : 0);
    var fresh = parseArticle(serialize(D.parts)); D.parts.sections = fresh.sections; // renumbers at once, so the outline shows it
    markDirty(); renderWrite();
  }
  function markDirty() { D.dirty = true; var st = $("#doc-tools .state"); if (st) { st.textContent = "Unsaved changes"; st.className = "state dirty"; } }

  var docFrame = $("#doc-frame");
  function frameDoc() { try { return docFrame.contentDocument; } catch (e) { return null; } }
  /* what the editor shows goes back into the parts (before switching section, page or saving) */
  function pullEditor() {
    if (!D.parts || D.page !== "write") return;
    var html;
    if (D.html) { var ta = $("#doc-paper textarea"); if (!ta) return; html = ta.value; }
    else { var d = frameDoc(), box = d && d.getElementById("doc"); if (!box || !box.firstChild || box.dataset.part !== String(D.sel)) return; html = box.firstChild.innerHTML; }
    html = html.replace(/^\s+|\s+$/g, "");
    if (D.parts.opening != null && D.sel === 0) D.parts.opening = html;
    else if (D.parts.sections[selSection()]) D.parts.sections[selSection()].html = html;
  }
  function currentPartHtml() { return D.parts.opening != null && D.sel === 0 ? D.parts.opening : (D.parts.sections[selSection()] || { html: "" }).html; }

  function renderWrite() {
    var it = docItem(), c = catalog(), paper = $("#doc-paper");
    renderTools();
    $("#doc-outline").textContent = "";
    if (!it) { paper.textContent = ""; paper.appendChild(h("div", { class: "notice" }, "Select a written guide.")); return; }
    if (!D.src.exists) {
      paper.textContent = "";
      var box = h("div", { class: "notice" });
      if (S.lang !== c.lang && it.files[c.lang]) {
        box.appendChild(h("p", null, "There is no “" + S.lang + "” version of this guide yet: readers in “" + S.lang + "” see the “" + c.lang + "” text."));
        box.appendChild(h("button", { class: "btn primary", onclick: function () {
          api("/api/article-translate/" + D.id + "?lang=" + S.lang, { method: "POST" }).then(function (r) { D.src = r; D.parts = parseArticle(r.html); D.sel = 0; return loadState(); }).then(function () { flash("A copy of the “" + c.lang + "” text to translate, section by section.", "ok"); }).catch(function (e) { flash(e.message, "err"); });
        } }, "Start the “" + S.lang + "” version from the “" + c.lang + "” text"));
      } else {
        box.appendChild(h("p", null, "This item has no written guide yet."));
        box.appendChild(h("button", { class: "btn primary", onclick: function () { D.parts = { opening: null, sections: [] }; D.src.exists = true; addSection(); } }, "Start writing"));
      }
      paper.appendChild(box);
      return;
    }
    renderOutline();
    if (D.html) {
      paper.textContent = "";
      var ta = h("textarea", { spellcheck: "false", "aria-label": "HTML of this section" }); ta.value = currentPartHtml();
      ta.addEventListener("input", markDirty);
      paper.appendChild(ta);
      return;
    }
    if (!paper.contains(docFrame)) { paper.textContent = ""; paper.appendChild(docFrame); }
    var fill = function () {
      var d = frameDoc(), box = d && d.getElementById("doc");
      if (!box) return;
      box.textContent = "";
      var part = d.createElement(D.parts.opening != null && D.sel === 0 ? "div" : "section");
      part.className = "cf-section";
      part.innerHTML = currentPartHtml();
      part.contentEditable = "true";
      box.dataset.part = String(D.sel);
      box.appendChild(part);
      if (!d.__cfWired) {
        d.__cfWired = true;
        try { d.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) { /* older engines */ }
        d.addEventListener("input", function () { markDirty(); if (d.activeElement && d.activeElement.closest && d.querySelector("h2")) refreshOutlineTitle(); });
        d.addEventListener("keydown", function (e) { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveDoc(); } });
        d.addEventListener("selectionchange", paintTools);
      }
      part.focus();
    };
    if (D.frameLang !== S.lang || !frameDoc() || !frameDoc().getElementById("doc")) { D.frameLang = S.lang; docFrame.onload = fill; docFrame.src = "/article-frame?lang=" + encodeURIComponent(S.lang); }
    else fill();
  }
  function refreshOutlineTitle() {
    var d = frameDoc(), part = d && d.getElementById("doc").firstChild;
    var i = selSection(); if (!part || i < 0 || !D.parts.sections[i]) return;
    var t = sectionTitle({ html: part.innerHTML, id: D.parts.sections[i].id });
    var row = $("#doc-outline").querySelectorAll(".osec")[D.sel];
    if (row && row.querySelector(".t")) row.querySelector(".t").textContent = t;
  }

  /* the toolbar: text tools only */
  var TOOLS = [
    ["undo", "↶", "Undo"], ["redo", "↷", "Redo"], null,
    ["p", "¶", "Paragraph"], ["h3", "H3", "Subheading (listed in the side index)"], ["quote", "❝", "Quote"], null,
    ["bold", "B", "Bold"], ["italic", "I", "Italic"], null,
    ["ul", "•", "Bulleted list"], ["ol", "1.", "Numbered list"], null,
    ["link", "🔗", "Link"], ["image", "🖼", "Image"], ["clear", "⌫", "Clear formatting"]
  ];
  function renderTools() {
    var bar = $("#doc-tools"); bar.textContent = "";
    if (!docItem() || !D.src || !D.src.exists) return;
    TOOLS.forEach(function (t) {
      if (!t) { bar.appendChild(h("span", { class: "sep" })); return; }
      var b = h("button", { title: t[2], "aria-label": t[2], "data-cmd": t[0], disabled: D.html, onmousedown: function (e) { e.preventDefault(); }, onclick: function () { command(t[0]); } }, t[1]);
      if (t[0] === "bold") b.style.fontWeight = "700"; if (t[0] === "italic") b.style.fontStyle = "italic";
      bar.appendChild(b);
    });
    bar.appendChild(h("span", { class: "sep" }));
    bar.appendChild(h("button", { class: D.html ? "on" : "", title: "Edit the HTML of this section (for blocks the toolbar does not make)", onclick: function () { pullEditor(); D.html = !D.html; renderWrite(); } }, "</>"));
    bar.appendChild(h("span", { class: "grow" }));
    bar.appendChild(h("span", { class: "state" + (D.dirty ? " dirty" : "") }, D.dirty ? "Unsaved changes" : "Saved"));
    bar.appendChild(h("button", { class: "btn", title: "Throw away what is not saved", onclick: function () { if (!D.dirty || confirm("Discard the changes not saved?")) loadDoc().then(renderDocAll); } }, "Discard"));
    bar.appendChild(h("button", { class: "btn primary", title: "Save (Ctrl+S)", onclick: saveDoc }, "Save"));
  }
  function paintTools() {
    var d = frameDoc(); if (!d) return;
    ["bold", "italic"].forEach(function (c) { var b = $('#doc-tools [data-cmd="' + c + '"]'); if (b) b.classList.toggle("on", !!d.queryCommandState(c)); });
  }
  function command(c) {
    var d = frameDoc(); if (!d) return;
    var run = function (name, arg) { d.execCommand(name, false, arg); markDirty(); refreshOutlineTitle(); };
    if (c === "undo" || c === "redo" || c === "bold" || c === "italic") run(c);
    else if (c === "p") run("formatBlock", "<p>");
    else if (c === "h3") run("formatBlock", "<h3>");
    else if (c === "quote") run("formatBlock", "<blockquote>");
    else if (c === "ul") run("insertUnorderedList");
    else if (c === "ol") run("insertOrderedList");
    else if (c === "clear") run("removeFormat");
    else if (c === "link") { var u = prompt("Address of the link (https://…, or #section-id for a part of this guide):"); if (u) run("createLink", u); }
    else if (c === "image") {
      var input = h("input", { type: "file", accept: "image/*" });
      input.addEventListener("change", function () {
        var f = input.files[0]; if (!f) return;
        S.ownSave = Date.now();
        fetch("/api/article-image?name=" + encodeURIComponent(f.name), { method: "POST", headers: { "x-cueflow": "studio" }, body: f })
          .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
          .then(function (j) { var c2 = catalog(); d.body.focus(); run("insertImage", (S.lang === c2.lang ? "" : "../") + j.path); })
          .catch(function (e) { flash(e.message, "err"); });
      });
      input.click();
    }
    paintTools();
  }
  function saveDoc() {
    pullEditor();
    var html = serialize(D.parts);
    return api("/api/article/" + D.id + "?lang=" + S.lang, { method: "PUT", body: { html: html, version: D.src.version } }).then(function (r) {
      D.src.version = r.version; D.src.html = html; D.dirty = false; D.parts = parseArticle(html);
      flash("Saved in " + r.file + ".", "ok");
      return loadState();
    }).catch(function (e) { flash(e.message, "err"); });
  }

  /* --- details: what the dashboard says about the guide --- */
  function renderDetails() {
    var body = $("#doc-details-body"); body.textContent = "";
    var it = docItem(), c = catalog();
    if (!it) { body.appendChild(h("p", { class: "empty" }, "Select a written guide.")); return; }
    body.appendChild(h("h3", null, "On the dashboard, in “" + S.lang + "”"));
    body.appendChild(h("p", { style: "color:var(--muted)" }, "How the guide is presented on the home page and in its preview. The other languages keep their own texts."));
    var f = {};
    var field = function (k, label, hint, val, area) { var el = h(area ? "textarea" : "input", area ? { rows: area } : { type: "text" }); el.value = val || ""; f[k] = el; return h("label", { class: "lab" + (area ? " full" : "") }, label, hint ? h("span", { class: "hint" }, hint) : null, el); };
    var contents = it.contents ? (Array.isArray(it.contents) ? it.contents : it.contents[S.lang] || it.contents[c.lang] || []) : [];
    var row = h("select", null, c.rows.map(function (r) { return h("option", { value: r.id, selected: r.id === it.row }, text(r.title, S.lang) + " (" + r.id + ")"); }));
    var status = h("select", { disabled: it.status === "video" },
      it.status === "video" ? h("option", { value: "video", selected: true }, "Video with its written guide") : null,
      h("option", { value: "guide", selected: it.status === "guide" }, "Written guide (published)"),
      h("option", { value: "soon", selected: it.status === "soon" }, "Coming soon (announced, no page yet)"));
    body.appendChild(h("div", { class: "fieldgrid" },
      field("title", "Title", null, text(it.title, S.lang)),
      field("kicker", "Kicker", "a short category above the title", text(it.kicker, S.lang)),
      field("desc", "Description", "one or two sentences: what the reader learns", text(it.desc, S.lang), 3),
      field("contents", "What it contains", "one line each, listed in the preview of the home page", contents.join("\n"), 4),
      it.status === "video" ? field("duration", "Duration", "as people read it, e.g. about 1 min", text(it.duration, S.lang)) : null,
      h("label", { class: "lab" }, "Row of the home page", row),
      h("label", { class: "lab" }, "Status", status)));
    var msg = h("div", { class: "msg" });
    body.appendChild(h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: function () {
        var texts = { title: f.title.value.trim(), kicker: f.kicker.value.trim(), desc: f.desc.value.trim() };
        if (f.duration) texts.duration = f.duration.value.trim();
        if (!texts.title) { msg.className = "msg err"; msg.textContent = "The title cannot be empty."; return; }
        var patch = { lang: S.lang, texts: texts, contents: f.contents.value.split("\n"), row: row.value };
        if (it.status !== "video") patch.status = status.value;
        api("/api/item/" + it.id, { method: "POST", body: patch }).then(function () { return loadState(); }).then(function () { flash("Saved.", "ok"); renderDocAll(); }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
      } }, "Save"),
      h("button", { class: "btn", title: "Earlier in its row", onclick: function () { moveItem(-1); } }, "← Earlier in its row"),
      h("button", { class: "btn", title: "Later in its row", onclick: function () { moveItem(1); } }, "Later in its row →")));
    body.appendChild(msg);
    if (it.status !== "video") {
      body.appendChild(h("div", { class: "danger-zone" },
        h("p", null, "Taking the guide off the dashboard moves its text (every language) to the trash folder of the kit: nothing is erased."),
        h("button", { class: "btn danger", onclick: function () { deleteItemDialog(it); } }, "Delete this guide")));
    }
  }
  function moveItem(dir) { api("/api/item/" + D.id, { method: "POST", body: { move: dir } }).then(function () { return loadState(); }).then(function () { flash(dir < 0 ? "Moved earlier." : "Moved later.", "ok"); }).catch(function (e) { flash(e.message, "err"); }); }
  function deleteItemDialog(it) {
    dialog("Delete “" + text(it.title, S.lang) + "”?", function (body, close) {
      body.appendChild(h("p", null, it.status === "soon" ? "It leaves the “coming soon” list of the dashboard." : "It leaves the dashboard, and its text in every language moves to the trash folder of the kit (trash/). You can put it back from there."));
      var msg = h("div", { class: "msg" });
      body.appendChild(h("div", { class: "row" },
        h("button", { class: "btn danger", onclick: function () {
          api("/api/item/" + it.id, { method: "DELETE" }).then(function (r) {
            close();
            if (D.id === it.id) { leaveDocMode(); }
            return loadState().then(function () { flash(r.trash ? "Moved to " + r.trash + "." : "Removed from the dashboard.", "ok"); });
          }).catch(function (e) { msg.className = "msg err"; msg.textContent = e.message; });
        } }, "Delete"), h("button", { class: "btn", onclick: close }, "Cancel")));
      body.appendChild(msg);
    });
  }

  /* --- preview: the whole guide, read-only, as it will be read --- */
  function renderDocPreview() {
    var bar = $("#doc-prev-bar"), fr = $("#doc-prev"), it = docItem();
    bar.textContent = "";
    if (!it) return;
    bar.appendChild(h("b", null, text(it.title, S.lang)));
    bar.appendChild(h("span", { class: "hint" }, D.dirty ? "Shows your unsaved changes too." : "The guide as readers will see it, in “" + S.lang + "”."));
    bar.appendChild(h("a", { class: "btn", href: "/out/site/" + it.id + "/index.html", target: "_blank", rel: "noopener", title: "The page as last built (Build)" }, "Open the built page"));
    var html = D.parts ? serialize(JSON.parse(JSON.stringify(D.parts))) : "";
    fr.onload = function () {
      var d = fr.contentDocument, box = d && d.getElementById("doc"); if (!box) return;
      box.innerHTML = "<h1>" + esc(text(it.title, S.lang)) + "</h1>" + (D.src && D.src.exists ? html : "<p>There is no text in “" + esc(S.lang) + "” yet.</p>");
    };
    fr.src = "/article-frame?lang=" + encodeURIComponent(S.lang) + "&t=" + Date.now();
  }

  function startWriting(it) {
    api("/api/item/" + it.id, { method: "POST", body: { lang: S.lang, status: "guide" } }).then(function () { return loadState(); }).then(function () { D.page = "write"; selectDoc(it.id); }).catch(function (e) { flash(e.message, "err"); });
  }

  /* ---------- wiring ---------- */
  (function () {
    var film = $("#film");
    film.addEventListener("dragover", function (e) {
      if (!S.dragItem) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      var t = dropTarget(e), line = film.querySelector(".filmline"); if (!line) return;
      var y = t.before ? t.before.offsetTop - 6 : (t.prev ? t.prev.offsetTop + t.prev.offsetHeight + 4 : 56);
      line.hidden = false; line.style.top = y + "px";
    });
    film.addEventListener("drop", function (e) { if (!S.dragItem) return; e.preventDefault(); moveOnDashboard(e); });
  })();
  document.querySelectorAll(".docbar button").forEach(function (b) { b.addEventListener("click", function () { showDocPage(b.getAttribute("data-docpage")); }); });
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { S.tab = b.getAttribute("data-tab"); renderPanel(); }); });
  $("#ai").addEventListener("click", aiDialog);
  $("#welcome-copy").addEventListener("click", function () { copyText(S.welcomePrompt || "", "Prompt copied. Paste it in your assistant.", $("#welcome-prompt")); });
  $("#welcome-new").addEventListener("click", function () { newDialog(); });
  $("#project").addEventListener("click", projectDialog);
  $("#dashboard").addEventListener("click", dashboardDialog);
  $("#notes").addEventListener("click", notesDialog);
  // a newer Cueflow on npm: proposed, never installed by itself
  api("/api/update").then(function (r) {
    var u = r.update; if (!u) return;
    var chip = $("#update"); chip.hidden = false; chip.textContent = "⬆ " + u.latest + " available";
    chip.addEventListener("click", function () {
      dialog("A newer Cueflow is available", function (body, close) {
        body.appendChild(h("p", null, "You have " + u.current + "; the latest is " + u.latest + ". To update, close Studio (Ctrl+C in the terminal), run this, and start Studio again:"));
        var pre = h("pre", { class: "prompt" }, u.command); body.appendChild(pre);
        body.appendChild(h("div", { class: "row" }, h("button", { class: "btn primary", onclick: function () { copyText(u.command, "Copied.", pre); } }, "Copy the command"), h("button", { class: "btn", onclick: close }, "Close")));
        body.appendChild(h("p", { class: "msg" }, "Cueflow asks npm once a day which version is the latest (nothing about you or your project is sent). To switch it off: CUEFLOW_NO_UPDATE_CHECK=1."));
      });
    });
  }).catch(function () {});
  $("#exportall").addEventListener("click", exportAll);
  document.querySelectorAll(".videobar button").forEach(function (b) { b.addEventListener("click", function () { showPage(b.getAttribute("data-page")); }); });
  $("#theme").addEventListener("click", function () {
    var next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("cueflow-studio-theme", next); } catch (e) { /* private window */ }
  });
  $("#m-video").addEventListener("click", function () { setMode("video"); });
  $("#m-pick").addEventListener("click", function () { setMode("pick"); });
  $("#lang").addEventListener("change", function (e) {
    if (S.kind === "doc") {
      if (!confirmLeave()) { e.target.value = S.lang; return; }
      S.lang = e.target.value; D.sel = 0; D.html = false;
      loadDoc().then(renderDocAll);
      return;
    }
    if (S.elementDirty && !confirmLeave()) { e.target.value = S.lang; return; }
    S.elementDirty = false; S.picked = null;
    S.lang = e.target.value; S.msg = null; viewKey = ""; $("#mview").dataset.key = ""; renderSide(); renderView(false); renderPanel(); renderStrip(); renderPage(); });
  // One open stream per tab would use up the browser's six connections to this address as tabs pile up, and every
  // request (the built site, the previews) would wait forever without an error: only the tab being looked at listens.
  var events = null;
  function onKitChanged() {
    // someone else changed the kit (an assistant, an editor); the file watcher also reports our own saves, which we skip
    if (S.ownSave && Date.now() - S.ownSave < 2500) return;
    if (S.kind === "doc") pullEditor();
    if (S.dirty || S.elementDirty || (S.kind === "doc" && D.dirty)) { var b = $("#banner"); b.hidden = false; b.className = "banner"; b.textContent = "The kit changed on disk. Save or discard your edit, then reload this page."; return; }
    loadState().then(function () { viewKey = ""; prevKey = ""; renderView(true); flash("The kit changed: updated.", "ok"); });
  };
  function listen() {
    if (events) return;
    events = new EventSource("/events");
    events.onmessage = onKitChanged;
    events.addEventListener("agent", function () { refreshAgent(); });
  }
  var hiddenAt = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { hiddenAt = Date.now(); if (events) { events.close(); events = null; } return; }
    listen();
    // what changed while this tab was not listening
    if (hiddenAt && !S.dirty && !S.elementDirty && S.kind !== "doc") loadState().then(function () { viewKey = ""; prevKey = ""; renderView(true); refreshAgent(); }).catch(function () {});
    hiddenAt = 0;
  });
  if (!document.hidden) listen();
  loadState().then(refreshAgent).catch(function (e) { document.body.textContent = "Studio could not load: " + e.message; });
})();
