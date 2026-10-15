(async () => {
  // Studio shows scenes and written guides in iframes. A frozen copy keeps only the outer page, so each
  // frame's document is turned into srcdoc (its stylesheets as <style>, scripts dropped) before the copy.
  for (const f of document.querySelectorAll("iframe")) {
    const d = f.contentDocument;
    if (!d || !d.documentElement || !d.body || !d.body.children.length) continue;
    const root = d.documentElement.cloneNode(true);
    root.querySelectorAll("script").forEach((s) => s.remove());
    for (const l of Array.from(root.querySelectorAll('link[rel="stylesheet"]'))) {
      const sheet = Array.from(d.styleSheets).find((s) => s.ownerNode && s.ownerNode.getAttribute && s.ownerNode.getAttribute("href") === l.getAttribute("href"));
      if (!sheet) continue;
      const st = d.createElement("style");
      try { st.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n"); } catch { continue; }
      l.replaceWith(st);
    }
    f.removeAttribute("src");
    f.setAttribute("srcdoc", "<!doctype html>" + root.outerHTML);
  }
  await new Promise((r) => setTimeout(r, 700));
})()
