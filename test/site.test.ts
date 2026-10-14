import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { openKit, type Kit } from "../src/kit.ts";
import { Site } from "../src/schema.ts";
import { buildSite, loadSite, siteFile, validateSite } from "../src/site.ts";

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
    assert.deepEqual(upload.chapters, ["Where documents live", "Choose the file", "Give it a title", "Upload"], "chapters come from the guide's step titles");
    assert.equal(home.catalog.items.find((i: { id: string }) => i.id === "search").href, undefined, "an announced item has no page");
  });

  it("puts the guide, the article and its index on the item page", async () => {
    const html = await readFile(path.join(kit.root, "dist", "site", "upload", "index.html"), "utf8");
    const data = pageData(html);
    assert.equal(data.guide.guide.id, "upload");
    assert.deepEqual(
      data.sections.map((s: { id: string; subs: { id: string }[] }) => [s.id, s.subs.map((x) => x.id)]),
      [["files", ["files-types", "files-size"]], ["after", ["after-rename"]]]
    );
    const tag = /<section[^>]*id="files"[^>]*>/.exec(html)?.[0] ?? "";
    assert.match(tag, /class="cf-section"/);
    assert.match(tag, /data-title="Which files"/);
    assert.ok(!/<\/script><b>/.test(html));
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
});
