/* Cueflow docs site: home and item pages drawn from window.CUEFLOW_SITE (written by `cueflow site`).
 * Plain browser JS, shipped next to the player in assets/cueflow.js. Every class starts with cf-, every word comes
 * from LABELS (overridable from site.json "labels"), every color from the --cf-site-* variables of the theme. */
(function () {
  "use strict";
  var S = window.CUEFLOW_SITE;
  if (!S) return;
  var root = S.root || "", body = document.body;

  /* one language for the whole site: the one chosen here before, else the browser's, else the fallback */
  var LANG_KEY = "cueflow-docs-lang";
  var offered = S.catalog.languages && S.catalog.languages.length ? S.catalog.languages : [S.catalog.lang || "en"];
  var fallback = S.catalog.fallback || offered[0];
  function chooseLang() {
    var stored = null;
    try { stored = localStorage.getItem(LANG_KEY); } catch (e) { /* storage unavailable */ }
    if (stored && offered.indexOf(stored) >= 0) return stored;
    var wanted = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""]);
    for (var i = 0; i < wanted.length; i++) {
      var w = String(wanted[i]).toLowerCase();
      for (var j = 0; j < offered.length; j++) if (offered[j].toLowerCase() === w) return offered[j];
      for (j = 0; j < offered.length; j++) if (offered[j].toLowerCase().split("-")[0] === w.split("-")[0]) return offered[j];
    }
    return fallback;
  }
  var lang = chooseLang();
  document.documentElement.lang = lang;
  function P(v) { return v == null || typeof v !== "object" || Array.isArray(v) ? v : v[lang] != null ? v[lang] : v[fallback] != null ? v[fallback] : v[Object.keys(v)[0]]; }

  /* the catalog in the chosen language: from here on every text is a plain string */
  var src = S.catalog;
  var cat = {
    title: P(src.title), lang: src.lang, brand: { name: P(src.brand && src.brand.name) || P(src.title), logo: src.brand && src.brand.logo, url: src.brand && src.brand.url },
    footer: P(src.footer), requestEndpoint: src.requestEndpoint, featured: src.featured, quickAccess: src.quickAccess,
    labels: (src.labels && src.labels[lang]) || {},
    rows: src.rows.map(function (r) { return { id: r.id, title: P(r.title), note: P(r.note), kicker: P(r.kicker), lede: P(r.lede), band: r.band, askTile: r.askTile }; }),
    items: src.items.map(function (it) {
      return { id: it.id, row: it.row, status: it.status, slides: it.format === "slides", title: P(it.title), kicker: P(it.kicker), desc: P(it.desc), duration: P(it.duration),
        contents: P(it.contents) || [], chapters: (it.chapters || []).map(P), href: it.href, poster: P(it.poster), icon: it.icon };
    })
  };

  var LABELS = {
    en: {
      home: "Home", tutorials: "Tutorials", index: "Index of this guide", request: "Request a tutorial", pdf: "Create PDF",
      available: "{n} available", coming: "{n} coming", allTutorials: "All tutorials →", requestLink: "Request a tutorial →",
      tagVideo: "Video", tagGuide: "Guide", tagSoon: "Coming soon", ctaVideo: "Watch the video →", ctaGuide: "Read the guide →",
      tagSlides: "Slides", ctaSlides: "Start the presentation →", subSlides: "Presentation", present: "Start the presentation", chipByHand: "Advanced by hand", slidesZone: "Slides",
      subVideo: "Video and guide", subGuide: "Guide · video to come", subSoon: "In preparation",
      watch: "Watch the video", readTranscript: "Read the transcript", transcript: "Transcript", guide: "Guide", readGuide: "Read the guide",
      chipVoice: "Voice and captions", chipRead: "Guide to read", chipPdf: "PDF", featured: "Featured", quick: "Quick access",
      soonKicker: "Coming next", soonLede: "The next videos in preparation. If the one you need is not here, you can ask for it.", soonLedePlain: "The next videos in preparation.",
      availableTitle: "Available", askTitle: "Missing something?", askSub: "Suggest a topic", back: "Back", forward: "Forward",
      askKicker: "Missing something?", askHeading: "Request a tutorial",
      askLede: "Something is not clear, or the video you need is missing? Write the topic: requests help choose the next tutorials.",
      topic: "Topic", topicPh: "e.g. how to upload the documents of a case", messagePh: "Where you got stuck, or the question you have.", message: "What is not clear", optional: "(optional)",
      name: "Name", email: "Email", askNote: "Name and email are only used to answer you.", send: "Send the request", sending: "Sending…", close: "Close",
      errTopic: "Write the topic of the tutorial (a few words at least).", errEmail: "The email address does not look valid. It can also be left empty.",
      errFile: "Opened as a file from your computer, the guide cannot send requests: open it from a web address.",
      ok: "Request sent. Thank you: it goes straight to the people who make the tutorials.", err429: "Too many requests in a short time. Try again in a few minutes.",
      err422: "Some fields are not valid: check the topic and the email.", errGeneric: "Sending failed because of a technical problem. Try again shortly.",
      errNetwork: "The server does not answer: the request was not sent. Try again shortly.",
      search: "Search this guide…", video: "Video", deep: "In depth", downloadTranscript: "Download the transcript (.txt)",
      printTitle: "Print to PDF", selectAll: "Select all", selectNone: "Select none", howItWorks: "How it works",
      printHint: "Only the checked sections are included. With more than one section, the first page of the PDF is an index. In Chrome, enable \"Background graphics\" in the print dialog to keep the colors.",
      printOne: "Print this section only", include: "Include in the PDF", next: "Next", previous: "Previous",
      deepTitle: "The full guide", deepLede: "Everything the video shows, in detail: section by section, each one printable on its own.",
      transcriptTitle: "Video transcript", transcriptSub: "the narration, step by step", contents: "Contents", docsOf: "{title} · documentation",
      language: "Language", goTo: "Go to {title}", articleIn: "This guide is not translated yet: here it is in {lang}.", videoIn: "This video is not available in your language yet: it plays in {lang}."
    },
    it: {
      home: "Home della guida", tutorials: "Tutorial", index: "Indice della guida", request: "Richiedi un tutorial", pdf: "Genera PDF",
      available: "{n} disponibili", coming: "{n} in arrivo", allTutorials: "Tutta la guida →", requestLink: "Richiedi un tutorial →",
      tagVideo: "Video", tagGuide: "Guida", tagSoon: "In arrivo", ctaVideo: "Guarda il video →", ctaGuide: "Leggi la guida →",
      tagSlides: "Presentazione", ctaSlides: "Avvia la presentazione →", subSlides: "Presentazione", present: "Avvia la presentazione", chipByHand: "Si avanza a mano", slidesZone: "Slide",
      subVideo: "Video e guida", subGuide: "Guida · video in arrivo", subSoon: "In preparazione",
      watch: "Guarda il video", readTranscript: "Leggi la trascrizione", transcript: "Trascrizione", guide: "Guida", readGuide: "Leggi la guida",
      chipVoice: "Voce e sottotitoli", chipRead: "Guida da leggere", chipPdf: "PDF", featured: "In evidenza", quick: "Accesso rapido",
      soonKicker: "Prossimamente", soonLede: "I prossimi video in preparazione. Se ne serve uno che non c'è, si può chiedere.", soonLedePlain: "I prossimi video in preparazione.",
      availableTitle: "Disponibili", askTitle: "Manca qualcosa?", askSub: "Segnala l'argomento", back: "Indietro", forward: "Avanti",
      askKicker: "Manca qualcosa?", askHeading: "Richiedi un tutorial",
      askLede: "Una funzione non è chiara, o manca il video che servirebbe? Scrivi l'argomento: le richieste aiutano a scegliere i prossimi tutorial da preparare.",
      topic: "Argomento", topicPh: "Es. come caricare i documenti di un caso", messagePh: "Il punto in cui ti sei fermato, o la domanda che hai.", message: "Cosa non è chiaro", optional: "(facoltativo)",
      name: "Nome", email: "Email", askNote: "Nome ed email servono solo per poterti rispondere.", send: "Invia la richiesta", sending: "Invio in corso…", close: "Chiudi",
      errTopic: "Scrivi l'argomento del tutorial (almeno qualche parola).", errEmail: "L'indirizzo email non sembra valido. Si può anche lasciarlo vuoto.",
      errFile: "Aperta come file dal computer, la guida non può inviare richieste: va aperta da un indirizzo web.",
      ok: "Richiesta inviata. Grazie: arriva direttamente a chi prepara i tutorial.", err429: "Troppe richieste in poco tempo. Riprovare fra qualche minuto.",
      err422: "Alcuni campi non sono validi: controlla argomento ed email.", errGeneric: "L'invio non è riuscito per un problema tecnico. Riprovare fra poco.",
      errNetwork: "Il server non risponde: la richiesta non è stata inviata. Riprovare fra poco.",
      search: "Cerca nella guida…", video: "Video", deep: "Approfondimenti", downloadTranscript: "Scarica la trascrizione (.txt)",
      printTitle: "Stampa PDF", selectAll: "Seleziona tutto", selectNone: "Deseleziona", howItWorks: "Come funziona",
      printHint: "Si includono solo le sezioni spuntate. Con più di una sezione, la prima pagina del PDF è un indice. In Chrome, nella finestra di stampa abilita \"Grafica di sfondo\" per vedere i colori.",
      printOne: "Stampa solo questa sezione", include: "Includi nel PDF", next: "Successivo", previous: "Precedente",
      deepTitle: "La guida completa", deepLede: "Tutto quello che il video mostra, con i dettagli: sezione per sezione, ognuna stampabile anche da sola.",
      transcriptTitle: "Trascrizione del video", transcriptSub: "i testi letti nel video, passo per passo", contents: "Indice", docsOf: "{title} · documentazione",
      language: "Lingua", goTo: "Vai a {title}", articleIn: "Questa guida non è ancora tradotta: eccola in {lang}.", videoIn: "Questo video non è ancora disponibile nella tua lingua: si vede in {lang}."
    }
  };
  var WORDS = LABELS[lang] || LABELS[lang.slice(0, 2)] || LABELS.en;
  function L(k, vars) {
    var s = cat.labels[k] || WORDS[k] || LABELS.en[k] || k;
    return s.replace(/\{(\w+)\}/g, function (_, v) { return vars && vars[v] != null ? vars[v] : ""; });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function langName(l) { try { return new Intl.DisplayNames([lang], { type: "language" }).of(l); } catch (e) { return l; } }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  var ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg>',
    tri: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9.33 7.4V16.6L17.33 12Z" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>',
    check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>',
    chev: function (d) { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="' + d + '"/></svg>'; },
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5z" fill="currentColor"/></svg>'
  };
  var tri = function (size) { return ICON.tri.replace(/18/g, String(size)); };
  var ready = cat.items.filter(function (it) { return it.status !== "soon"; });
  var soon = cat.items.filter(function (it) { return it.status === "soon"; });
  var current = S.page === "item" ? cat.items.filter(function (it) { return it.id === S.item; })[0] : null;
  var href = function (it, hash) { return root + it.href + (hash || ""); };

  // ───────────── tiles ─────────────
  function cover(it) {
    return '<span class="cf-cover" data-kicker="' + esc(it.kicker || "") + '"><small>' + esc(it.kicker || "") + "</small><b>" + esc(it.title) + "</b></span>";
  }
  function media(it) { return it.poster ? '<img src="' + esc(root + it.poster) + '" alt="" loading="lazy">' : cover(it); }

  function tile(it) {
    var video = it.status === "video", isSoon = it.status === "soon";
    var tag = video ? '<span class="cf-tag">' + tri(9) + L(it.slides ? "tagSlides" : "tagVideo") + (it.duration ? " · " + esc(it.duration) : "") + "</span>"
      : isSoon ? '<span class="cf-tag cf-tag-soon">' + L("tagSoon") + "</span>" : '<span class="cf-tag cf-tag-light">' + L("tagGuide") + "</span>";
    var cta = video ? L(it.slides ? "ctaSlides" : "ctaVideo") : isSoon ? "" : L("ctaGuide");
    var t = el(it.href ? "a" : "div", "cf-tile" + (isSoon ? " cf-soon" : ""));
    if (it.href) t.href = href(it, video ? "#cf-player" : ""); else t.tabIndex = 0;
    t._item = it;
    t.innerHTML = '<div class="cf-tile-media">' + media(it) + tag + (video ? '<span class="cf-tile-play" aria-hidden="true">' + ICON.tri + "</span>" : "") +
      '<div class="cf-tile-info">' + esc(it.desc) + (cta ? "<em>" + cta + "</em>" : "") + "</div></div>" +
      '<p class="cf-tile-title">' + esc(it.title) + '</p><p class="cf-tile-sub">' + (video ? L(it.slides ? "subSlides" : "subVideo") : isSoon ? L("subSoon") : L("subGuide")) + "</p>";
    return t;
  }
  function askTile() {
    var a = el("a", "cf-tile cf-ask", '<div class="cf-tile-media"><span><i aria-hidden="true">+</i>' + L("request") + "</span></div>" +
      '<p class="cf-tile-title">' + L("askTitle") + '</p><p class="cf-tile-sub">' + L("askSub") + "</p>");
    a.href = "#request";
    return a;
  }
  function rail(nodes) {
    var wrap = el("div", "cf-rail-wrap"), track = el("div", "cf-rail");
    nodes.forEach(function (n) { track.appendChild(n); });
    var prev = el("button", "cf-rail-arrow cf-prev", ICON.chev("m15 6-6 6 6 6")), next = el("button", "cf-rail-arrow cf-next", ICON.chev("m9 6 6 6-6 6"));
    prev.type = next.type = "button";
    prev.setAttribute("aria-label", L("back")); next.setAttribute("aria-label", L("forward"));
    function update() {
      prev.disabled = track.scrollLeft < 8;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
    }
    prev.onclick = function () { track.scrollBy({ left: -track.clientWidth * 0.85 }); };
    next.onclick = function () { track.scrollBy({ left: track.clientWidth * 0.85 }); };
    track.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    wrap.appendChild(prev); wrap.appendChild(track); wrap.appendChild(next);
    setTimeout(update, 0);
    return wrap;
  }

  /* hover preview: one element in the body (a scrolling row would clip an enlarged tile inside it) */
  var pv = null, pvFor = null, showT = null, hideT = null;
  function buildPreview(t) {
    var it = t._item, video = it.status === "video";
    var chips = video && it.slides
      ? '<span class="cf-chip cf-strong">' + L("tagSlides") + (it.duration ? " · " + esc(it.duration) : "") + '</span><span class="cf-chip">' + L("chipByHand") + "</span>"
      : video
      ? '<span class="cf-chip cf-strong">' + L("tagVideo") + (it.duration ? " · " + esc(it.duration) : "") + '</span><span class="cf-chip">' + L("chipVoice") + '</span><span class="cf-chip">' + L("transcript") + "</span>"
      : '<span class="cf-chip">' + L("chipRead") + '</span><span class="cf-chip">' + L("chipPdf") + "</span>";
    var steps = it.chapters.length ? '<ol class="cf-pv-steps">' + it.chapters.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ol>" : "";
    var list = it.contents.length ? '<ul class="cf-pv-list">' + it.contents.map(function (c) { return "<li>" + ICON.check + "<span>" + esc(c) + "</span></li>"; }).join("") + "</ul>" : "";
    var btns = video && it.slides
      ? '<a class="cf-btn cf-primary" href="' + esc(href(it, "#cf-player")) + '">' + tri(12) + L("present") + '</a><a class="cf-btn" href="' + esc(href(it)) + '">' + L("guide") + "</a>"
      : video
      ? '<a class="cf-btn cf-primary" href="' + esc(href(it, "#cf-player")) + '">' + tri(12) + L("watch") + '</a><a class="cf-btn" href="' + esc(href(it, "#transcript")) + '">' + L("transcript") + '</a><a class="cf-btn" href="' + esc(href(it)) + '">' + L("guide") + "</a>"
      : '<a class="cf-btn cf-primary" href="' + esc(href(it)) + '">' + L("readGuide") + "</a>";
    var p = el("div", "cf-pv",
      '<a class="cf-pv-media" href="' + esc(href(it, video ? "#cf-player" : "")) + '" tabindex="-1">' + (it.poster ? '<img src="' + esc(root + it.poster) + '" alt="">' : cover(it)) +
      (video ? '<span class="cf-pv-play">' + ICON.tri + "</span>" : "") + "</a>" +
      '<div class="cf-pv-body"><p class="cf-pv-kicker">' + esc(it.kicker || "") + '</p><p class="cf-pv-title">' + esc(it.title) + "</p>" +
      '<div class="cf-chips">' + chips + '</div><p class="cf-pv-desc">' + esc(it.desc) + "</p>" + steps + list + '<div class="cf-btns">' + btns + "</div></div>");
    p.addEventListener("mouseenter", function () { clearTimeout(hideT); });
    p.addEventListener("mouseleave", scheduleHide);
    return p;
  }
  function placePreview(p, t) {
    var r = t.querySelector(".cf-tile-media").getBoundingClientRect();
    var w = Math.min(Math.max(r.width * 1.35, 340), window.innerWidth - 32);
    var minL = (parseFloat(getComputedStyle(body).paddingLeft) || 0) + 16; // not under the left bar
    var left = Math.max(window.scrollX + minL, Math.min(r.left + r.width / 2 - w / 2 + window.scrollX, window.scrollX + window.innerWidth - w - 16));
    p.style.width = w + "px";
    p.style.left = left + "px";
    p.style.top = r.top + window.scrollY - r.height * 0.18 + "px";
  }
  function showPreview(t) {
    hidePreview(true);
    pv = buildPreview(t); pvFor = t;
    body.appendChild(pv);
    placePreview(pv, t);
    requestAnimationFrame(function () { if (pv) pv.classList.add("cf-on"); });
  }
  function hidePreview(now) {
    clearTimeout(showT); clearTimeout(hideT);
    if (!pv) return;
    var old = pv; pv = null; pvFor = null;
    if (now) return old.remove();
    old.classList.remove("cf-on");
    setTimeout(function () { old.remove(); }, 180);
  }
  function scheduleHide() { clearTimeout(hideT); hideT = setTimeout(function () { hidePreview(false); }, 160); }
  if (window.matchMedia && matchMedia("(hover: hover)").matches) {
    body.classList.add("cf-hover");
    document.addEventListener("mouseover", function (e) {
      var t = e.target.closest && e.target.closest("a.cf-tile");
      if (!t || !t._item) return;
      clearTimeout(hideT);
      if (t === pvFor) return;
      clearTimeout(showT);
      showT = setTimeout(function () { showPreview(t); }, 420);
    });
    document.addEventListener("mouseout", function (e) {
      var t = e.target.closest && e.target.closest("a.cf-tile");
      if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return;
      clearTimeout(showT);
      if (t === pvFor) scheduleHide();
    });
    window.addEventListener("scroll", function () { hidePreview(true); }, { passive: true, capture: true });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hidePreview(true); });
  }

  // ───────────── shell: left bar, tutorials drawer, request dialog ─────────────
  function railBtn(tag, icon, tip, attrs) {
    var b = el(tag, "cf-rail-btn", icon + '<span class="cf-tip">' + esc(tip) + "</span>");
    b.setAttribute("aria-label", tip);
    Object.keys(attrs || {}).forEach(function (k) { b.setAttribute(k, attrs[k]); });
    if (tag === "button") b.type = "button";
    return b;
  }
  var bar = el("nav", "cf-bar-left cf-no-print");
  bar.setAttribute("aria-label", cat.title);
  var logo = el("a", "cf-logo", cat.brand.logo || ICON.logo);
  // the home is the folder's address (published at the root that is "/"); opened from disk there is no server to pick index.html
  var homeHref = location.protocol === "file:" ? root + "index.html" : root || "./";
  logo.href = cat.brand.url || homeHref; logo.setAttribute("aria-label", cat.brand.name || cat.title);
  bar.appendChild(logo);
  var homeBtn = railBtn("a", ICON.home, L("home"), { href: homeHref });
  if (S.page === "home") homeBtn.setAttribute("aria-current", "page");
  bar.appendChild(homeBtn);
  var tutBtn = railBtn("button", ICON.play, L("tutorials"), { "aria-expanded": "false", "aria-controls": "cf-drawer" });
  bar.appendChild(tutBtn);
  var idxBtn = null;
  if (current) { idxBtn = railBtn("button", ICON.list, L("index"), { "aria-expanded": "false" }); bar.appendChild(idxBtn); }
  var askBtn = cat.requestEndpoint ? railBtn("button", ICON.plus, L("request"), { "aria-haspopup": "dialog" }) : null;
  if (askBtn) bar.appendChild(askBtn);
  bar.appendChild(el("span", "cf-spacer"));
  if (offered.length > 1) {
    var native = function (l) {
      try { var n = new Intl.DisplayNames([l], { type: "language" }).of(l); return n.charAt(0).toUpperCase() + n.slice(1); } catch (e) { return l.toUpperCase(); }
    };
    var langBtn = railBtn("button", '<b class="cf-lang-code">' + esc(lang.toUpperCase()) + "</b>", L("language"), { "aria-haspopup": "true", "aria-expanded": "false" });
    var menu = el("div", "cf-lang-menu", offered.map(function (l) {
      return '<button type="button" data-lang="' + esc(l) + '"' + (l === lang ? ' aria-current="true"' : "") + ' lang="' + esc(l) + '"><b>' + esc(l.toUpperCase()) + "</b>" + esc(native(l)) + "</button>";
    }).join(""));
    menu.hidden = true;
    langBtn.appendChild(menu);
    langBtn.addEventListener("click", function (e) {
      var pickBtn = e.target.closest && e.target.closest("[data-lang]");
      if (pickBtn) {
        try { localStorage.setItem(LANG_KEY, pickBtn.getAttribute("data-lang")); } catch (err) { /* this visit only */ }
        if (pickBtn.getAttribute("data-lang") !== lang) location.reload();
        return;
      }
      menu.hidden = !menu.hidden;
      langBtn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("click", function (e) { if (!langBtn.contains(e.target)) { menu.hidden = true; langBtn.setAttribute("aria-expanded", "false"); } });
    bar.appendChild(langBtn);
  }
  var pdfBtn = null;
  if (current) { pdfBtn = railBtn("button", ICON.print, L("pdf")); bar.appendChild(pdfBtn); }
  body.insertBefore(bar, body.firstChild);

  var drawer = el("aside", "cf-drawer cf-no-print",
    "<h2>" + L("tutorials") + '</h2><p class="cf-sub">' + L("available", { n: ready.length }) + (soon.length ? " · " + L("coming", { n: soon.length }) : "") + "</p>" +
    '<p class="cf-drawer-title">' + L("availableTitle") + '</p><div class="cf-drawer-list"></div>' +
    (soon.length ? '<p class="cf-drawer-title">' + L("tagSoon") + '</p><ul class="cf-drawer-soon">' +
      soon.map(function (it) { return "<li><span>" + esc(it.title) + "</span><small>" + esc(it.kicker || "") + "</small></li>"; }).join("") + "</ul>" : "") +
    '<div class="cf-drawer-links"><a href="' + homeHref + '">' + L("allTutorials") + "</a>" + (askBtn ? '<a href="#request">' + L("requestLink") + "</a>" : "") + "</div>");
  drawer.id = "cf-drawer";
  drawer.setAttribute("aria-label", L("tutorials"));
  ready.forEach(function (it) { drawer.querySelector(".cf-drawer-list").appendChild(tile(it)); });
  var scrim = el("div", "cf-scrim");
  body.appendChild(scrim); body.appendChild(drawer);
  function openDrawer(v) {
    drawer.classList.toggle("cf-open", v); scrim.classList.toggle("cf-on", v);
    tutBtn.setAttribute("aria-expanded", String(v));
    var first = v && drawer.querySelector("a");
    if (first) first.focus({ preventScroll: true });
  }
  tutBtn.onclick = function () { openDrawer(!drawer.classList.contains("cf-open")); };
  scrim.onclick = function () { openDrawer(false); };
  drawer.addEventListener("click", function (e) { if (e.target.closest("a")) openDrawer(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && drawer.classList.contains("cf-open")) { openDrawer(false); tutBtn.focus(); } });

  /* request a tutorial: a dialog reachable from everywhere, and from any link to #request */
  var openAsk = function () {};
  if (cat.requestEndpoint) {
    var dlg = el("dialog", "cf-ask-dialog",
      '<form method="dialog" class="cf-ask-close"><button aria-label="' + L("close") + '">×</button></form>' +
      '<p class="cf-kicker">' + L("askKicker") + '</p><h2 id="cf-ask-title">' + L("askHeading") + '</h2><p class="cf-ask-lede">' + L("askLede") + "</p>" +
      '<form class="cf-ask-form" novalidate>' +
      "<label>" + L("topic") + '<input name="topic" required minlength="3" maxlength="200" placeholder="' + esc(L("topicPh")) + '"></label>' +
      "<label>" + L("message") + " <span>" + L("optional") + '</span><textarea name="message" maxlength="2000" placeholder="' + esc(L("messagePh")) + '"></textarea></label>' +
      '<div class="cf-two"><label>' + L("name") + " <span>" + L("optional") + '</span><input name="name" maxlength="120" autocomplete="name"></label>' +
      "<label>" + L("email") + " <span>" + L("optional") + '</span><input name="email" type="email" maxlength="160" autocomplete="email"></label></div>' +
      '<div class="cf-hp" aria-hidden="true"><label>Company<input name="company" tabindex="-1" autocomplete="off"></label></div>' +
      '<p class="cf-ask-note">' + L("askNote") + '</p><div><button type="submit" class="cf-ask-send">' + L("send") + "</button></div>" +
      '<p class="cf-ask-status" role="status" hidden></p></form>');
    dlg.setAttribute("aria-labelledby", "cf-ask-title");
    body.appendChild(dlg);
    var form = dlg.querySelector(".cf-ask-form"), status = dlg.querySelector(".cf-ask-status"), send = dlg.querySelector(".cf-ask-send");
    var say = function (kind, text) { status.hidden = false; status.className = "cf-ask-status cf-" + kind; status.textContent = text; };
    openAsk = function () {
      openDrawer(false);
      status.hidden = true;
      if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
      form.elements.topic.focus();
    };
    askBtn.onclick = openAsk;
    dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[href$="#request"]');
      if (!a) return;
      if (a.getAttribute("href").charAt(0) === "#" || a.pathname === location.pathname) { e.preventDefault(); openAsk(); }
    });
    if (location.hash === "#request") setTimeout(openAsk, 0);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements, topic = f.topic.value.trim(), email = f.email.value.trim();
      if (topic.length < 3) { say("err", L("errTopic")); f.topic.focus(); return; }
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say("err", L("errEmail")); return; }
      if (location.protocol === "file:") { say("err", L("errFile")); return; }
      send.disabled = true; send.textContent = L("sending");
      fetch(cat.requestEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic, message: f.message.value.trim() || undefined, name: f.name.value.trim() || undefined,
          email: email || undefined, company: f.company.value || undefined, page: location.pathname })
      }).then(function (res) {
        if (res.ok) { form.reset(); say("ok", L("ok")); }
        else say("err", res.status === 429 ? L("err429") : res.status === 422 ? L("err422") : L("errGeneric"));
      }, function () { say("err", L("errNetwork")); }).then(function () { send.disabled = false; send.textContent = L("send"); });
    });
  }
  body.classList.add("cf-shell");

  // ───────────── home ─────────────
  if (S.page === "home") {
    var main = document.getElementById("cf-home");
    var f = cat.items.filter(function (it) { return it.id === cat.featured && it.href; })[0];
    if (f) {
      var bb = el("section", "cf-billboard" + (f.poster ? "" : " cf-no-poster"));
      bb.setAttribute("aria-label", L("featured"));
      var video = f.status === "video";
      bb.innerHTML = (f.poster ? '<img src="' + esc(f.poster) + '" alt="">' : "") +
        '<div class="cf-bb-text cf-pad"><p class="cf-kicker">' + L("featured") + (video ? " · " + L(f.slides ? "tagSlides" : "tagVideo") + (f.duration ? " · " + esc(f.duration) : "") : "") + "</p>" +
        "<h1>" + esc(f.title) + '</h1><p class="cf-bb-desc">' + esc(f.desc) + '</p><div class="cf-btns">' +
        (video && f.slides ? '<a class="cf-btn cf-primary cf-big-btn" href="' + esc(href(f, "#cf-player")) + '">' + tri(14) + L("present") + "</a>"
          : video ? '<a class="cf-btn cf-primary cf-big-btn" href="' + esc(href(f, "#cf-player")) + '">' + tri(14) + L("watch") + '</a><a class="cf-btn cf-ghost cf-big-btn" href="' + esc(href(f, "#transcript")) + '">' + L("readTranscript") + "</a>"
          : '<a class="cf-btn cf-primary cf-big-btn" href="' + esc(href(f)) + '">' + L("readGuide") + "</a>") + "</div></div>";
      main.appendChild(bb);
    }
    if (cat.quickAccess && ready.length) {
      var q = el("section", "cf-sec cf-pad", '<div class="cf-sec-head"><h2>' + L("quick") + '</h2></div><div class="cf-quick"></div>');
      var box = q.querySelector(".cf-quick");
      ready.forEach(function (it) {
        var a = el("a", "cf-qk", "<i>" + (it.icon || '<b class="cf-qk-letter">' + esc(it.title.charAt(0)) + "</b>") + "</i><b>" + esc(it.title) + "</b>");
        a.href = href(it, it.status === "video" ? "#cf-player" : "");
        a.setAttribute("data-kicker", it.kicker || "");
        box.appendChild(a);
      });
      if (cat.requestEndpoint) {
        var ask = el("button", "cf-qk cf-ask", '<i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></i><b>' + L("request") + "</b>");
        ask.type = "button"; ask.onclick = function () { openAsk(); };
        box.appendChild(ask);
      }
      main.appendChild(q);
    }
    cat.rows.forEach(function (row) {
      var items = cat.items.filter(function (it) { return it.row === row.id; });
      if (!items.length && !row.askTile) return;
      var sec = el("section", "cf-sec cf-pad" + (row.band ? " cf-band" : ""));
      sec.id = row.id; sec.setAttribute("aria-label", row.title);
      sec.innerHTML = (row.kicker || row.band ? '<p class="cf-kicker">' + esc(row.kicker || L("soonKicker")) + "</p>" : "") +
        '<div class="cf-sec-head"><h2>' + esc(row.title) + "</h2>" + (row.note ? "<span>" + esc(row.note) + "</span>" : "") + "</div>" +
        (row.lede || row.band ? '<p class="cf-sec-lede">' + esc(row.lede || L(cat.requestEndpoint ? "soonLede" : "soonLedePlain")) /* no promise of a request form the site does not have */ + "</p>" : "");
      var nodes = items.map(tile);
      if (row.askTile && cat.requestEndpoint) nodes.push(askTile());
      sec.appendChild(rail(nodes));
      main.appendChild(sec);
    });
    if (cat.footer) main.appendChild(el("p", "cf-foot cf-pad", esc(cat.footer)));
    return;
  }

  // ───────────── item page ─────────────
  var articles = S.articles || {};
  var art = articles[lang] || articles[fallback] || articles[cat.lang] || articles[Object.keys(articles)[0]];
  var sections = art ? art.sections : [];
  document.querySelector(".cf-video-zone h1").textContent = current.title;
  document.title = current.title + " · " + cat.title;
  var foot = document.querySelector(".cf-foot");
  if (foot) foot.textContent = cat.footer || "";
  var artBox = document.querySelector(".cf-article");
  if (artBox && art) {
    artBox.innerHTML = (art.lang !== lang ? '<p class="cf-lang-note">' + esc(L("articleIn", { lang: langName(art.lang) })) + "</p>" : "") + art.html;
    artBox.lang = art.lang;
  }
  var side = document.querySelector(".cf-side");
  var player = null;
  /* "Go to …" asks the next page to start its video at once (?play=1); the address is cleaned so a reload or a shared
     link does not autoplay. Whether sound may start without a click there is up to the browser: if not, the play button waits. */
  var PLAY_ON_ARRIVAL = "?play=1";
  var arrivedToPlay = /[?&]play=1(&|$)/.test(location.search);
  if (arrivedToPlay && history.replaceState) {
    try { history.replaceState(null, "", location.pathname + location.search.replace(/([?&])play=1(&|$)/, "$1").replace(/[?&]$/, "") + location.hash); } catch (e) { /* a file: page may refuse it */ }
  }
  var transcriptSec = document.getElementById("transcript");
  if (S.guide && window.Cueflow) {
    // every player follows the site's language; a guide without it plays in the fallback, or its first language
    var gl = S.guide.guide.languages, playLang = gl.indexOf(lang) >= 0 ? lang : gl.indexOf(fallback) >= 0 ? fallback : gl[0];
    // at the end, the banner over the picture proposes the next video of the catalog (its title in the site's language)
    var nextUp = S.next ? { title: P(S.next.title), href: S.next.href + PLAY_ON_ARRIVAL } : null;
    // slides never start on their own: presenting is the reader's gesture (and full screen needs one)
    player = window.Cueflow.mount(document.getElementById("cf-player"), S.guide, { fluid: true, lang: playLang, langSelect: false, duration: current.duration, next: nextUp, autoplay: arrivedToPlay && !current.slides });
    if (playLang !== lang) document.getElementById("cf-player").insertAdjacentHTML("beforebegin", '<p class="cf-lang-note">' + esc(L("videoIn", { lang: langName(playLang) })) + "</p>");
    window.__cueflow = player;
    // the player's transcript becomes a printable section of the page
    var tr = player.element.querySelector(".cf-transcript");
    if (tr && transcriptSec) {
      transcriptSec.setAttribute("data-title", L("transcriptTitle"));
      tr.querySelector(".cf-tr-title").insertAdjacentHTML("afterend", ' <small class="cf-tr-sub">· ' + esc(L("transcriptSub")) + "</small>");
      transcriptSec.appendChild(tr);
      var openTr = function () { if (location.hash === "#transcript") tr.open = true; };
      window.addEventListener("hashchange", openTr); openTr();
      document.addEventListener("click", function (e) { if (e.target.closest && e.target.closest('a[href="#transcript"]')) tr.open = true; });
      window.addEventListener("beforeprint", function () { tr.dataset.wasOpen = String(tr.open); tr.open = true; });
      window.addEventListener("afterprint", function () { tr.open = tr.dataset.wasOpen === "true"; });
    }
  }
  var deepHead = document.querySelector(".cf-deep-head");
  // "in depth" only makes sense after a video: a written guide starts with its own sections
  if (deepHead && player) deepHead.innerHTML = '<p class="cf-kicker">' + L("deep") + '</p><p class="cf-deep-title">' + L("deepTitle") + '</p><p class="cf-deep-lede">' + L("deepLede") + "</p>";
  else if (deepHead) deepHead.remove();

  /* each section: print-this-only button, and a pager to the next one */
  sections.forEach(function (s, i) {
    var node = document.getElementById(s.id);
    if (!node) return;
    var btn = el("button", "cf-print-one cf-no-print", ICON.print + L("printOne"));
    btn.type = "button"; btn.setAttribute("data-print", s.id);
    var h2 = node.querySelector("h2");
    if (h2) { var head = el("div", "cf-section-head"); h2.parentNode.insertBefore(head, h2); head.appendChild(h2); head.appendChild(btn); }
    else node.insertBefore(btn, node.firstChild);
    var prev = sections[i - 1], next = sections[i + 1];
    if (prev || next) {
      node.appendChild(el("div", "cf-pager cf-no-print",
        (prev ? '<a class="cf-pager-link" href="#' + esc(prev.id) + '"><span>' + L("previous") + "</span><b>← " + esc(prev.title) + "</b></a>" : "<span></span>") +
        (next ? '<a class="cf-pager-link cf-next" href="#' + esc(next.id) + '"><span>' + L("next") + "</span><b>" + esc(next.title) + " →</b></a>" : "")));
    }
  });

  /* a written guide has no video to end: what follows it in the catalog is proposed at the end of its text,
     with the same words as the banner over a finished video */
  if (!player && S.next) {
    var goParts = L("goTo", { title: "\u0000" }).split("\u0000");
    var goLink = el("a", "cf-up-next-card cf-no-print",
      "<span>" + esc(goParts[0]) + "<b>" + esc(P(S.next.title)) + "</b>" + esc(goParts.slice(1).join("")) + '</span><i aria-hidden="true">→</i>');
    goLink.href = S.next.href + PLAY_ON_ARRIVAL;
    // inside the article, so it takes the text's width; a page with no text at all puts it before the footer
    if (artBox) artBox.appendChild(goLink);
    else { var mainBox = document.querySelector(".cf-main"); mainBox.insertBefore(goLink, mainBox.querySelector(".cf-foot")); }
  }

  /* the side index: video (steps, transcript) and in-depth sections, as two accordions */
  var printable = [];
  function treeItem(id, title, subs) {
    printable.push(id);
    return '<li class="cf-tree-item" data-target="' + esc(id) + '"><div class="cf-tree-row"><a class="cf-page-link" href="#' + esc(id) + '">' + esc(title) + "</a>" +
      '<input type="checkbox" data-target="' + esc(id) + '" checked title="' + esc(L("include")) + '"></div>' +
      (subs.length ? '<ul class="cf-sub-tree">' + subs.join("") + "</ul>" : "") + "</li>";
  }
  var html = '<div class="cf-search"><input type="search" placeholder="' + esc(L("search")) + '" aria-label="' + esc(L("search")) + '"></div>';
  if (player) {
    var stepLinks = player.steps().map(function (t, i) { return '<li><a href="#step-' + (i + 1) + '">' + (i + 1) + " · " + esc(t) + "</a></li>"; });
    // slides have no transcript to print or download: the index lists the slides, each one a link
    if (current.slides) html += '<details class="cf-acc" data-zone="video" open><summary>' + L("slidesZone") + '</summary><ul class="cf-tree cf-sub-tree">' + stepLinks.join("") + "</ul></details>";
    else {
      stepLinks.push('<li><button type="button" class="cf-link-btn" data-download>' + L("downloadTranscript") + "</button></li>");
      html += '<details class="cf-acc" data-zone="video" open><summary>' + L("video") + '</summary><ul class="cf-tree">' +
        treeItem("transcript", L("transcriptTitle"), stepLinks) + "</ul></details>";
    }
  }
  if (sections.length) {
    html += '<details class="cf-acc" data-zone="deep"' + (player ? "" : " open") + "><summary>" + L("deep") + '</summary><ul class="cf-tree">' +
      sections.map(function (s) {
        return treeItem(s.id, s.title, s.subs.map(function (h) { return '<li><a href="#' + esc(h.id) + '">' + esc(h.title) + "</a></li>"; }));
      }).join("") + "</ul></details>";
  }
  // nothing printable (slides without a written guide): no print panel offering an empty PDF
  if (printable.length) html += '<div class="cf-print-panel"><p class="cf-side-label">' + L("printTitle") + '</p><div class="cf-sel-row"><button type="button" class="cf-link-btn" data-all>' + L("selectAll") +
    '</button><button type="button" class="cf-link-btn" data-none>' + L("selectNone") + '</button></div><button type="button" class="cf-print-btn">' + ICON.print + L("pdf") +
    '</button><details class="cf-pdf-help"><summary>' + L("howItWorks") + "</summary><p>" + L("printHint") + "</p></details></div>";
  side.innerHTML = html;
  side.classList.add("cf-no-print");

  var dl = side.querySelector("[data-download]");
  if (dl) dl.onclick = function () { player.downloadTranscript(); };
  /* following a step link plays that step (the player listens to #step-N); a click on the same link replays it */
  side.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#step-"]');
    if (a && location.hash === a.getAttribute("href")) { e.preventDefault(); player.jump(+a.getAttribute("href").slice(6) - 1); document.getElementById("cf-player").scrollIntoView({ block: "start" }); }
  });

  /* the accordion of the zone being read opens by itself, but only when crossing from one zone to the other */
  var accs = {};
  Array.prototype.forEach.call(side.querySelectorAll(".cf-acc"), function (d) { accs[d.getAttribute("data-zone")] = d; });
  var zone = null;
  function setZone(z) { if (z === zone || !accs.video || !accs.deep) return; zone = z; accs.video.open = z === "video"; accs.deep.open = z === "deep"; }
  var vz = document.querySelector(".cf-video-zone");
  if (player && "IntersectionObserver" in window) {
    new IntersectionObserver(function (en) { en.forEach(function (x) { setZone(x.isIntersecting ? "video" : "deep"); }); }, { rootMargin: "0px 0px -55% 0px" }).observe(vz);
  }
  if (location.hash && accs.deep && accs.deep.querySelector('a[href="' + location.hash + '"]')) setZone("deep");

  /* search: filters the index */
  var search = side.querySelector(".cf-search input");
  var items = Array.prototype.slice.call(side.querySelectorAll(".cf-tree-item"));
  search.addEventListener("input", function () {
    var q = search.value.trim().toLowerCase();
    if (q) Object.keys(accs).forEach(function (k) { accs[k].open = true; });
    items.forEach(function (item) {
      var own = !q || item.querySelector(".cf-page-link").textContent.toLowerCase().indexOf(q) >= 0, any = false;
      Array.prototype.forEach.call(item.querySelectorAll(".cf-sub-tree li"), function (li) {
        var m = !q || li.textContent.toLowerCase().indexOf(q) >= 0;
        li.classList.toggle("cf-hidden", !(own || m));
        if (m) any = true;
      });
      item.classList.toggle("cf-hidden", !(own || any));
    });
  });

  /* the section on screen is marked in the index */
  if ("IntersectionObserver" in window) {
    var byId = {};
    items.forEach(function (i) { byId[i.getAttribute("data-target")] = i; });
    var obs = new IntersectionObserver(function (en) {
      en.forEach(function (x) {
        if (!x.isIntersecting || !byId[x.target.id]) return;
        items.forEach(function (i) { i.classList.remove("cf-active"); });
        byId[x.target.id].classList.add("cf-active");
      });
    }, { rootMargin: "-15% 0px -70% 0px" });
    printable.forEach(function (id) { var n = document.getElementById(id); if (n) obs.observe(n); });
  }

  /* index panel: open or closed, remembered in this browser */
  var KEY = "cueflow-docs-panel";
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* storage unavailable */ }
  var narrow = function () { return window.matchMedia("(max-width: 720px)").matches; };
  function setPanel(v, save) {
    body.classList.toggle("cf-panel-closed", !v);
    idxBtn.setAttribute("aria-expanded", String(v));
    if (save) { try { localStorage.setItem(KEY, v ? "open" : "closed"); } catch (e) { /* ignore */ } }
    window.dispatchEvent(new Event("resize")); // the player re-frames its camera
  }
  setPanel(stored ? stored === "open" && !narrow() : !narrow(), false);
  idxBtn.onclick = function () { setPanel(body.classList.contains("cf-panel-closed"), true); };
  side.addEventListener("click", function (e) { if (narrow() && e.target.closest("a")) setPanel(false, false); });

  /* PDF: built in beforeprint, so the browser's own Print gets the same cover and index */
  var boxes = Array.prototype.slice.call(side.querySelectorAll("input[type=checkbox][data-target]"));
  var coverEl = document.getElementById("cf-print-cover");
  var pending = null;
  var allSections = Array.prototype.slice.call(document.querySelectorAll(".cf-section"));
  function selected() { return boxes.filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute("data-target"); }); }
  window.addEventListener("beforeprint", function () {
    var ids = pending && pending.length ? pending : selected();
    if (!ids.length) ids = printable.slice();
    pending = null;
    allSections.forEach(function (s) { s.classList.remove("cf-print-in", "cf-print-first"); });
    ids.forEach(function (id, i) { var n = document.getElementById(id); if (n) { n.classList.add("cf-print-in"); if (!i) n.classList.add("cf-print-first"); } });
    var toc = ids.map(function (id) {
      var n = document.getElementById(id);
      var subs = n ? Array.prototype.map.call(n.querySelectorAll("h3[id]"), function (h) { return '<li><a href="#' + h.id + '">' + esc(h.textContent) + "</a></li>"; }).join("") : "";
      return '<li><a href="#' + esc(id) + '">' + esc((n && n.getAttribute("data-title")) || id) + "</a>" + (subs ? "<ol>" + subs + "</ol>" : "") + "</li>";
    }).join("");
    coverEl.innerHTML = '<p class="cf-kicker">' + esc(L("docsOf", { title: cat.title })) + "</p><h1>" + esc(current.title) + '</h1><p class="cf-cover-date">' +
      new Date().toLocaleDateString(lang, { year: "numeric", month: "long", day: "numeric" }) + "</p>" + (ids.length > 1 ? "<h2>" + L("contents") + '</h2><ol class="cf-cover-toc">' + toc + "</ol>" : "");
    coverEl.classList.toggle("cf-on", true);
    body.classList.add("cf-printing");
  });
  window.addEventListener("afterprint", function () {
    body.classList.remove("cf-printing");
    allSections.forEach(function (s) { s.classList.remove("cf-print-in", "cf-print-first"); });
    coverEl.classList.remove("cf-on");
    coverEl.innerHTML = "";
  });
  function print(ids) { pending = ids; window.print(); }
  pdfBtn.onclick = function () { print(selected()); };
  if (side.querySelector(".cf-print-panel")) {
    side.querySelector(".cf-print-btn").onclick = function () { print(selected()); };
    side.querySelector("[data-all]").onclick = function () { boxes.forEach(function (c) { c.checked = true; }); };
    side.querySelector("[data-none]").onclick = function () { boxes.forEach(function (c) { c.checked = false; }); };
  }
  document.addEventListener("click", function (e) { var b = e.target.closest && e.target.closest("[data-print]"); if (b) print([b.getAttribute("data-print")]); });
})();
