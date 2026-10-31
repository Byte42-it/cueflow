import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rename, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderGuideHtml } from "./build.ts";
import { loadGuide, type Kit } from "./kit.ts";
import { launchChromium } from "./preview.ts";

const require = createRequire(import.meta.url);
const bundledFFmpegDir = path.dirname(require.resolve("ffmpeg-static"));
const run = promisify(execFile);
const FPS = 25;

/** Windows package managers do not always add FFmpeg to the current process's PATH. */
export async function windowsFFmpegCandidates(env: NodeJS.ProcessEnv): Promise<string[]> {
  const candidates: string[] = [];
  if (env.LOCALAPPDATA) {
    const packages = path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
    candidates.push(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe"));
    for (const name of await readdir(packages).catch(() => [] as string[])) {
      if (!/ffmpeg/i.test(name)) continue;
      const root = path.join(packages, name);
      candidates.push(path.join(root, "bin", "ffmpeg.exe"));
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) candidates.push(path.join(root, entry.name, "bin", "ffmpeg.exe"));
      }
    }
  }
  if (env.USERPROFILE) candidates.push(path.join(env.USERPROFILE, "scoop", "apps", "ffmpeg", "current", "bin", "ffmpeg.exe"));
  if (env.ChocolateyInstall) candidates.push(path.join(env.ChocolateyInstall, "bin", "ffmpeg.exe"));
  return candidates;
}

/** Pick a binary for the running OS, even when Windows and WSL share node_modules. */
export async function resolveFFmpeg(): Promise<string> {
  const override = process.env.CUEFLOW_FFMPEG;
  const native = path.join(bundledFFmpegDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const candidates = override ? [override] : [native, "ffmpeg"];
  const failures: string[] = [];
  const attempt = async (candidate: string) => {
    try {
      await run(candidate, ["-version"], { timeout: 15000, windowsHide: true });
      return candidate;
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      failures.push(`${candidate}: ${e.killed ? "timed out" : e.code ?? e.message.split("\n")[0]}`);
      return null;
    }
  };
  for (const candidate of candidates) {
    const found = await attempt(candidate);
    if (found) return found;
  }
  if (!override && process.platform === "win32") {
    for (const candidate of await windowsFFmpegCandidates(process.env)) {
      const found = await attempt(candidate);
      if (found) return found;
    }
  }
  const advice = override
    ? "Could not start the executable configured in CUEFLOW_FFMPEG. Check its path or remove the setting to use Cueflow's bundled FFmpeg."
    : "Could not start FFmpeg. Set CUEFLOW_FFMPEG to a working executable.";
  throw new Error(`${advice} Runtime: ${process.platform}/${process.arch}. Attempts: ${failures.join("; ")}`);
}

export const VIDEO_PRESETS = {
  large: { label: "Large", width: 1920, height: 1080 },
  medium: { label: "Medium", width: 1280, height: 720 },
  small: { label: "Small", width: 854, height: 480 }
} as const;

export function videoPreset(size: unknown = "medium", vertical = false) {
  if (typeof size !== "string" || !Object.hasOwn(VIDEO_PRESETS, size)) throw new Error("MP4 size must be large, medium or small.");
  const preset = { id: size as keyof typeof VIDEO_PRESETS, ...VIDEO_PRESETS[size as keyof typeof VIDEO_PRESETS] };
  return vertical ? { ...preset, width: preset.height, height: preset.width } : preset;
}

export type VideoProgress = { percent: number; phase: string };

/** Render the actual player, then combine its frames with each step's recorded narration. */
export async function buildVideo(kit: Kit, id: string, lang: string, onProgress: (progress: VideoProgress) => void = () => {}, opts: { size?: unknown } = {}) {
  onProgress({ percent: 0, phase: "Preparing tutorial and audio…" });
  const guide = await loadGuide(kit, id);
  const preset = videoPreset(opts.size, guide.vertical);
  const renderViewport = guide.vertical ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
  if (!guide.languages.includes(lang)) throw new Error(`Unknown tutorial language: ${lang}`);
  if (!guide.steps.length) throw new Error("Add at least one step before exporting MP4.");
  const ffmpeg = await resolveFFmpeg();
  const browser = await launchChromium(lang);
  const temp = await mkdtemp(path.join(tmpdir(), "cueflow-video-"));
  try {
    let prepared = 0;
    const { html, bundle } = await renderGuideHtml(kit, id, undefined, {
      lang,
      onProgress: (done, total) => { prepared = Math.round((done / Math.max(1, total)) * 4); onProgress({ percent: prepared, phase: `Voices and narrator clips: ${done} of ${total} step(s) ready…` }); },
      onPhase: (phase) => onProgress({ percent: prepared, phase })
    });
    await writeFile(path.join(temp, "player.html"), html);
    onProgress({ percent: 5, phase: "Opening tutorial…" });
    const page = await browser.newPage({ viewport: renderViewport, deviceScaleFactor: preset.width / renderViewport.width, locale: lang });
    await page.addInitScript(() => { Object.defineProperty(window, "speechSynthesis", { value: undefined }); });
    await page.goto(pathToFileURL(path.join(temp, "player.html")).href);
    await page.waitForFunction("!!window.__cueflow && !window.__cueflow.state().loading");
    await page.addStyleTag({ content: `html,body{margin:0!important;padding:0!important} .cf-app{width:${renderViewport.width}px!important;max-width:none!important} .cf-bar,.cf-big,.cf-veil{display:none!important} .cf-stage{height:${renderViewport.height}px!important;aspect-ratio:auto!important;border-radius:0!important} .cf-captions-below .cf-subs{display:block!important}` });
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    onProgress({ percent: 8, phase: "Measuring tutorial duration…" });
    const stepFrames: number[] = [];
    for (let i = 0; i < guide.steps.length; i++) {
      const timing = await page.evaluate(async ({ i, lang }) => (window as any).__cueflow.seek(i, 0, lang), { i, lang });
      stepFrames.push(Math.max(1, Math.ceil(timing.total / 40)));
    }
    const totalFrames = stepFrames.reduce((a, b) => a + b, 0);
    let lastPercent = -1;
    const rendering = (step: number, force = false) => {
      const percent = Math.floor(10 + 80 * frame / totalFrames);
      if (force || percent !== lastPercent) {
        lastPercent = percent;
        onProgress({ percent, phase: `Rendering step ${step + 1} of ${guide.steps.length}…` });
      }
    };
    let frame = 0;
    const segments: string[] = [];
    const warnings = [...bundle.warnings];
    for (let i = 0; i < guide.steps.length; i++) {
      rendering(i, true);
      await page.evaluate(async ({ i, lang }) => {
        const p = (window as any).__cueflow;
        return await p.seek(i, 0, lang);
      }, { i, lang });
      const frames = stepFrames[i]!;
      const seconds = frames / FPS;
      const sound = bundle.data.audio[lang]?.[guide.steps[i]!.id];
      const audio = path.join(temp, `audio-${i}.wav`);
      if (sound) {
        const input = path.join(temp, `source-${i}`);
        await writeFile(input, Buffer.from(sound.split(",")[1]!, "base64"));
        await run(ffmpeg, ["-y", "-i", input, "-af", "apad", "-t", String(seconds), "-ar", "48000", "-ac", "2", audio]);
      } else {
        await run(ffmpeg, ["-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(seconds), audio]);
      }
      segments.push(`file 'audio-${i}.wav'`);
      // The browser clock keeps animations and the captured frames on the same timeline.
      await page.evaluate("window.__cueflow.play()");
      for (let f = 0; f < frames; f++) {
        await page.locator(".cf-stage").screenshot({ path: path.join(temp, `frame-${String(frame++).padStart(8, "0")}.png`), animations: "allow" });
        rendering(i);
        if (f + 1 < frames) await page.clock.runFor(40);
      }
      await page.evaluate("window.__cueflow.pause()");
    }
    if (guide.steps.some((step) => !bundle.data.audio[lang]?.[step.id])) warnings.push("Steps without recorded audio are silent in MP4. Choose a generated voice or upload narration to include speech; browser speech cannot be exported.");
    await writeFile(path.join(temp, "audio.txt"), segments.join("\n"));
    await mkdir(kit.out, { recursive: true });
    const name = `${guide.id}.${encodeURIComponent(lang)}.${preset.id}.mp4`;
    const file = path.join(kit.out, name);
    const pending = path.join(kit.out, `.${name}.${path.basename(temp)}.mp4`);
    try {
      onProgress({ percent: 90, phase: "Encoding MP4…" });
      const encoding = run(ffmpeg, ["-y", "-progress", "pipe:1", "-nostats", "-framerate", String(FPS), "-i", path.join(temp, "frame-%08d.png"), "-f", "concat", "-safe", "0", "-i", path.join(temp, "audio.txt"), "-vf", `scale=${preset.width}:${preset.height}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", pending], { maxBuffer: 8 * 1024 * 1024 });
      let progressBuffer = "";
      encoding.child.stdout?.on("data", (chunk: Buffer) => {
        progressBuffer += chunk.toString();
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^frame=(\d+)/.exec(line);
          if (match) onProgress({ percent: Math.min(99, 90 + Math.floor(9 * Number(match[1]) / totalFrames)), phase: "Encoding MP4…" });
        }
      });
      await encoding;
      onProgress({ percent: 99, phase: "Saving MP4…" });
      await rename(pending, file);
    } finally { await rm(pending, { force: true }); }
    onProgress({ percent: 100, phase: "MP4 ready" });
    return { file, name, warnings };
  } finally {
    await browser.close();
    await rm(temp, { recursive: true, force: true });
  }
}
