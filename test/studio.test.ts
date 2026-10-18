import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
let token: string;
let bridge: { lastSeen: number };
const H = { "x-cueflow": "studio", "content-type": "application/json" };

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-studio-"));
  const root = path.join(dir, ".cueflow");
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), root, { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  const kit = openKit(root);
  await initKit(kit);
  ({ url, close, link: { token }, bridge } = await startStudio(kit, { port: 4400 + Math.floor(Math.random() * 400), open: false }));
});
after(async () => {
  close();
  await rm(dir, { recursive: true, force: true });
});

describe("studio", () => {
  it("offers three video sizes and rejects invalid export sizes", async () => {
    const st = await (await fetch(url + "api/state")).json() as any;
    assert.equal(st.videoPresets.large.width, 1920);
    assert.equal(st.videoPresets.medium.width, 1280);
    assert.equal(st.videoPresets.small.width, 854);
    const response = await fetch(url + "api/export-mp4", { method: "POST", headers: H, body: JSON.stringify({ guide: "upload", lang: "en", size: "huge", progress: true }) });
    assert.equal(response.status, 400);
    assert.match((await response.json() as any).error, /size must be/);
  });

  it("streams MP4 progress and reports export errors in the stream", async () => {
    const response = await fetch(url + "api/export-mp4", { method: "POST", headers: H, body: JSON.stringify({ guide: "upload", lang: "unknown", progress: true }) });
    assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].progress.percent, 0);
    assert.match(events.at(-1).error, /Unknown tutorial language/);
  });

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

  it("undoes and redoes camera edits and refuses to overwrite external changes", async () => {
    const current = await (await fetch(url + "api/guide/upload")).json() as any;
    const original = current.guide;
    const changed = structuredClone(original);
    changed.steps[0].camera = { target: "body", padding: 0 };
    const save = await fetch(url + "api/guide/upload", { method: "PUT", headers: H, body: JSON.stringify({ guide: changed, version: current.version }) });
    assert.equal(save.status, 200);
    const move = (direction: string) => fetch(url + "api/history", { method: "POST", headers: H, body: JSON.stringify({ guide: "upload", direction }) });
    assert.equal((await move("undo")).status, 200);
    let loaded = await (await fetch(url + "api/guide/upload")).json() as any;
    assert.deepEqual(loaded.guide.steps[0].camera, original.steps[0].camera);
    assert.equal(loaded.history.redo, "Change camera framing");
    assert.equal((await move("redo")).status, 200);
    loaded = await (await fetch(url + "api/guide/upload")).json() as any;
    assert.deepEqual(loaded.guide.steps[0].camera, changed.steps[0].camera);
    assert.equal((await move("undo")).status, 200);
    const file = path.join(dir, ".cueflow", "guides", "upload.json");
    const restored = await readFile(file, "utf8");
    await fs.writeFile(file, restored + "\n");
    assert.equal((await move("redo")).status, 409);
    assert.equal(await readFile(file, "utf8"), restored + "\n");
    await fs.writeFile(file, restored);
    assert.equal((await move("invalid")).status, 400);
  });

  it("chooses voices at a level and reports where each video's voice comes from", async () => {
    const r = await fetch(url + "api/voice", { method: "POST", headers: H, body: JSON.stringify({ scope: "language", language: "it", voice: { provider: "none" } }) });
    assert.equal(r.status, 200);
    const { table } = (await r.json()) as any;
    assert.deepEqual(table.find((x: any) => x.language === "it"), { guide: "upload", language: "it", provider: "none", from: "language" });
  });

  it("lets you listen to a narration with the voice and pronunciation of the tutorial", async () => {
    await fetch(url + "api/brief", { method: "POST", headers: H, body: JSON.stringify({ pronunciation: { Acme: "Ack-mee" } }) });
    const en = await fetch(url + "api/listen", { method: "POST", headers: H, body: JSON.stringify({ guide: "upload", language: "en", text: "Open Acme." }) });
    assert.deepEqual(await en.json(), { browser: true, silent: false, text: "Open Ack-mee." }, "en has the browser's voice");
    const it = await fetch(url + "api/listen", { method: "POST", headers: H, body: JSON.stringify({ guide: "upload", language: "it", text: "Apri Acme." }) });
    assert.equal(((await it.json()) as any).silent, true, "it was set to no voice above");
    assert.equal((await fetch(url + "api/listen", { method: "POST", headers: H, body: JSON.stringify({ guide: "nope", language: "en", text: "x" }) })).ok, false);
  });

  it("deletes notes for the assistant one by one or all together, keeping the edits", async () => {
    const before = (await (await fetch(url + "api/changes")).json()) as any[];
    const { guide, version } = (await (await fetch(url + "api/guide/upload")).json()) as any;
    guide.steps[1].narration.en = "Another sentence for the second step.";
    await fetch(url + "api/guide/upload", { method: "PUT", headers: H, body: JSON.stringify({ guide, version }) });
    const notes = (await (await fetch(url + "api/changes")).json()) as any[];
    assert.ok(notes.length > before.length);
    const one = notes[notes.length - 1].id;
    await fetch(url + "api/changes/discard", { method: "POST", headers: H, body: JSON.stringify({ ids: [one] }) });
    assert.ok(!((await (await fetch(url + "api/changes")).json()) as any[]).some((c) => c.id === one));
    await fetch(url + "api/changes/discard", { method: "POST", headers: H, body: JSON.stringify({ all: true }) });
    assert.deepEqual(await (await fetch(url + "api/changes")).json(), []);
    assert.match(await readFile(path.join(dir, ".cueflow", "guides", "upload.json"), "utf8"), /Another sentence for the second step\./, "the edit stays");
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
    const saved = JSON.parse(await readFile(path.join(dir, ".cueflow", "guides", "second.json"), "utf8"));
    assert.equal(saved.vertical, false);
    assert.equal((await make({ id: "portrait", title: "Portrait", scene: "upload", vertical: true })).status, 200);
    const portrait = JSON.parse(await readFile(path.join(dir, ".cueflow", "guides", "portrait.json"), "utf8"));
    assert.equal(portrait.vertical, true);
    assert.deepEqual(portrait.viewport, { width: 720, height: 1280 });
    assert.deepEqual(portrait.stage, { width: 360, height: 640 });
    for (const id of ["portrait", "second", "upload"]) {
      const current = await (await fetch(url + "api/guide/" + id)).json() as any;
      const response = await fetch(url + "api/guide/" + id, { method: "PUT", headers: H, body: JSON.stringify({ ...current, guide: { ...current.guide, vertical: !current.guide.vertical } }) });
      assert.equal(response.status, 400);
      assert.match((await response.json() as any).error, /orientation is fixed at creation/);
    }
    const built = await (await fetch(url + "preview/portrait")).text();
    assert.match(built, /"viewport":\{"width":720,"height":1280\}/);
    assert.match(built, /"stage":\{"width":360,"height":640\}/);
    await fs.unlink(path.join(dir, ".cueflow", "guides", "portrait.json"));
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

  it("shows the project, not the kit, and lets the person choose where the files go", async () => {
    const post = (outDir: string) => fetch(url + "api/out-dir", { method: "POST", headers: H, body: JSON.stringify({ outDir }) });
    const state = async () => await (await fetch(url + "api/state")).json() as any;
    const before = await state();
    assert.equal(before.projectRoot, path.dirname(before.kitRoot)); // the folder that holds .cueflow
    assert.equal(before.outDirShown, "cueflow-dist"); // typed and shown relative to the project
    assert.equal((await post("published")).status, 200);
    const moved = await state();
    assert.equal(moved.outDirShown, "published");
    assert.equal(moved.outDir, path.join(moved.projectRoot, "published"));
    assert.equal((await post(".cueflow")).status, 400); // the kit itself would be overwritten
    assert.equal((await post(".")).status, 400); // so would the folder that holds it
    assert.equal((await post("")).status, 200); // empty = the default again
    assert.equal((await state()).outDirShown, "cueflow-dist");
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
    assert.equal((await post("api/history", { guide: "upload", direction: "undo" })).status, 200);
    assert.doesNotMatch(await (await fetch(url + "scene/upload?lang=it")).text(), /Seleziona un file/);
    assert.match(await (await fetch(url + "scene/upload?lang=en")).text(), /Choose a file/);
    assert.equal((await post("api/history", { guide: "upload", direction: "redo" })).status, 200);
    assert.equal(await readFile(path.join(dir, ".cueflow", "scenes", "it", "upload.html"), "utf8"), it);
    // a copy made from the base screen keeps its stylesheet: its paths go one folder up
    const fresh = await post("api/scene-edit", { scene: "upload", lang: "fr", selector: "#choose-file", text: "Choisir un fichier" });
    assert.equal(fresh.status, 200);
    assert.match(await readFile(path.join(dir, ".cueflow", "scenes", "fr", "upload.html"), "utf8"), /href="\.\.\/\.\.\/shared\/style\.css"/);
    assert.match(await (await fetch(url + "scene/upload?lang=fr")).text(), /Choisir un fichier/);
    // the selector must match one element
    assert.equal((await post("api/scene-edit", { scene: "upload", lang: "it", selector: "button", text: "x" })).status, 422);
    assert.equal((await post("api/scene-edit", { scene: "upload", lang: "it", selector: "#choose-file", attrs: { onclick: "x" } })).status, 422);
  });

  it("deletes scene elements with undo/redo and protects page roots and animation targets", async () => {
    const scene = "delete-demo", file = path.join(dir, ".cueflow", "scenes", scene + ".html");
    const html = '<html><head></head><body><main id="frame"><h1 id="heading">Delete me</h1><p>Keep me</p></main></body></html>';
    await fs.writeFile(file, html);
    const post = (path: string, body: object) => fetch(url + path, { method: "POST", headers: H, body: JSON.stringify(body) });
    const patch = { tutorial: "upload", scene, lang: "en", selector: "#heading", remove: true };
    assert.equal((await post("api/scene-edit", patch)).status, 200);
    assert.equal(await readFile(file, "utf8"), html);
    assert.doesNotMatch(await (await fetch(url + "scene/" + scene + "?lang=en")).text(), /Delete me/);
    assert.equal((await post("api/history", { guide: "upload", direction: "undo" })).status, 200);
    assert.match(await (await fetch(url + "scene/" + scene + "?lang=en")).text(), /Delete me/);
    await assert.rejects(readFile(path.join(dir, ".cueflow", "scenes", "en", scene + ".html")), { code: "ENOENT" });
    assert.equal((await post("api/history", { guide: "upload", direction: "redo" })).status, 200);
    assert.doesNotMatch(await (await fetch(url + "scene/" + scene + "?lang=en")).text(), /Delete me/);
    const root = await post("api/scene-edit", { ...patch, selector: "body" });
    assert.equal(root.status, 422);
    const referenced = await post("api/scene-edit", { ...patch, scene: "upload", selector: "#choose-file" });
    assert.equal(referenced.status, 422);
    assert.match((await referenced.json() as any).error, /used by tutorial/);
    await fs.unlink(file);
    await fs.unlink(path.join(dir, ".cueflow", "scenes", "en", scene + ".html"));
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

  it("hands out a prompt for the assistant that knows what is selected", async () => {
    const r = (await (await fetch(url + "api/agent-prompt?guide=upload&step=2&lang=en")).json()) as any;
    assert.match(r.prompt, /Carry on from here/);
    assert.match(r.prompt, /step 3/);
  });

  it("deletes a tutorial into the trash, and takes it out of the dashboard", async () => {
    const make = await fetch(url + "api/guide-create", { method: "POST", headers: H, body: JSON.stringify({ id: "gone", title: "To delete", scene: "upload", languages: ["en"] }) });
    assert.equal(make.status, 200);
    await fetch(url + "api/export-all", { method: "POST", headers: H, body: "{}" }); // puts it in the catalog
    assert.ok(JSON.parse(await readFile(path.join(dir, ".cueflow", "site.json"), "utf8")).items.some((i: any) => i.guide === "gone"));
    const r = await fetch(url + "api/guide/gone", { method: "DELETE", headers: H });
    assert.equal(r.status, 200);
    const out = (await r.json()) as any;
    assert.match(out.trash, /^trash\/.*-gone$/);
    assert.deepEqual(out.removedFromCatalog, ["gone"]);
    assert.ok(await fs.stat(path.join(dir, ".cueflow", out.trash, "gone.json")), "the guide is kept in the trash");
    assert.equal((await fetch(url + "api/guide/gone")).status, 500, "and is gone from the kit");
    assert.ok(!JSON.parse(await readFile(path.join(dir, ".cueflow", "site.json"), "utf8")).items.some((i: any) => i.guide === "gone"));
    assert.equal((await fetch(url + "api/guide/gone", { method: "DELETE", headers: H })).status, 404);
  });

  it("is a door for an assistant that uses curl: a key, the tools, and the same results as MCP", async () => {
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(url + "agent/help")).status, 401, "without the key nothing opens");
    assert.equal((await fetch(url + "agent/help", { headers: { authorization: "Bearer nope" } })).status, 401);
    const help = await (await fetch(url + "agent/help", { headers: auth })).text();
    assert.match(help, /agent\/next/);
    assert.match(await (await fetch(url + "agent/method", { headers: auth })).text(), /How to make tutorials/);
    const tools = (await (await fetch(url + "agent/tools", { headers: auth })).json()) as any[];
    assert.ok(["get_brief", "create_guide", "create_article", "write_article", "get_changes"].every((n) => tools.some((t) => t.name === n)));
    const call = (name: string, body: object = {}) => fetch(url + "agent/call/" + name, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<any>;
    const brief = await call("get_brief");
    assert.equal(brief.ok, true);
    assert.ok(JSON.parse(brief.result).guides.includes("upload"));
    const bad = await call("add_step", { guide: "upload", step: { id: "x", camera: { target: "#nope" }, actions: [], narration: {} } });
    assert.equal(bad.ok, false, "a step on something that does not exist is refused, as over MCP");
    const art = await call("create_article", { id: "from-curl", title: "From curl", status: "guide" });
    assert.equal(art.ok, true);
    assert.match((await call("read_article", { id: "from-curl", lang: "en" })).result, /From curl/);
  });

  it("talks both ways: Studio sends a request to a waiting assistant, which answers", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const st = (path: string, body?: object) => fetch(url + path, { method: body ? "POST" : "GET", headers: { ...auth, "x-cueflow": "studio", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    // nobody waits yet (the calls of the test before do not count any more): the page is told to fall back to copy and paste
    bridge.lastSeen = 0;
    const early = await st("api/agent/send", { text: "hello" });
    assert.equal(early.status, 409);
    assert.equal(((await (await st("api/agent")).json()) as any).connected, false);

    const waiting = fetch(url + "agent/next?wait=20", { headers: auth }).then((r) => r.json()) as Promise<any>;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(((await (await st("api/agent")).json()) as any).connected, true, "an assistant that waits is connected");
    const sent = await st("api/agent/send", { request: { kind: "video", title: "Send an invoice", languages: ["en"] } });
    assert.equal(sent.status, 200);
    const { task } = await waiting;
    assert.match(task.prompt, /NEW REQUEST: I want a new VIDEO tutorial/);
    assert.match(task.prompt, /title: Send an invoice/);
    assert.match(task.prompt, /ask me/i);
    await st("agent/say", { text: "reading the site", task: task.id });
    await st("agent/done", { task: task.id, summary: "made it" });
    const state = (await (await st("api/agent")).json()) as any;
    assert.equal(state.tasks.at(-1).status, "done");
    assert.ok(state.log.some((l: any) => l.text === "reading the site"));
  });

  it("builds the prompts the page copies: a request for each kind of thing, with the way to connect", async () => {
    const r = (await (await fetch(url + "api/agent/request-prompt", { method: "POST", headers: H, body: JSON.stringify({ request: { kind: "guide", title: "Billing" } }) })).json()) as any;
    assert.match(r.prompt, /WRITTEN guide/);
    assert.match(r.prompt, new RegExp(`Bearer ${token}`));
    assert.match(r.prompt, /\.mcp\.json/);
    assert.match(r.prompt, /BEFORE you create anything, ask me/);
  });

  it("reorders the dashboard by dragging, and the built site follows", async () => {
    await fetch(url + "api/export-all", { method: "POST", headers: H, body: "{}" });
    const siteFile = path.join(dir, ".cueflow", "site.json");
    const items = () => (JSON.parse(readFileSync(siteFile, "utf8")).items as any[]);
    const ids = items().map((i) => i.id);
    assert.ok(ids.length >= 3);
    const reversed = [...ids].reverse();
    const r = await fetch(url + "api/order", { method: "POST", headers: H, body: JSON.stringify({ ids: reversed }) });
    assert.equal(r.status, 200);
    assert.deepEqual(items().map((i) => i.id), reversed);
    await fetch(url + "api/build", { method: "POST", headers: H, body: JSON.stringify({ target: "site" }) });
    const home = await (await fetch(url + "out/site/index.html")).text();
    const data = JSON.parse(/window\.CUEFLOW_SITE = (\{.*\});<\/script>/s.exec(home)![1]!.replace(/\\u003c/g, "<"));
    assert.deepEqual(data.catalog.items.map((i: any) => i.id), reversed, "the home page lists them in the order chosen");
    // dropped in another row: the item moves to it
    const raw = JSON.parse(readFileSync(siteFile, "utf8"));
    raw.rows.push({ id: "later", title: "Later" });
    await fs.writeFile(siteFile, JSON.stringify(raw));
    const rows = raw.rows as any[];
    const moved = items().find((i) => i.row !== rows[1].id)!;
    const r2 = await fetch(url + "api/order", { method: "POST", headers: H, body: JSON.stringify({ ids: items().map((i) => i.id), moved: moved.id, row: rows[1].id }) });
    assert.equal(r2.status, 200);
    assert.equal(items().find((i) => i.id === moved.id)!.row, rows[1].id);
    assert.equal((await fetch(url + "api/order", { method: "POST", headers: H, body: JSON.stringify({ ids: ["x"], moved: moved.id, row: "nope" }) })).status, 400);
    const notes = (await (await fetch(url + "api/changes")).json()) as any[];
    assert.ok(notes.some((c) => c.kind === "catalog" && c.target === "order"), "the assistant is told the order changed");
  });

  it("refuses something that does not look like a Fantastico key", async () => {
    const r = await fetch(url + "api/key", { method: "POST", headers: H, body: JSON.stringify({ key: "hello" }) });
    assert.equal(r.status, 400);
  });
});
