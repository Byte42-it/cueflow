import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("refuses something that does not look like an OpenAI key", async () => {
    const r = await fetch(url + "api/key", { method: "POST", headers: H, body: JSON.stringify({ key: "hello" }) });
    assert.equal(r.status, 400);
  });
});
