import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { initKit, kitStatus, loadBrief, updateBrief } from "../src/brief.ts";
import { loadGuide, openKit, saveGuide, type Kit } from "../src/kit.ts";
import { METHOD } from "../src/method.ts";
import { validateGuide } from "../src/validate.ts";

let dir: string;
let kit: Kit;
let empty: Kit;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cueflow-brief-"));
  await cp(path.join(import.meta.dirname, "..", "examples", "demo-kit"), path.join(dir, "demo"), { recursive: true, filter: (s) => !/[\\/](dist|audio)([\\/]|$)/.test(s) });
  kit = openKit(path.join(dir, "demo"));
  empty = openKit(path.join(dir, "new"));
});
after(() => rm(dir, { recursive: true, force: true }));

describe("onboarding", () => {
  it("walks a new kit from 'which site?' to the catalog", async () => {
    await initKit(empty, "Acme");
    let s = await kitStatus(empty);
    assert.equal(s.brief.site, "Acme");
    assert.match(s.next, /which site/i);

    await updateBrief(empty, { source: { type: "url", url: "https://example.com" } });
    assert.match((await kitStatus(empty)).next, /brief/i);

    await updateBrief(empty, { audience: "office staff", tone: "calm", languages: ["en"] });
    s = await kitStatus(empty);
    assert.match(s.next, /capture\.json/);
  });

  it("merges pronunciation and replaces lists", async () => {
    await updateBrief(empty, { pronunciation: { SQL: "sequel" }, rules: ["a"] });
    await updateBrief(empty, { pronunciation: { PEC: "pek" }, rules: ["b"] });
    const b = await loadBrief(empty);
    assert.deepEqual(b.pronunciation, { SQL: "sequel", PEC: "pek" });
    assert.deepEqual(b.rules, ["b"]);
  });

  it("rejects a brief that is not valid with a readable message", async () => {
    await assert.rejects(updateBrief(empty, { source: { type: "url", url: "not an address" } }), /url/i);
  });

  it("the method does not name any product", () => {
    assert.doesNotMatch(METHOD, /saul|\bsol\b|h2o/i);
  });
});

describe("quality warnings", () => {
  it("asks to split a step with more than two sentences and a tutorial over the brief's length", async () => {
    const guide = await loadGuide(kit, "upload");
    const first = guide.steps[0]!;
    first.narration = { en: "One. Two. Three. Four." };
    await saveGuide(kit, guide);
    await updateBrief(kit, { maxSeconds: 5 });
    const report = await validateGuide(kit, await loadGuide(kit, "upload"));
    assert.ok(report.warnings.some((w) => /more than two sentences/.test(w)));
    assert.ok(report.warnings.some((w) => /split it into two tutorials/.test(w)));
    assert.equal(report.errors.length, 0);
  });
});

describe("the prompt for an assistant", () => {
  it("on a first start says how to begin: method, brief, ask which site", async () => {
    const { agentPrompt } = await import("../src/prompt.ts");
    const fresh = openKit(path.join(dir, "first"));
    await initKit(fresh);
    const p = await agentPrompt(fresh);
    assert.match(p, /There is no tutorial yet/);
    assert.match(p, /get_method/);
    assert.match(p, /which site/i);
    assert.match(p, /claude mcp add cueflow -- node ".*" mcp --kit ".*first"/);
  });

  it("later says where things stand, so a new session carries on", async () => {
    const { agentPrompt } = await import("../src/prompt.ts");
    await updateBrief(kit, { audience: "office staff", languages: ["en", "it"] });
    const p = await agentPrompt(kit, { guide: "upload", step: 1, lang: "it" });
    assert.match(p, /do not start over/);
    assert.match(p, /upload: .*How to upload a document/);
    assert.match(p, /Audience: office staff/);
    assert.match(p, /tutorial "upload", step 2 \(choose\), language it/);
    assert.match(p, /get_brief/);
  });
});
