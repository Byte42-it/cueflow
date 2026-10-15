import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { initKit } from "../src/brief.ts";
import { openKit } from "../src/kit.ts";
import { startStudio } from "../src/studio.ts";

let dir: string;
let url: string;
let close: () => void;
const H = { "x-cueflow": "studio", "content-type": "application/json" };

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-studio-"));
  const root = path.join(dir, ".cueflow");
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), root, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  const kit = openKit(root);
  await initKit(kit);
  ({ url, close } = await startStudio(kit, { port: 4400 + Math.floor(Math.random() * 400), open: false }));
});
after(async () => {
  close();
  await rm(dir, { recursive: true, force: true });
});

describe("studio", () => {
  it("serves the page and the state of the kit", async () => {
    assert.match(await (await fetch(url)).text(), /Cueflow/);
    const st = (await (await fetch(url + "api/state")).json()) as any;
    assert.equal(st.guides[0].id, "upload");
    assert.equal(st.guides[0].steps.length, 4);
  });

  it("previews a video and a scene as pages", async () => {
    assert.match(await (await fetch(url + "preview/upload?lang=en")).text(), /__cueflow|Cueflow/);
    assert.match(await (await fetch(url + "scene/upload")).text(), /Drag your files here/);
  });

  it("saves a step's narration, validating it first, and refuses a stale or invalid save", async () => {
    const { guide, version } = (await (await fetch(url + "api/guide/upload")).json()) as any;
    guide.steps[0].narration.en = "A new first sentence.";
    const ok = await fetch(url + "api/guide/upload", { method: "PUT", headers: H, body: JSON.stringify({ guide, version }) });
    assert.equal(ok.status, 200);
    assert.match(await readFile(path.join(dir, ".cueflow", "guides", "upload.json"), "utf8"), /A new first sentence\./);

    const stale = await fetch(url + "api/guide/upload", { method: "PUT", headers: H, body: JSON.stringify({ guide, version }) });
    assert.equal(stale.status, 409);

    const fresh = (await (await fetch(url + "api/guide/upload")).json()) as any;
    fresh.guide.steps[0].camera = { target: "#does-not-exist" };
    const bad = await fetch(url + "api/guide/upload", { method: "PUT", headers: H, body: JSON.stringify({ guide: fresh.guide, version: fresh.version }) });
    assert.equal(bad.status, 422);
    assert.match(JSON.stringify(await bad.json()), /does-not-exist/);
  });

  it("chooses voices at a level and reports where each video's voice comes from", async () => {
    const r = await fetch(url + "api/voice", { method: "POST", headers: H, body: JSON.stringify({ scope: "language", language: "it", voice: { provider: "none" } }) });
    assert.equal(r.status, 200);
    const { table } = (await r.json()) as any;
    assert.deepEqual(table.find((x: any) => x.language === "it"), { guide: "upload", language: "it", provider: "none", from: "language" });
  });

  it("does not let a page from elsewhere drive it", async () => {
    assert.equal((await fetch(url + "api/voice", { method: "POST", body: "{}" })).status, 403);
    const port = new URL(url).port;
    const status = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/state", headers: { host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
    assert.equal(status, 403);
  });

  it("gives the timeline its estimated lengths and the actions of each step", async () => {
    const st = (await (await fetch(url + "api/state")).json()) as any;
    const g = st.guides[0];
    assert.equal(g.timing.en.length, g.steps.length);
    assert.ok(g.timing.en[0].total > g.timing.en[0].narration - 1);
    assert.ok(g.steps[0].actions.length > 0 && g.steps[0].actions[0].do);
  });

  it("lists the elements of a scene and saves the brief", async () => {
    const els = (await (await fetch(url + "api/elements/upload")).json()) as any[];
    assert.ok(els.some((e) => e.selector === "#nav-documents"));
    const r = await fetch(url + "api/brief", { method: "POST", headers: H, body: JSON.stringify({ tone: "calm", rules: ["no real data"] }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).tone, "calm");
  });

  it("creates a video, refuses a duplicate and an unknown scene", async () => {
    const make = (body: object) => fetch(url + "api/guide-create", { method: "POST", headers: H, body: JSON.stringify(body) });
    assert.equal((await make({ id: "second", title: "Second", scene: "upload", languages: ["en"] })).status, 200);
    assert.equal((await make({ id: "second", title: "Second", scene: "upload" })).status, 409);
    assert.equal((await make({ id: "third", title: "Third", scene: "nope" })).status, 400);
  });

  it("checks a video and builds it, then serves what was built", async () => {
    const check = await (await fetch(url + "api/check", { method: "POST", headers: H, body: JSON.stringify({ guide: "upload" }) })).json() as any;
    assert.deepEqual(check.errors, []);
    const built = await (await fetch(url + "api/build", { method: "POST", headers: H, body: JSON.stringify({ target: "guide", guide: "upload" }) })).json() as any;
    assert.equal(built.url, "/out/upload.html");
    assert.match(await (await fetch(url + "out/upload.html")).text(), /Cueflow/);
    assert.equal((await fetch(url + "out/..%2fcueflow.json")).status, 403);
  });

  it("tells the media of a tutorial from the media shared by all, and takes uploads and deletions", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const up = (q: string) => fetch(url + "api/media-file?" + q, { method: "POST", headers: { "x-cueflow": "studio" }, body: png });
    assert.equal((await up("area=media&guide=upload&name=logo.png")).status, 200);
    assert.equal((await up("area=shared&guide=upload&name=icon.png")).status, 200);
    assert.equal((await up("area=media&guide=upload&name=..%2Fevil.png")).status, 400);
    assert.equal((await up("area=media&guide=upload&name=run.exe")).status, 400);
    const m = (await (await fetch(url + "api/media/upload")).json()) as any;
    assert.ok(m.media.files.some((f: any) => f.name === "logo.png"));
    assert.ok(m.shared.files.some((f: any) => f.name === "icon.png") && m.shared.files.some((f: any) => f.name === "style.css"));
    // an earlier test made a second tutorial on the same screen: the screen is now used by two, so it is shared
    assert.ok(m.shared.scenes.some((s: any) => s.name === "upload" && s.usedBy.length === 2));
    assert.equal(m.media.scenes.length, 0);
    assert.equal((await fetch(url + "files/media/upload/logo.png")).headers.get("content-type"), "image/png");
    const style = m.shared.files.find((f: any) => f.name === "style.css");
    assert.deepEqual([...style.usedBy].sort(), ["second", "upload"]);
    const del = (name: string, area = "shared") => fetch(url + `api/media-file?area=${area}&guide=upload&name=${name}`, { method: "DELETE", headers: { "x-cueflow": "studio" } });
    assert.equal((await del("style.css")).status, 409, "a file that a scene uses is not deleted");
    assert.equal((await del("logo.png", "media")).status, 200);
    assert.equal((await del("icon.png")).status, 200);
  });

  it("exports the whole system: every tutorial and a dashboard that lists them, creating the catalog when there is none", async () => {
    await fs.rm(path.join(dir, ".cueflow", "site.json"), { force: true });
    const r = (await (await fetch(url + "api/export-all", { method: "POST", headers: H, body: "{}" })).json()) as any;
    assert.equal(r.url, "/out/site/index.html");
    assert.equal(r.siteCreated, true);
    assert.ok(r.guides.some((g: any) => g.id === "upload"));
    const site = JSON.parse(await readFile(path.join(dir, ".cueflow", "site.json"), "utf8"));
    assert.ok(site.items.some((i: any) => i.guide === "upload"));
    assert.match(await (await fetch(url + "out/site/index.html")).text(), /cf-home/);
  });

  it("edits the text of an element in one language only, and tells the assistant what changed", async () => {
    const post = (path: string, body: object) => fetch(url + path, { method: "POST", headers: H, body: JSON.stringify(body) });
    const r = await post("api/scene-edit", { scene: "upload", lang: "it", selector: "#choose-file", text: "Seleziona un file", tutorial: "upload" });
    assert.equal(r.status, 200);
    const it = await readFile(path.join(dir, ".cueflow", "scenes", "it", "upload.html"), "utf8");
    assert.match(it, /Seleziona un file/);
    assert.doesNotMatch(await readFile(path.join(dir, ".cueflow", "scenes", "upload.html"), "utf8"), /Seleziona un file/, "the base screen is untouched");
    assert.match(await (await fetch(url + "scene/upload?lang=it")).text(), /Seleziona un file/);
    assert.match(await (await fetch(url + "scene/upload?lang=en")).text(), /Choose a file/);
    const notes = (await (await fetch(url + "api/changes")).json()) as any[];
    const n = notes.find((c) => c.kind === "element-text" && c.after === "Seleziona un file");
    assert.equal(n.lang, "it");
    assert.match(n.sentence, /#choose-file.*Seleziona un file/s);
    // a copy made from the base screen keeps its stylesheet: its paths go one folder up
    const fresh = await post("api/scene-edit", { scene: "upload", lang: "fr", selector: "#choose-file", text: "Choisir un fichier" });
    assert.equal(fresh.status, 200);
    assert.match(await readFile(path.join(dir, ".cueflow", "scenes", "fr", "upload.html"), "utf8"), /href="\.\.\/\.\.\/shared\/style\.css"/);
    assert.match(await (await fetch(url + "scene/upload?lang=fr")).text(), /Choisir un fichier/);
    // the selector must match one element
    assert.equal((await post("api/scene-edit", { scene: "upload", lang: "it", selector: "button", text: "x" })).status, 422);
    assert.equal((await post("api/scene-edit", { scene: "upload", lang: "it", selector: "#choose-file", attrs: { onclick: "x" } })).status, 422);
  });

  it("notes the narration and title changes made in the timeline, and the dashboard texts", async () => {
    const { guide, version } = (await (await fetch(url + "api/guide/upload")).json()) as any;
    guide.steps[1].narration.en = "A different second step.";
    assert.equal((await fetch(url + "api/guide/upload", { method: "PUT", headers: H, body: JSON.stringify({ guide, version }) })).status, 200);
    const site = await fetch(url + "api/site-text", { method: "POST", headers: H, body: JSON.stringify({ id: "upload", field: "desc", lang: "en", value: "New description." }) });
    assert.equal(site.status, 200);
    const notes = (await (await fetch(url + "api/changes")).json()) as any[];
    assert.ok(notes.some((c) => c.kind === "narration" && c.lang === "en" && c.after === "A different second step."));
    assert.ok(notes.some((c) => c.kind === "catalog" && c.after === "New description."));
    assert.ok(notes.every((c) => !(c.kind === "title") ), "an unchanged title is not a note");
  });

  it("replaces and edits files, and notes it", async () => {
    const css = Buffer.from("body{color:red}");
    const rep = await fetch(url + "api/media-file?area=shared&guide=upload&name=style.css", { method: "POST", headers: { "x-cueflow": "studio" }, body: css });
    assert.equal(((await rep.json()) as any).replaced, true);
    const ed = await fetch(url + "api/media-text?area=shared&guide=upload&name=style.css", { method: "PUT", headers: { "x-cueflow": "studio" }, body: "body{color:blue}" });
    assert.equal(ed.status, 200);
    const notes = (await (await fetch(url + "api/changes")).json()) as any[];
    assert.ok(notes.some((c) => c.kind === "file-replaced" && /style\.css/.test(c.target)));
    assert.ok(notes.some((c) => c.kind === "file-edited"));
    assert.equal((await fetch(url + "api/media-text?area=shared&guide=upload&name=a.png", { method: "PUT", headers: { "x-cueflow": "studio" }, body: "x" })).status, 400);
  });

  it("refuses something that does not look like an OpenAI key", async () => {
    const r = await fetch(url + "api/key", { method: "POST", headers: H, body: JSON.stringify({ key: "hello" }) });
    assert.equal(r.status, 400);
  });
});
