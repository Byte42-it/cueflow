import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { openKit, type Kit } from "../src/kit.ts";
import { buildShare } from "../src/share.ts";
import { siteFile } from "../src/site.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-share-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), dir, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(dir);
  process.env.CUEFLOW_CHROMIUM = "/nonexistent"; // the picture needs a browser: these tests do not
});
after(() => rm(dir, { recursive: true, force: true }));

describe("page for phones", () => {
  it("makes a standalone page that follows the phone, with the card in the chosen language", async () => {
    const r = await buildShare(kit, "upload", { lang: "it" });
    const html = await readFile(r.file, "utf8");
    assert.match(r.file, /share[\\/]upload[\\/]index\.html$/);
    assert.match(html, /fluid: true/); // fills the width of the phone
    assert.match(html, /orientation: landscape/); // turned sideways, the picture fills the screen
    assert.match(html, /requestFullscreen/);
    assert.match(html, /og:title" content="Come caricare un documento"/); // the card speaks the chosen language
    assert.match(html, /og:description" content="Dalla sezione Documenti/);
    assert.equal(r.poster, null);
    assert.ok(r.warnings.some((w) => /no picture/.test(w)));
  });

  it("says why the card has no picture when the site has no address", async () => {
    const site = JSON.parse(await readFile(siteFile(kit), "utf8"));
    delete site.url;
    await writeFile(siteFile(kit), JSON.stringify(site));
    const r = await buildShare(kit, "upload");
    assert.equal(r.link, null);
    assert.ok(r.warnings.some((w) => /no "url"/.test(w)));
    assert.ok(!/og:image/.test(await readFile(r.file, "utf8")));
  });

  it("writes absolute addresses in the card when the site says where it is published", async () => {
    const site = JSON.parse(await readFile(siteFile(kit), "utf8"));
    await writeFile(siteFile(kit), JSON.stringify({ ...site, url: "https://help.example.com/" }));
    const r = await buildShare(kit, "upload");
    const html = await readFile(r.file, "utf8");
    assert.equal(r.link, "https://help.example.com/share/upload/");
    assert.match(html, /og:image" content="https:\/\/help\.example\.com\/share\/upload\/poster\.png"/);
    assert.match(html, /og:url" content="https:\/\/help\.example\.com\/share\/upload\/"/);
    assert.ok(!r.warnings.some((w) => /no "url"/.test(w)));
  });
});
