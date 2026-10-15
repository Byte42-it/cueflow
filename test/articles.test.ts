import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { catalogOverview, createArticle, deleteItem, readArticle, startTranslation, updateItem, writeArticle } from "../src/articles.ts";
import { pendingChanges } from "../src/changes.ts";
import { openKit, type Kit } from "../src/kit.ts";
import { siteFile } from "../src/site.ts";

let dir: string;
let kit: Kit;
const exists = (f: string) => stat(f).then(() => true, () => false);
const site = async () => JSON.parse(await readFile(siteFile(kit), "utf8"));

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-articles-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), dir, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(dir);
});
after(() => rm(dir, { recursive: true, force: true }));

describe("written guides", () => {
  it("lists every item of the dashboard with the languages its text exists in", async () => {
    const c = await catalogOverview(kit);
    assert.ok(c.exists);
    const sharing = c.items.find((i) => i.id === "sharing")!;
    assert.equal(sharing.status, "guide");
    assert.equal(sharing.files.en, true);
    assert.deepEqual(c.rows.map((r) => r.id), ["ready", "soon"]);
  });

  it("creates a written guide with a first section, and refuses a bad or taken id", async () => {
    await createArticle(kit, { id: "billing", title: "Paying an invoice", desc: "From the invoice to the receipt." });
    const item = (await site()).items.find((i: any) => i.id === "billing");
    assert.equal(item.status, "guide");
    assert.equal(item.row, "ready", "the first row that is not a band");
    assert.match(await readFile(path.join(dir, "pages", "billing.html"), "utf8"), /<section id="intro" data-title="Paying an invoice">/);
    await assert.rejects(createArticle(kit, { id: "billing", title: "Again" }), /already has/);
    await assert.rejects(createArticle(kit, { id: "Bad Id", title: "x" }), /lowercase/);
  });

  it("saves a guide, refuses a stale save, and leaves a note for the assistant", async () => {
    const a = await readArticle(kit, "billing", "en");
    assert.equal(a.exists, true);
    const html = `<section id="intro" data-title="Paying"><h2>Paying</h2><p>Open the invoice.</p></section>`;
    const r = await writeArticle(kit, "billing", "en", html, a.version);
    assert.match(await readFile(path.join(dir, "pages", "billing.html"), "utf8"), /Open the invoice\./);
    await assert.rejects(writeArticle(kit, "billing", "en", html + "<p>x</p>", a.version), /changed on disk/);
    await writeArticle(kit, "billing", "en", html.replace("Open", "First open"), r.version);
    assert.ok((await pendingChanges(kit)).some((c) => c.kind === "article" && c.target === "billing"));
  });

  it("starts a translation from the site's own language, in pages/<lang>/", async () => {
    const t = await startTranslation(kit, "billing", "it");
    assert.equal(t.exists, true);
    assert.equal(t.file, path.join("pages", "it", "billing.html"));
    await assert.rejects(startTranslation(kit, "billing", "it"), /already exists/);
    await assert.rejects(startTranslation(kit, "billing", "en"), /own language/);
  });

  it("changes the texts of one language and keeps the others", async () => {
    await updateItem(kit, "billing", { lang: "it", texts: { title: "Pagare una fattura" } });
    const item = (await site()).items.find((i: any) => i.id === "billing");
    assert.deepEqual(item.title, { en: "Paying an invoice", it: "Pagare una fattura" });
  });

  it("turns a coming-soon item into a written guide with a first section, and never touches a video's status", async () => {
    await updateItem(kit, "search", { status: "guide" });
    assert.equal((await site()).items.find((i: any) => i.id === "search").status, "guide");
    assert.ok(await exists(path.join(dir, "pages", "search.html")));
    await assert.rejects(updateItem(kit, "upload", { status: "guide" }), /plays a video/);
  });

  it("moves an item within its row", async () => {
    const order = async () => (await site()).items.filter((i: any) => i.row === "ready").map((i: any) => i.id);
    const before = await order();
    const last = before[before.length - 1];
    await updateItem(kit, last, { move: -1 });
    const now = await order();
    assert.equal(now[now.length - 2], last);
  });

  it("takes a guide off the dashboard and moves its texts to the trash, but not a video", async () => {
    const r = await deleteItem(kit, "billing");
    assert.ok(r.trash);
    assert.ok(!(await exists(path.join(dir, "pages", "billing.html"))));
    const trashed = await readdir(path.join(dir, r.trash!, "pages"));
    assert.ok(trashed.includes("billing.html") && trashed.includes("it"));
    assert.ok(!(await site()).items.some((i: any) => i.id === "billing"));
    await assert.rejects(deleteItem(kit, "upload"), /plays a video/);
  });
});
