import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { AgentBridge, callTimeoutMs } from "../src/agent.ts";
import { openKit } from "../src/kit.ts";
import { Guide, Step } from "../src/schema.ts";
import { videoAspect, videoPreset } from "../src/video.ts";

const guideWith = (stage: { width: number; height: number }, vertical = false) => Guide.parse({ id: "g", title: "G", scene: "s", vertical, stage });

it("knows 16:9, 9:16, 4:5 and 1:1 and keeps the old sizes", () => {
  assert.equal(videoAspect(guideWith({ width: 640, height: 360 })), "16:9");
  assert.equal(videoAspect(guideWith({ width: 640, height: 360 }, true)), "9:16");
  assert.equal(videoAspect(guideWith({ width: 1080, height: 1350 })), "4:5");
  assert.equal(videoAspect(guideWith({ width: 500, height: 500 })), "1:1");
  assert.deepEqual(videoPreset("large", "4:5"), { id: "large", label: "Large", width: 1080, height: 1350 });
  assert.deepEqual(videoPreset("large", "1:1"), { id: "large", label: "Large", width: 1080, height: 1080 });
  assert.deepEqual(videoPreset("small", true), videoPreset("small", "9:16"));
  assert.deepEqual(videoPreset("large"), { id: "large", label: "Large", width: 1920, height: 1080 });
  for (const size of ["large", "medium", "small"]) for (const a of ["16:9", "9:16", "4:5", "1:1"] as const) {
    const p = videoPreset(size, a);
    assert.ok(p.width % 2 === 0 && p.height % 2 === 0, "yuv420p needs even sizes");
  }
});

it("refuses a shape it cannot make instead of cropping", () => {
  assert.throws(() => videoAspect(guideWith({ width: 640, height: 400 })), /supports 16:9, 9:16, 4:5 and 1:1/);
  assert.throws(() => videoPreset("small", "3:2" as "1:1"), /aspect must be/);
});

it("accepts a scene transition on a step and rejects nonsense", () => {
  assert.deepEqual(Step.parse({ id: "a", transition: {} }).transition, { effect: "fade", duration: 500 });
  assert.equal(Step.safeParse({ id: "a", transition: { effect: "wipe" } }).success, false);
});

it("gives a call through the agent door more than the SDK's 60 seconds", async () => {
  assert.equal(callTimeoutMs({}), 3600000);
  assert.equal(callTimeoutMs({ CUEFLOW_AGENT_CALL_TIMEOUT_MS: "90000" }), 90000);
  const seen: unknown[] = [];
  const dir = await mkdtemp(path.join(tmpdir(), "cueflow-door-"));
  const bridge = new AgentBridge(openKit(dir));
  (bridge as unknown as { client: unknown }).client = Promise.resolve({ callTool: async (_p: unknown, _s: unknown, options: unknown) => { seen.push(options); return { content: [{ type: "text", text: "ok" }] }; } });
  assert.deepEqual((await bridge.call("anything", {})).result, "ok");
  assert.ok((seen[0] as { timeout: number }).timeout > 60000);
  await rm(dir, { recursive: true, force: true });
});
