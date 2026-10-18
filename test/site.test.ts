import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { openKit, type Kit } from "../src/kit.ts";
import { Site } from "../src/schema.ts";
import { buildSite, checkEndpoint, loadSite, siteFile, validateSite } from "../src/site.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-site-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), dir, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(dir);
});
after(() => rm(dir, { recursive: true, force: true }));

/** The catalog a built page carries, as its script sees it. */
const pageData = (html: string) => JSON.parse(/window\.CUEFLOW_SITE = (.*);<\/script>/.exec(html)![1]!);

const withSite = async (edit: (site: Record<string, any>) => void) => {
  const site = JSON.parse(await readFile(siteFile(kit), "utf8"));
  edit(site);
  return site;
};

describe("site", () => {
  it("accepts the demo catalog", async () => {
    assert.deepEqual((await validateSite(kit, await loadSite(kit))).errors, []);
  });

  it("builds a home and one page per item that has one", async () => {
    const r = await buildSite(kit, { provider: null });
    assert.deepEqual(r.pages, ["index.html", "upload/index.html", "sharing/index.html"]);
    const home = pageData(await readFile(path.join(r.dir, "index.html"), "utf8"));
    assert.equal(home.page, "home");
    const upload = home.catalog.items.find((i: { id: string }) => i.id === "upload");
    assert.deepEqual(upload.chapters.map((c: { en: string }) => c.en), ["Where documents live", "Choose the file", "Give it a title", "Upload"], "chapters come from the guide's step titles");
    assert.equal(upload.chapters[0].it, "Dove stanno i documenti");
    assert.equal(home.catalog.items.find((i: { id: string }) => i.id === "search").href, undefined, "an announced item has no page");
  });

  it("puts the guide and the article of every language on the item page", async () => {
    const html = await readFile(path.join(kit.root, "dist", "site", "upload", "index.html"), "utf8");
    const data = pageData(html);
    assert.equal(data.guide.guide.id, "upload");
    assert.deepEqual(Object.keys(data.articles).sort(), ["en", "it"]);
    assert.deepEqual(
      data.articles.en.sections.map((s: { id: string; subs: { id: string }[] }) => [s.id, s.subs.map((x) => x.id)]),
      [["files", ["files-types", "files-size"]], ["after", ["after-rename"]]]
    );
    assert.equal(data.articles.it.sections[0].title, "Quali file");
    const tag = /<section[^>]*id="files"[^>]*>/.exec(data.articles.en.html)?.[0] ?? "";
    assert.match(tag, /class="cf-section"/);
    assert.ok(!/<\/script><b>/.test(html));
  });

  it("offers the languages with their fallback, and says which article is missing", async () => {
    const r = await buildSite(kit, { provider: null });
    const home = pageData(await readFile(path.join(r.dir, "index.html"), "utf8"));
    assert.deepEqual(home.catalog.languages, ["en", "it"]);
    assert.equal(home.catalog.fallback, "en");
    assert.deepEqual(home.catalog.items[0].title, { en: "How to upload a document", it: "Come caricare un documento" });
    assert.ok(r.warnings.some((w) => /item "sharing": no pages\/it\/sharing\.html/.test(w)));
    const sharing = pageData(await readFile(path.join(r.dir, "sharing", "index.html"), "utf8"));
    assert.deepEqual(Object.keys(sharing.articles), ["en"], "an untranslated article is stored once, in the original");
  });

  it("ships one stylesheet with site, player and kit theme in that order", async () => {
    await cp(path.join(import.meta.dirname, "..", "examples", "themes", "paper"), path.join(kit.root, "theme"), { recursive: true });
    try {
      const r = await buildSite(kit, { provider: null });
      const css = await readFile(path.join(r.dir, "assets", "cueflow.css"), "utf8");
      const site = css.indexOf("--cf-site-bg"), player = css.indexOf(".cf-stage {"), theme = css.indexOf("/* kit theme */");
      assert.ok(site >= 0 && player > site && theme > player);
      const js = await readFile(path.join(r.dir, "assets", "cueflow.js"), "utf8");
      assert.match(js, /window\.Cueflow = \{ mount: mount \}/);
      assert.match(js, /CUEFLOW_SITE/);
    } finally {
      await rm(path.join(kit.root, "theme"), { recursive: true, force: true });
    }
  });

  it("reports catalog mistakes as readable errors", async () => {
    const site = await withSite((s) => {
      s.items.push({ id: "upload", row: "nowhere", status: "video", title: "Dup" });
      s.featured = "search";
    });
    const { errors } = await validateSite(kit, Site.parse(site));
    assert.ok(errors.some((e) => /duplicate item id "upload"/.test(e)));
    assert.ok(errors.some((e) => /row "nowhere" does not exist/.test(e)));
    assert.ok(errors.some((e) => /is a video but names no guide/.test(e)));
    assert.ok(errors.some((e) => /featured "search" has no page yet/.test(e)));
  });

  it("refuses paths that leave the kit", async () => {
    const site = Site.parse(await withSite((s) => { s.items[0].poster = "../../etc/passwd"; }));
    await assert.rejects(validateSite(kit, site), /outside the kit/);
  });

  it("hides the request form when there is no endpoint", async () => {
    const original = await readFile(siteFile(kit), "utf8");
    try {
      await writeFile(siteFile(kit), JSON.stringify(await withSite((s) => { delete s.requestEndpoint; })));
      const r = await buildSite(kit, { provider: null });
      assert.equal(pageData(await readFile(path.join(r.dir, "index.html"), "utf8")).catalog.requestEndpoint, undefined);
    } finally {
      await writeFile(siteFile(kit), original);
    }
  });

  it("proposes what follows in the catalog, row by row: videos and written guides alike, never an announced item", async () => {
    const original = await readFile(siteFile(kit), "utf8");
    try {
      await writeFile(siteFile(kit), JSON.stringify(await withSite((s) => {
        // a video in the last row, after the announced items: upload (video) → sharing (written guide) → upload-again (video)
        s.items.push({ id: "upload-again", row: "soon", status: "video", guide: "upload", title: { en: "Upload, once more", it: "Ancora un caricamento" } });
      })));
      const r = await buildSite(kit, { provider: null });
      const upload = pageData(await readFile(path.join(r.dir, "upload", "index.html"), "utf8"));
      assert.equal(upload.next.id, "sharing", "after a video, the written guide that follows it");
      assert.equal(upload.next.href, "../sharing/index.html");
      const sharing = pageData(await readFile(path.join(r.dir, "sharing", "index.html"), "utf8"));
      assert.deepEqual(sharing.next, { id: "upload-again", title: { en: "Upload, once more", it: "Ancora un caricamento" }, href: "../upload-again/index.html" }, "after a written guide, the next video, skipping announced items");
      const last = pageData(await readFile(path.join(r.dir, "upload-again", "index.html"), "utf8"));
      assert.equal(last.next, undefined, "the last page proposes nothing");
    } finally {
      await writeFile(siteFile(kit), original);
    }
  });

  it("says when the request endpoint must allow the site's origin", async () => {
    const site = Site.parse(await withSite((s) => { s.url = "https://help.example.org/docs/"; s.requestEndpoint = "https://api.example.org/requests"; }));
    const { warnings } = await validateSite(kit, site);
    assert.ok(warnings.some((w) => /must allow the origin https:\/\/help\.example\.org/.test(w)), warnings.join("; "));
  });
});

describe("check-endpoint", () => {
  const site = (extra: Record<string, unknown> = {}) =>
    Site.parse({ title: "T", url: "https://help.example.org", requestEndpoint: "https://api.example.org/requests", ...extra });
  const answer = (status: number, headers: Record<string, string>) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.method, "OPTIONS");
      assert.equal((init?.headers as Record<string, string>).Origin, "https://help.example.org");
      return new Response(null, { status, headers });
    }) as typeof fetch;

  it("reports a refused origin, with what to add", async () => {
    const r = await checkEndpoint(site(), answer(403, {}));
    assert.equal(r.ok, false);
    assert.match(r.message, /refuses requests from https:\/\/help\.example\.org.*add https:\/\/help\.example\.org/);
  });

  it("accepts the site's origin or any origin, with the Content-Type header", async () => {
    const ok = { "access-control-allow-origin": "https://help.example.org", "access-control-allow-headers": "Content-Type" };
    assert.equal((await checkEndpoint(site(), answer(204, ok))).ok, true);
    assert.equal((await checkEndpoint(site(), answer(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }))).ok, true);
    assert.equal((await checkEndpoint(site(), answer(204, { "access-control-allow-origin": "https://help.example.org" }))).ok, false, "the JSON body needs Content-Type");
  });

  it("needs no preflight on the same origin, and the site's url to check at all", async () => {
    const same = await checkEndpoint(site({ requestEndpoint: "https://help.example.org/api/requests" }), (() => assert.fail("no request")) as never);
    assert.equal(same.ok, true);
    await assert.rejects(checkEndpoint(site({ url: undefined })), /no url/);
  });
});
