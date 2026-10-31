import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FantasticoError, type Fantastico, type SpeechCreateParams } from "@byte-42/fantastico-sdk";
import { openKit } from "../src/kit.ts";
import { resolveFFmpeg } from "../src/video.ts";
import { VoiceSpec } from "../src/settings.ts";
import { defaultProvider, fantasticoProvider, narrationAudio, speechWav } from "../src/tts.ts";
import { voiceOptions } from "../src/voices.ts";

const key = "ck-fant-test-123456789";
const options = { model: "test/speech", voice: "TestVoice", style: "Friendly" };
const pcm = new Uint8Array([0, 0, 1, 0]);
const result = { audio: pcm, contentType: "audio/pcm;rate=24000;channels=1", model: options.model, generationId: null };
const client = (create: Fantastico["audio"]["speech"]["create"]): Pick<Fantastico, "audio"> => ({
  audio: { speech: { create, models: async () => [] } }
});

describe("Fantastico professional voices", () => {
  it("requires an explicit model and voice, and offers Fantastico as the only paid service", () => {
    assert.equal(defaultProvider({ FANTASTICO_API_KEY: key }), null);
    assert.throws(() => defaultProvider({ CUEFLOW_TTS: "openai", OPENAI_API_KEY: "old-key" }), /unknown CUEFLOW_TTS/);
    assert.throws(() => fantasticoProvider({ FANTASTICO_API_KEY: key }), /Choose a Fantastico speech model and voice/);
    assert.equal(VoiceSpec.safeParse({ provider: "fantastico", voice: "TestVoice" }).success, false);
    assert.equal(VoiceSpec.safeParse({ provider: "openai", voice: "coral" }).success, false);
    assert.equal(VoiceSpec.safeParse({ provider: "fantastico", ...options, style: key }).success, false);
    assert.deepEqual(voiceOptions({}).filter((option) => option.cost !== "free").map((option) => option.provider), ["fantastico", "narrator"], "both paid through Fantastico");
  });

  it("passes the selected model, voice, language and style through the SDK and caches playable audio", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cueflow-fantastico-"));
    try {
      const requests: SpeechCreateParams[] = [];
      const provider = fantasticoProvider({ FANTASTICO_API_KEY: key }, options, () => client(async (params) => { requests.push(params); return result; }))!;
      const kit = openKit(dir);
      const audio = await narrationAudio(kit, provider, "Hello", "it");
      assert.equal(audio.toString("ascii", 0, 4), "RIFF");
      assert.equal(audio.readUInt32LE(24), 24000);
      assert.deepEqual(audio.subarray(44), Buffer.from(pcm));
      assert.deepEqual(await narrationAudio(kit, provider, "Hello", "it"), audio);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.model, options.model);
      assert.equal(requests[0]!.voice, options.voice);
      assert.equal(requests[0]!.input, "Hello");
      assert.match(requests[0]!.instructions!, /Italian.*Friendly/);
      assert.equal(requests[0]!.response_format, undefined, "let the model return its supported format");
      assert.ok(!provider.fingerprint.includes(key));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns a 402 with the recharge link for exhausted account or project credit", async () => {
    for (const code of ["ALLOWANCE_EXHAUSTED", "PROJECT_FUNDS_EXHAUSTED"]) {
      const provider = fantasticoProvider({ FANTASTICO_API_KEY: key }, options, () => client(async () => { throw new FantasticoError("Account empty", code, 402); }))!;
      await assert.rejects(provider.synthesize("Hello", "en"), (error: unknown) => {
        assert.ok(error instanceof FantasticoError);
        assert.equal(error.status, 402);
        assert.equal(error.code, code);
        assert.match(error.message, /credit exhausted.*https:\/\/cueflow\.fantastico\.cc/);
        return true;
      });
    }
  });

  it("does not turn authentication failures into credit errors", async () => {
    const error = new FantasticoError("Invalid key", "UNAUTHORIZED", 401);
    const provider = fantasticoProvider({ FANTASTICO_API_KEY: key }, options, () => client(async () => { throw error; }))!;
    await assert.rejects(provider.synthesize("Hello", "en"), (actual) => actual === error);
  });

  it("converts model MP3 responses into playable WAV using bundled FFmpeg", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cueflow-fantastico-mp3-"));
    try {
      const input = path.join(dir, "input.wav"), output = path.join(dir, "output.mp3");
      await writeFile(input, await speechWav(new Uint8Array(4800), "audio/pcm;rate=24000;channels=1"));
      await promisify(execFile)(await resolveFFmpeg(), ["-y", "-i", input, output]);
      const wav = await speechWav(await readFile(output), "audio/mpeg");
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.toString("ascii", 8, 12), "WAVE");
      assert.ok(wav.length > 44);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects malformed PCM metadata and empty SDK audio", async () => {
    await assert.rejects(speechWav(pcm, "audio/pcm"), /sample rate or channels/);
    await assert.rejects(speechWav(pcm, "application/json"), /unsupported audio/);
    const provider = fantasticoProvider({ FANTASTICO_API_KEY: key }, options, () => client(async () => ({ ...result, audio: new Uint8Array() })))!;
    await assert.rejects(provider.synthesize("Hello", "en"), /empty audio/);
  });
});
