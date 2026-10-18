import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, mock } from "node:test";
import { FantasticoError } from "@byte-42/fantastico-sdk";
import { initKit } from "../src/brief.ts";
import { openKit } from "../src/kit.ts";
import { startStudio } from "../src/studio.ts";
import { fantasticoClient } from "../src/tts.ts";

it("serves the Fantastico catalogue and cached previews, keeps the key secret, and preserves credit/authentication errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-fantastico-api-"));
  const oldKey = process.env.FANTASTICO_API_KEY;
  delete process.env.FANTASTICO_API_KEY;
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  try {
    const kit = openKit(root);
    await initKit(kit);
    await writeFile(path.join(root, ".env"), "OTHER_SETTING=preserve\n");
    studio = await startStudio(kit, { port: 4896, open: false });
    const headers = { "x-cueflow": "studio", "content-type": "application/json" };
    const post = (route: string, body: unknown) => fetch(studio!.url + route, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await (await fetch(studio.url + "api/credit")).json() as any).available, false);
    const key = "ck-fant-api-test-123456789";
    for (const invalid of ["sk-direct-provider-123456789", key + "\nOTHER_SETTING=bad"]) {
      assert.equal((await post("api/key", { key: invalid })).status, 400);
    }
    assert.deepEqual(await (await post("api/key", { key })).json(), { hasKey: true });
    assert.match(await readFile(path.join(root, ".env"), "utf8"), /OTHER_SETTING=preserve\nFANTASTICO_API_KEY=ck-fant-api-test-123456789/);
    assert.ok(!(await (await fetch(studio.url + "api/voices")).text()).includes(key));
    assert.ok(!(await (await fetch(studio.url + "api/state")).text()).includes(key));
    const account = fantasticoClient();
    const balance = mock.method(account, "balance", async () => ({ remainingUsd: 1.2345, lowBalance: false, status: "active" }));
    assert.deepEqual(await (await fetch(studio.url + "api/credit")).json(), { available: true, remainingUsd: 1.2345, lowBalance: false, status: "active" });
    balance.mock.mockImplementation(async () => ({ remainingUsd: 0, lowBalance: true, status: "active" }));
    assert.equal((await (await fetch(studio.url + "api/credit")).json() as any).remainingUsd, 0);
    const speech = account.audio.speech;
    mock.method(speech, "models", async () => [
      { id: "test/speech", name: "Test speech", supported_voices: ["Voice A", "Voice B"], pricing: { prompt: "0.1", completion: "0" } },
      { id: "test/reference", name: "Requires a reference recording" }
    ]);
    const models = await (await fetch(studio.url + "api/speech-models")).json() as any;
    assert.deepEqual(models.models.map((model: any) => [model.id, model.voices]), [["test/speech", ["Voice A", "Voice B"]]]);
    const create = mock.method(speech, "create", async () => ({ audio: new Uint8Array([0, 0, 1, 0]), contentType: "audio/pcm;rate=24000;channels=1" }));
    const sample = { voice: { provider: "fantastico", model: "test/speech", voice: "Voice A" }, text: "Hello", language: "en" };
    const preview = await post("api/voice-sample", sample);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type")!, /audio\/wav/);
    assert.equal(Buffer.from(await preview.arrayBuffer()).toString("ascii", 0, 4), "RIFF");
    assert.equal((await post("api/voice-sample", sample)).status, 200);
    assert.equal(create.mock.calls.length, 1);
    create.mock.mockImplementation(async () => { throw new FantasticoError("No allowance", "ALLOWANCE_EXHAUSTED", 402); });
    const exhausted = await post("api/voice-sample", { ...sample, text: "New narration" });
    assert.equal(exhausted.status, 402);
    const error = await exhausted.json() as any;
    assert.equal(error.rechargeUrl, "https://cueflow.fantastico.cc");
    assert.match(error.error, /credit exhausted/);
    assert.equal(error.code, "ALLOWANCE_EXHAUSTED");
    create.mock.mockImplementation(async () => { throw new FantasticoError("Invalid key", "UNAUTHORIZED", 401); });
    assert.equal((await post("api/voice-sample", { ...sample, text: "Another new narration" })).status, 401);
    assert.equal((await post("api/voice-sample", { ...sample, voice: { provider: "openai", voice: "coral" } })).status, 422);
    await post("api/key", { key: "sk-fant-prod-test-123456789" });
    const projectCredit = await (await fetch(studio.url + "api/credit")).json() as any;
    assert.equal(projectCredit.available, false);
    assert.match(projectCredit.reason, /project keys/);
  } finally {
    mock.restoreAll(); studio?.close();
    if (oldKey === undefined) delete process.env.FANTASTICO_API_KEY; else process.env.FANTASTICO_API_KEY = oldKey;
    await rm(root, { recursive: true, force: true });
  }
});
