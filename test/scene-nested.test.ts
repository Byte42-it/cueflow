import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { openKit, type Kit } from "../src/kit.ts";
import { inlineScene } from "../src/scene.ts";

let dir: string;
let kit: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-nested-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), path.join(dir, "demo"), { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(path.join(dir, "demo"));
});
after(() => rm(dir, { recursive: true, force: true }));

describe("a captured frame holding another frame", () => {
  it("keeps every level of escaping through the build", async () => {
    const inner = `<p title="deep">hello</p>`;
    const middle = `<iframe id="in" srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
    const outer = middle.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    await writeFile(path.join(kit.root, "scenes", "nested.html"), `<!doctype html><html><body><iframe id="out" srcdoc="${outer}"></iframe></body></html>`);
    const html = await inlineScene(kit, "nested");
    const first = parseHTML(html).document.querySelector("#out")!.getAttribute("srcdoc")!;
    const second = parseHTML(`<!doctype html><html><body>${first}</body></html>`).document.querySelector("#in")!.getAttribute("srcdoc");
    assert.equal(second, inner);
  });
});
