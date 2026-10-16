import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { openKit, type Kit } from "../src/kit.ts";
import { Site } from "../src/schema.ts";
import { buildSite, checkEndpoint, itemDates, loadSite, siteFile, validateSite } from "../src/site.ts";

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

  it("gives quick access the most recent ready items by default, and keeps the catalog order when asked", async () => {
    const original = await readFile(siteFile(kit), "utf8");
    try {
      await writeFile(siteFile(kit), JSON.stringify(await withSite((s) => { s.items.find((i: any) => i.id === "sharing").added = "2026-05-01"; })));
      let cat = pageData(await readFile(path.join((await buildSite(kit, { provider: null })).dir, "index.html"), "utf8")).catalog;
      assert.deepEqual(cat.quickAccess, { order: "recent", max: 5 });
      const by = (id: string) => cat.items.find((i: { id: string }) => i.id === id);
      assert.equal(by("sharing").added, "2026-05-01", "an explicit date wins");
      assert.match(by("upload").added, /^\d{4}-\d{2}-\d{2}T/, "without one, the date of its guide");
      assert.equal(by("search").added, undefined, "an announced item has none");

      await writeFile(siteFile(kit), JSON.stringify(await withSite((s) => { s.quickAccess = { order: "catalog" }; })));
      cat = pageData(await readFile(path.join((await buildSite(kit, { provider: null })).dir, "index.html"), "utf8")).catalog;
      assert.deepEqual(cat.quickAccess, { order: "catalog", max: null });
      await writeFile(siteFile(kit), JSON.stringify(await withSite((s) => { s.quickAccess = false; })));
      cat = pageData(await readFile(path.join((await buildSite(kit, { provider: null })).dir, "index.html"), "utf8")).catalog;
      assert.equal(cat.quickAccess, false);
    } finally {
      await writeFile(siteFile(kit), original);
    }
  });

  it("dates an item by the commit that added its guide, and an uncommitted one as new", async (t) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_COMMITTER_DATE: "2025-03-04T10:00:00Z", GIT_AUTHOR_DATE: "2025-03-04T10:00:00Z" } });
    try { git("init", "-q"); } catch { return t.skip("git is not available"); }
    try {
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "guides/upload.json");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "upload");
      const dates = await itemDates(kit, await loadSite(kit));
      assert.equal(dates.upload, "2025-03-04T10:00:00.000Z");
      assert.ok(dates.sharing! > "2026", "its article is not committed: made now");
    } finally {
      await rm(path.join(dir, ".git"), { recursive: true, force: true });
    }
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
