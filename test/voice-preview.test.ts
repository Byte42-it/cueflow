import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { initKit } from "../src/brief.ts";
import { openKit } from "../src/kit.ts";
import { launchChromium } from "../src/preview.ts";
import { startStudio } from "../src/studio.ts";
import { speechWav } from "../src/tts.ts";

it("connects Fantastico in general settings, previews selected voices, links to recharge and saves the voice", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-voice-ui-"));
  const oldKey = process.env.FANTASTICO_API_KEY;
  delete process.env.FANTASTICO_API_KEY;
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
  try {
    const kit = openKit(root);
    await initKit(kit);
    studio = await startStudio(kit, { port: 4895, open: false });
    browser = await launchChromium("en");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Exercise the UI and local persistence without spending real credit or depending on an audio device.
    await page.addInitScript(() => {
      const state = window as unknown as { voicePlays: number; voicePauses: number };
      state.voicePlays = 0; state.voicePauses = 0;
      HTMLMediaElement.prototype.play = async function () { state.voicePlays++; };
      HTMLMediaElement.prototype.pause = function () { state.voicePauses++; };
    });
    let creditReads = 0;
    await page.route("**/api/credit", (route) => {
      creditReads++;
      return route.fulfill({ json: { available: true, remainingUsd: 0.125, lowBalance: true, status: "active" } });
    });
    await page.route("**/api/speech-models", (route) => route.fulfill({ json: { models: [
      { id: "test/first", name: "First speech model", voices: ["Alpha", "Beta"] },
      { id: "test/second", name: "Second speech model", voices: ["Gamma", "Delta"] }
    ] } }));
    const requests: any[] = [];
    let exhausted = true;
    const wav = await speechWav(new Uint8Array([0, 0, 1, 0]), "audio/pcm;rate=24000;channels=1");
    await page.route("**/api/voice-sample", (route) => {
      requests.push(route.request().postDataJSON());
      return exhausted
        ? route.fulfill({ status: 402, json: { error: "Fantastico credit exhausted. Recharge your credit at https://cueflow.fantastico.cc", code: "ALLOWANCE_EXHAUSTED", rechargeUrl: "https://cueflow.fantastico.cc" } })
        : route.fulfill({ contentType: "audio/wav", body: wav });
    });
    await page.goto(studio.url);
    await page.locator("#project").click();
    const audio = page.getByRole("region", { name: "General audio settings" });
    assert.equal(await audio.getByRole("checkbox", { name: /^Auto:/ }).count(), 0);
    await audio.getByRole("radio", { name: /Professional voices/ }).waitFor();
    assert.equal(await audio.locator('[aria-label="Fantastico API key"]').isVisible(), false);
    await audio.getByRole("radio", { name: /Professional voices/ }).check();
    assert.equal(await audio.getByRole("radio", { name: /macOS|Use the level above/ }).count(), 0);
    assert.equal(await audio.getByRole("button", { name: "Preview", exact: true }).count(), 1);
    assert.equal(await audio.getByRole("link", { name: "Get a key or recharge credit" }).getAttribute("href"), "https://cueflow.fantastico.cc");
    const key = "ck-fant-ui-test-123456789";
    await audio.getByLabel("Fantastico API key", { exact: true }).fill(key);
    await audio.getByRole("button", { name: "Connect and load voices" }).click();
    await audio.getByRole("combobox", { name: "Fantastico speech model" }).selectOption("test/second");
    await audio.getByRole("combobox", { name: "Fantastico voice", exact: true }).selectOption("Delta");
    await audio.getByPlaceholder("How it should speak, e.g. calm and professional").fill("Friendly");
    assert.equal(requests.length, 0);
    assert.match(await readFile(path.join(root, ".env"), "utf8"), /FANTASTICO_API_KEY=ck-fant-ui-test-123456789/);
    assert.equal(await audio.getByLabel("Fantastico API key", { exact: true }).inputValue(), "********");
    await audio.getByRole("status").filter({ hasText: "Remaining credit:" }).waitFor();
    assert.match(await audio.getByRole("status").innerText(), /0\.125.*Low credit/);
    assert.equal(await audio.locator('a[href="https://cueflow.fantastico.cc"]').count(), 1);
    const beforeRefresh = creditReads;
    await audio.getByRole("button", { name: "Refresh credit", exact: true }).click();
    await audio.getByRole("status").filter({ hasText: "Remaining credit:" }).waitFor();
    assert.ok(creditReads > beforeRefresh);
    assert.ok(await audio.getByLabel("Fantastico API key", { exact: true }).evaluate((input: HTMLInputElement) => input.readOnly));
    await audio.getByRole("button", { name: "Change", exact: true }).click();
    await audio.getByLabel("Fantastico API key", { exact: true }).fill("ck-fant-unsaved-replacement");
    await audio.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await audio.getByLabel("Fantastico API key", { exact: true }).inputValue(), "********");
    await audio.getByRole("button", { name: "Preview", exact: true }).first().click();
    await audio.locator(".msg.err").filter({ hasText: "Fantastico credit exhausted" }).waitFor();
    assert.equal(await audio.locator('a[href="https://cueflow.fantastico.cc"]').count(), 1);
    assert.deepEqual(requests[0].voice, { provider: "fantastico", model: "test/second", voice: "Delta", style: "Friendly" });
    exhausted = false;
    await audio.getByRole("button", { name: "Preview", exact: true }).first().click();
    await page.waitForFunction(() => (window as unknown as { voicePlays: number }).voicePlays === 1);
    await audio.getByRole("button", { name: "Stop", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as unknown as { voicePauses: number }).voicePauses), 1);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/voice") && response.status() === 200),
      audio.getByRole("button", { name: "Save", exact: true }).click()
    ]);
    const saved = JSON.parse(await readFile(path.join(root, "cueflow.json"), "utf8"));
    assert.deepEqual(saved.voices.default, requests[0].voice);
    assert.ok(!JSON.stringify(saved).includes(key));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); studio?.close();
    if (oldKey === undefined) delete process.env.FANTASTICO_API_KEY; else process.env.FANTASTICO_API_KEY = oldKey;
    await rm(root, { recursive: true, force: true });
  }
});


it("uses one Auto for the selected tutorial language and shows that voice in step Auto", { skip: !process.env.CUEFLOW_TEST_BROWSER, timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueflow-auto-voice-"));
  let studio: Awaited<ReturnType<typeof startStudio>> | undefined;
  let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
  try {
    await mkdir(path.join(root, "guides"));
    await mkdir(path.join(root, "scenes"));
    await writeFile(path.join(root, "scenes", "screen.html"), '<h1 id="heading">Demo</h1>');
    await writeFile(path.join(root, "cueflow.json"), JSON.stringify({ voices: { default: { provider: "fantastico", model: "heygen/voice", voice: "rosanna" } } }));
    await writeFile(path.join(root, "guides", "demo.json"), JSON.stringify({ id: "demo", title: "Demo", scene: "screen", languages: ["en", "it"], steps: [{ id: "intro", narration: { en: "Demo narration", it: "Narrazione demo" }, actions: [] }] }));
    studio = await startStudio(openKit(root), { port: 4898, open: false });
    browser = await launchChromium("en");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/speech-models", (route) => route.fulfill({ json: { models: [{ id: "heygen/voice", name: "HeyGen voice", voices: ["rosanna"] }] } }));
    await page.goto(studio.url);
    await page.locator('[data-page="voice"]').click();
    const main = page.locator("#voice-body .lvl");
    const auto = () => main.getByRole("checkbox", { name: "Auto: HeyGen: rosanna", exact: true });
    await auto().waitFor();
    assert.equal(await main.count(), 1);
    assert.equal(await page.locator("#voice-body").getByRole("checkbox").count(), 1);
    assert.ok(await auto().isChecked());
    assert.equal(await main.getByRole("radio").count(), 0);
    await page.locator("#lang").selectOption("it");
    await main.getByRole("heading", { name: "Voice · “it”", exact: true }).waitFor();
    await auto().uncheck();
    await main.getByRole("radio", { name: /^Silent/ }).check();
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/voice") && r.ok()), main.getByRole("button", { name: "Save", exact: true }).click()]);
    await main.getByRole("radio", { name: /^Silent/ }).waitFor();
    assert.ok(!await auto().isChecked());
    await page.locator("#lang").selectOption("en");
    await main.getByRole("heading", { name: "Voice · “en”", exact: true }).waitFor();
    assert.ok(await auto().isChecked());
    assert.equal(await main.getByRole("radio").count(), 0);
    await page.locator("#lang").selectOption("it");
    await main.getByRole("heading", { name: "Voice · “it”", exact: true }).waitFor();
    assert.ok(!await auto().isChecked());
    await page.locator('[data-page="timeline"]').click();
    await page.locator('[data-tab="voice"]').click();
    const step = page.locator("#panel");
    await step.getByRole("checkbox", { name: "Auto: Silent", exact: true }).uncheck();
    await step.getByRole("radio", { name: /^Browser voice/ }).check();
    await step.getByRole("button", { name: "Save", exact: true }).click();
    await step.getByText("Saved: this step has its own voice.", { exact: true }).waitFor();
    const stepAuto = step.getByRole("checkbox", { name: "Auto: Silent", exact: true });
    assert.ok(!await stepAuto.isChecked());
    await stepAuto.check();
    await step.getByText("This step follows the tutorial's voice again.", { exact: true }).waitFor();
    assert.ok(await stepAuto.isChecked());
    await page.locator('[data-page="voice"]').click();
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/voice") && r.ok()), auto().check()]);
    await main.getByRole("heading", { name: "Voice · “it”", exact: true }).waitFor();
    assert.ok(await auto().isChecked());
    await page.locator('[data-page="timeline"]').click();
    await page.locator('[data-tab="voice"]').click();
    await step.getByRole("checkbox", { name: "Auto: HeyGen: rosanna", exact: true }).waitFor();
    const settings = JSON.parse(await readFile(path.join(root, "cueflow.json"), "utf8"));
    assert.equal(settings.voices.guides.demo, undefined);
    const guide = JSON.parse(await readFile(path.join(root, "guides", "demo.json"), "utf8"));
    assert.equal(guide.steps[0].voice, undefined);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); studio?.close();
    await rm(root, { recursive: true, force: true });
  }
});
