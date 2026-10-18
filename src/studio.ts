import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArticleError, catalogOverview, createArticle, deleteItem, readArticle, reorderItems, startTranslation, updateItem, writeArticle } from "./articles.ts";
import { Brief, loadBrief, updateBrief } from "./brief.ts";
import { buildGuide, estimateStepDuration, renderGuideHtml, writeAtomic } from "./build.ts";
import { checkLayout } from "./layout.ts";
import { buildVideo, VIDEO_PRESETS, videoPreset } from "./video.ts";
import { buildShare } from "./share.ts";
import { buildSite, loadSite, setSiteText, siteFile, syncSite } from "./site.ts";
import { loadTheme } from "./theme.ts";
import { describeChange, discardChanges, pendingChanges, recordChange } from "./changes.ts";
import { checkForUpdate, type UpdateInfo } from "./update.ts";
import { agentPrompt, pasteLine, requestPrompt, type NewRequest, type StudioLink } from "./prompt.ts";
import { AgentBridge } from "./agent.ts";
import { METHOD } from "./method.ts";
import { deleteTutorial } from "./trash.ts";
import { StudioHistory, HistoryConflict } from "./history.ts";
import { editSceneElement } from "./sceneedit.ts";
import { deleteMediaFile, mediaOverview, saveMediaFile, areaDir, safeRel, type Area } from "./media.ts";
import { defaultOutDir, listGuides, listScenes, loadGuide, openKit, outDirSetting, projectRoot, readScene, saveGuide, guideFile, sceneFile, type Kit } from "./kit.ts";
import { describeScene, inlineScene } from "./scene.ts";
import { Guide, orientedGuide, pick } from "./schema.ts";
import { FantasticoError } from "@byte-42/fantastico-sdk";
import { keyCredit, speechModels, FANTASTICO_PORTAL, narrationAudio, providerFromSpec, audioMime, spokenText } from "./tts.ts";
import { VoiceSpec } from "./settings.ts";
import { validateGuide } from "./validate.ts";
import { readFile as read } from "node:fs/promises";
import { readRawSettings, setVoice, stepAudio, voiceFor, voiceOptions, voiceTable, writeRawSettings } from "./voices.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS: Record<string, [string, string]> = {
  "/": ["studio.html", "text/html; charset=utf-8"],
  "/studio.js": ["studio.js", "text/javascript; charset=utf-8"],
  "/studio.css": ["studio.css", "text/css; charset=utf-8"]
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res: ServerResponse, value: unknown, status = 200) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5_000_000) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "the request is not valid JSON");
  }
}

async function readRaw(req: IncomingMessage, max = 25_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, "the file is larger than 25 MB");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A file name from the page, or a 400 that says what is wrong with it. */
function cleanName(raw: string): string {
  try {
    return safeRel(raw);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}

const mtime = (file: string) => stat(file).then((s) => s.mtimeMs, () => 0);

/** What changed on disk, as one string: when it differs from the last one, somebody (an assistant, an editor) edited the kit. */
async function signature(kit: Kit): Promise<string> {
  const parts: string[] = [];
  for (const dir of ["guides", "scenes", "scenes/it", "scenes/en"]) {
    for (const f of await readdir(path.join(kit.root, dir)).catch(() => [] as string[])) parts.push(`${dir}/${f}:${await mtime(path.join(kit.root, dir, f))}`);
  }
  // the written guides too: pages/ and its language folders
  for (const e of await readdir(path.join(kit.root, "pages"), { withFileTypes: true }).catch(() => [])) {
    const rel = path.join("pages", e.name);
    if (e.isDirectory()) for (const f of await readdir(path.join(kit.root, rel)).catch(() => [] as string[])) parts.push(`${rel}/${f}:${await mtime(path.join(kit.root, rel, f))}`);
    else parts.push(`${rel}:${await mtime(path.join(kit.root, rel))}`);
  }
  for (const f of ["cueflow.json", "brief.json", "changes.json", "site.json"]) parts.push(`${f}:${await mtime(path.join(kit.root, f))}`);
  return parts.join("|");
}

async function state(kit: Kit) {
  const guides = [];
  for (const id of await listGuides(kit)) {
    const g = await loadGuide(kit, id).catch(() => null);
    if (!g) continue;
    // estimated lengths (ms) per language, as the player computes them for a silent build: the timeline is drawn from these
    const timing: Record<string, { narration: number; total: number }[]> = {};
    for (const lang of g.languages) timing[lang] = g.steps.map((s) => estimateStepDuration(s, lang));
    guides.push({ id, title: g.title, languages: g.languages, scene: g.scene, vertical: g.vertical, viewport: orientedGuide(g).viewport, timing, steps: g.steps.map((s) => ({ id: s.id, title: s.title ?? null, narration: s.narration, actions: s.actions.map((a) => ({ do: a.do, at: "at" in a ? a.at : 0, duration: "duration" in a ? a.duration : undefined })) })) });
  }
  return { videoPresets: VIDEO_PRESETS, kitRoot: kit.root, projectRoot: projectRoot(kit), outDir: kit.out, outDirShown: path.relative(projectRoot(kit), kit.out).split(path.sep).join("/") || ".", defaultOutDirShown: path.relative(projectRoot(kit), path.resolve(kit.root, defaultOutDir(kit))).split(path.sep).join("/"), brief: await loadBrief(kit), pending: (await pendingChanges(kit)).length, guides, scenes: await listScenes(kit), hasKey: Boolean(process.env.FANTASTICO_API_KEY), catalog: await catalogOverview(kit).catch((e) => ({ exists: false as const, error: e instanceof Error ? e.message : String(e) })) };
}

/**
 * The page a written guide is edited in: the docs site's own stylesheet and the kit's theme, so what is written looks
 * as it will be read. Relative images resolve against pages/ (or pages/<lang>/) through /kit/.
 */
async function articleFrame(kit: Kit, lang: string | undefined) {
  const site = await loadSite(kit);
  const siteCss = await readFile(path.join(here, "site", "site.css"), "utf8");
  const theme = await loadTheme(kit);
  const base = !lang || lang === site.lang ? "/kit/pages/" : `/kit/pages/${lang}/`;
  const links = site.stylesheets.map((h) => `<link rel="stylesheet" href="${h.replace(/"/g, "&quot;")}">`).join("");
  return `<!doctype html><html lang="${lang ?? site.lang}"><head><meta charset="utf-8"><base href="${base}">${links}
<style>${siteCss}</style><style>${theme.css}</style>
<style>
html, body { min-height: 100%; }
body.cf-site { display: block; }
.cf-main { max-width: 860px; margin: 0 auto; padding: 28px 36px 120px; }
.cf-article section { display: block !important; }
[contenteditable], [contenteditable]:focus { outline: none !important; box-shadow: none !important; }
[contenteditable]:empty::before { content: attr(data-placeholder); color: #999; }
.cf-ed-sel { outline: 2px solid #ff7a59 !important; outline-offset: 2px; }
</style></head><body class="cf-site"><main class="cf-main"><div class="cf-article" id="doc"></div></main></body></html>`;
}

type Ctx = { history: StudioHistory; bridge: AgentBridge; link: () => StudioLink; update?: Promise<UpdateInfo | null> };

async function handle(kit: Kit, req: IncomingMessage, res: ServerResponse, clients: Set<ServerResponse>, ctx: Ctx) {
  Object.assign(kit, openKit(kit.root)); // cueflow.json may have been changed by someone else
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const lang = url.searchParams.get("lang") ?? undefined;

  const asset = ASSETS[p];
  if (asset && req.method === "GET") return send(res, 200, await readFile(path.join(here, "studio", asset[0])), asset[1]);

  if (p === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // Studio's door for an assistant (curl): its own key, not the page's header
  if (p.startsWith("/agent/")) return agentRoutes(req, res, url, { ...ctx, kit });

  if (req.method !== "GET" && req.headers["x-cueflow"] !== "studio") throw new HttpError(403, "not allowed from this page");

  if (p === "/api/state") return json(res, await state(kit));
  if (p === "/api/update") return json(res, { update: await (ctx.update ??= checkForUpdate()) });

  // ---- written guides ----
  if (p === "/article-frame" && req.method === "GET") return send(res, 200, await articleFrame(kit, lang), "text/html; charset=utf-8");
  let am = /^\/kit\/((?:pages|shared|media)\/.+)$/.exec(p);
  if (am && req.method === "GET") {
    const rel = safeRel(decodeURIComponent(am[1]!));
    const file = path.join(kit.root, rel);
    const ext = path.extname(file).toLowerCase();
    const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
    if (!types[ext]) throw new HttpError(404, "not found");
    return send(res, 200, await readFile(file).catch(() => { throw new HttpError(404, "not found"); }), types[ext]!);
  }
  am = /^\/api\/article\/([\w-]+)$/.exec(p);
  if (am && req.method === "GET") return json(res, await readArticle(kit, am[1]!, lang ?? (await loadSite(kit)).lang));
  if (am && req.method === "PUT") {
    const b = await readBody(req);
    return json(res, await writeArticle(kit, am[1]!, lang ?? (await loadSite(kit)).lang, String(b.html ?? ""), typeof b.version === "number" ? b.version : undefined));
  }
  am = /^\/api\/article-translate\/([\w-]+)$/.exec(p);
  if (am && req.method === "POST") return json(res, await startTranslation(kit, am[1]!, String(lang)));
  if (p === "/api/order" && req.method === "POST") {
    // the order the tutorials are listed in, in Studio and on the dashboard: the videos that are not on it yet join it first
    const b = await readBody(req);
    await syncSite(kit);
    if (!Array.isArray(b.ids)) throw new HttpError(400, "ids must be the list of item ids in the new order");
    return json(res, await reorderItems(kit, b.ids.map(String), b.moved ? { id: String(b.moved), row: b.row ? String(b.row) : undefined } : undefined));
  }
  if (p === "/api/article-create" && req.method === "POST") {
    const b = await readBody(req);
    if (!(await readFile(siteFile(kit)).then(() => true, () => false))) await syncSite(kit); // the first written guide starts the dashboard
    return json(res, await createArticle(kit, b));
  }
  if (p === "/api/article-image" && req.method === "POST") {
    // images of the written guides live in pages/img/, beside the articles that show them
    const name = cleanName(url.searchParams.get("name") ?? "");
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) throw new HttpError(400, "an image is a .png, .jpg, .gif, .webp or .svg file");
    const data = await readRaw(req);
    const dir = path.join(kit.root, "pages", "img");
    await mkdir(dir, { recursive: true });
    let file = path.join(dir, name), n = 2;
    while (await stat(file).then(() => true, () => false)) file = path.join(dir, name.replace(/(\.\w+)$/, `-${n++}$1`));
    await writeAtomic(file, data);
    return json(res, { path: "img/" + path.basename(file) });
  }
  am = /^\/api\/item\/([\w-]+)$/.exec(p);
  if (am && req.method === "POST") return json(res, await updateItem(kit, am[1]!, await readBody(req)));
  if (am && req.method === "DELETE") return json(res, await deleteItem(kit, am[1]!));
  if (p === "/api/agent-prompt") return json(res, { short: pasteLine(ctx.link()), prompt: await agentPrompt(kit, { guide: url.searchParams.get("guide") ?? undefined, step: url.searchParams.get("step") ? Number(url.searchParams.get("step")) : undefined, lang }, ctx.link()) });
  // what the page asks of the assistant: the state of the door, a request to send, or a prompt to copy
  if (p === "/api/agent" && req.method === "GET") return json(res, ctx.bridge.state());
  if (p === "/api/agent/request-prompt" && req.method === "POST") {
    const b = await readBody(req);
    return json(res, { prompt: await requestPrompt(kit, b.request as NewRequest, { lang: b.lang }, ctx.link()) });
  }
  if (p === "/api/agent/send" && req.method === "POST") {
    const b = await readBody(req);
    let title: string, prompt: string, kind: string;
    if (b.request) {
      const r = b.request as NewRequest;
      kind = "new-" + r.kind;
      title = `New ${r.kind === "video" ? "video tutorial" : r.kind === "guide" ? "written guide" : "announcement"}${r.title ? `: ${r.title}` : ""}`;
      prompt = await requestPrompt(kit, r, { lang: b.lang }, ctx.link(), true);
    } else {
      kind = "message";
      title = String(b.title ?? "A request from Studio").slice(0, 120);
      prompt = String(b.text ?? "").slice(0, 8000);
      if (!prompt.trim()) throw new HttpError(400, "write what you want the assistant to do");
    }
    const task = ctx.bridge.send(kind, title, prompt);
    if (!task) throw new HttpError(409, "no assistant is connected to Studio: copy the prompt and paste it in your assistant instead");
    return json(res, { task });
  }
  if (p === "/api/agent/cancel" && req.method === "POST") {
    const b = await readBody(req);
    return json(res, { cancelled: ctx.bridge.cancel(String(b.task)) });
  }

  if (p === "/api/changes" && req.method === "GET") return json(res, (await pendingChanges(kit)).map((c) => ({ ...c, sentence: describeChange(c) })));
  if (p === "/api/changes/discard" && req.method === "POST") {
    const b = await readBody(req);
    const ids = b.all === true ? "all" : Array.isArray(b.ids) ? b.ids.map(String) : [];
    return json(res, { discarded: await discardChanges(kit, ids) });
  }

  if (p === "/api/history" && req.method === "POST") {
    const body = await readBody(req);
    const id = Guide.shape.id.parse(body.guide);
    if (body.direction !== "undo" && body.direction !== "redo") throw new HttpError(400, "Choose undo or redo.");
    await loadGuide(kit, id);
    const result = await ctx.history.move(id, body.direction);
    await recordChange(kit, { kind: "file-edited", tutorial: id, file: result.file, target: result.file, before: body.direction === "undo" ? result.label : "Undone: " + result.label, after: body.direction === "undo" ? "Undone: " + result.label : result.label });
    return json(res, result);
  }

  let m = /^\/api\/guide\/([\w-]+)$/.exec(p);
  if (m && req.method === "GET") return json(res, { guide: await loadGuide(kit, m[1]!), version: await mtime(guideFile(kit, m[1]!)), history: await ctx.history.status(m[1]!) });
  if (m && req.method === "PUT") {
    const body = await readBody(req);
    const id = m[1]!;
    if ((await mtime(guideFile(kit, id))) !== body.version) throw new HttpError(409, "the guide changed on disk meanwhile (an assistant, or another editor): reload it before saving");
    const guide = Guide.parse(body.guide);
    if (guide.id !== id) throw new HttpError(400, "the guide's id cannot change here");
    const existing = await loadGuide(kit, id);
    if (existing.vertical !== guide.vertical) throw new HttpError(400, "Tutorial orientation is fixed at creation. Create a new tutorial for a different orientation.");
    const report = await validateGuide(kit, guide);
    if (report.errors.length) return json(res, { saved: false, errors: report.errors, warnings: report.warnings }, 422);
    // what the person changed in the words of the video: noted for the assistant
    const old = await loadGuide(kit, id).catch(() => null);
    const cameraChanged = old?.steps.some((step, i) => JSON.stringify(step.camera) !== JSON.stringify(guide.steps[i]?.camera));
    await ctx.history.record(id, guideFile(kit, id), cameraChanged ? "Change camera framing" : "Edit tutorial", async () => {
      if ((await mtime(guideFile(kit, id))) !== body.version) throw new HttpError(409, "The tutorial changed before saving. Reload it first.");
      await saveGuide(kit, guide);
    });
    if (old) {
      for (const st of guide.steps) {
        const o = old.steps.find((x) => x.id === st.id);
        if (!o) continue;
        for (const lang of guide.languages) {
          await recordChange(kit, { kind: "narration", tutorial: id, lang, target: st.id, before: o.narration[lang] ?? "", after: st.narration[lang] ?? "" });
          await recordChange(kit, { kind: "title", tutorial: id, lang, target: st.id, before: pick(o.title, lang) ?? "", after: pick(st.title, lang) ?? "" });
        }
      }
    }
    return json(res, { saved: true, warnings: report.warnings, version: await mtime(guideFile(kit, id)) });
  }

  if (m && req.method === "DELETE") {
    const r = await deleteTutorial(kit, m[1]!).catch((e) => { throw new HttpError(404, e.message); });
    return json(res, r);
  }

  m = /^\/preview\/([\w-]+)$/.exec(p);
  if (m) {
    // silent build (no paid voice is called for a preview); the browser reads the narration so it can be heard
    // ?studio=1: the Timeline draws its own transport, so the player shows only the picture and the caption
    const extras = url.searchParams.get("studio") ? { css: ".cf-bar,.cf-transcript,.cf-big,.cf-veil-text,.cf-stage::after{display:none!important}" } : undefined;
    const { html } = await renderGuideHtml(kit, m[1]!, null, { browserVoice: true, extras });
    return send(res, 200, html, "text/html; charset=utf-8");
  }
  m = /^\/scene\/([\w-]+)$/.exec(p);
  if (m) return send(res, 200, await inlineScene(kit, m[1]!, lang), "text/html; charset=utf-8");

  // built files, so that a built video or site can be opened from Studio
  if (p.startsWith("/out/") && req.method === "GET") {
    const file = path.resolve(kit.out, "." + decodeURIComponent(p.slice(4)));
    if (file !== kit.out && !file.startsWith(kit.out + path.sep)) throw new HttpError(403, "outside the output folder");
    const type = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".m4a": "audio/mp4", ".json": "application/json" }[path.extname(file)] ?? "application/octet-stream";
    try {
      return send(res, 200, await read(file), type);
    } catch {
      throw new HttpError(404, "not built yet");
    }
  }

  // files of a tutorial (media) and of all tutorials (shared), as images etc.
  m = /^\/files\/(shared|media)\/(.+)$/.exec(p);
  if (m && req.method === "GET") {
    const area = m[1] as Area;
    const rest = decodeURIComponent(m[2]!);
    let file: string;
    if (area === "shared") file = path.join(areaDir(kit, "shared"), safeRel(rest));
    else {
      const [guide, ...more] = rest.split("/");
      file = path.join(areaDir(kit, "media", guide), safeRel(more.join("/")));
    }
    const type = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".css": "text/css", ".js": "text/javascript", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg" }[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    try {
      return send(res, 200, await read(file), type);
    } catch {
      throw new HttpError(404, "no such file");
    }
  }
  if (p === "/api/scene-edit" && req.method === "POST") {
    const b = await readBody(req);
    if (!b.lang) throw new HttpError(400, "choose the language to edit in (the selector at the top)");
    const r = await ctx.history.record(b.tutorial ? Guide.shape.id.parse(b.tutorial) : "scenes", sceneFile(kit, String(b.scene), String(b.lang)), `Edit scene ${String(b.scene)} (${String(b.lang)})`,
      () => editSceneElement(kit, String(b.scene), String(b.lang), String(b.selector), { text: b.text, attrs: b.attrs, remove: b.remove === true }, b.tutorial ? String(b.tutorial) : undefined)).catch((e) => { throw new HttpError(422, e.message); });
    return json(res, { saved: true, changed: r.changed });
  }
  if (p === "/api/media-text" && req.method === "PUT") {
    const area = url.searchParams.get("area") as Area;
    const guide = url.searchParams.get("guide") ?? undefined;
    const name = cleanName(url.searchParams.get("name") ?? "");
    if (![".css", ".js"].includes(path.extname(name).toLowerCase())) throw new HttpError(400, "only stylesheets and scripts can be edited as text");
    const file = path.join(areaDir(kit, area, guide), name);
    const before = await read(file, "utf8").catch(() => "");
    const after = (await readRaw(req, 2_000_000)).toString("utf8");
    await writeAtomic(file, after);
    const a = before.split("\n"), c = after.split("\n");
    let diff = 0, first = "";
    for (let i = 0; i < Math.max(a.length, c.length); i++) if (a[i] !== c[i]) { diff += 1; if (!first) first = `line ${i + 1}: “${(a[i] ?? "").trim().slice(0, 80)}” → “${(c[i] ?? "").trim().slice(0, 80)}”`; }
    if (diff) await recordChange(kit, { kind: "file-edited", tutorial: guide, target: `${area === "shared" ? "shared" : "media/" + guide}/${name}`, after: `${diff} line(s) differ; first: ${first}` });
    return json(res, { saved: true, lines: diff });
  }
  if (p === "/api/site" && req.method === "GET") {
    await syncSite(kit);
    return json(res, await loadSite(kit));
  }
  if (p === "/api/site-text" && req.method === "POST") {
    const b = await readBody(req);
    if (!["title", "kicker", "desc"].includes(b.field)) throw new HttpError(400, "field must be title, kicker or desc");
    await setSiteText(kit, String(b.id), b.field, String(b.lang), String(b.value ?? "")).catch((e) => { throw new HttpError(422, e.message); });
    return json(res, { saved: true });
  }

  // the audio of one step, for the waveform and for listening: an uploaded file, or what a voice already generated (never generates)
  m = /^\/api\/step-audio\/([\w-]+)\/([\w-]+)\/([\w-]+)$/.exec(p);
  if (m && req.method === "GET") {
    const guide = await loadGuide(kit, m[1]!).catch(() => { throw new HttpError(404, "no such tutorial"); });
    const step = guide.steps.find((s) => s.id === m![2]);
    if (!step) throw new HttpError(404, "no such step");
    const sound = await stepAudio(kit, guide, step, m[3]!, null).catch(() => null);
    if (!sound) { res.writeHead(204, { "cache-control": "no-store" }); return void res.end(); } // not an error: most steps have no audio until built
    res.writeHead(200, { "content-type": sound.mime, "content-length": sound.data.length, "cache-control": "no-store" });
    return void res.end(sound.data);
  }
  // an audio file for one step in one language (a recording of its own instead of a voice)
  if (p === "/api/step-audio" && req.method === "POST") {
    const guide = url.searchParams.get("guide") ?? "", step = url.searchParams.get("step") ?? "", lang = url.searchParams.get("lang") ?? "", ext = (url.searchParams.get("ext") ?? "").toLowerCase();
    if (![guide, step, lang].every((v) => /^[\w-]+$/.test(v))) throw new HttpError(400, "guide, step and lang are needed");
    if (!["mp3", "m4a", "wav", "ogg", "aac"].includes(ext)) throw new HttpError(400, "the audio must be mp3, m4a, wav, ogg or aac");
    const data = await readRaw(req);
    const name = await saveMediaFile(kit, "media", guide, `voice/${step}.${lang}.${ext}`, data).catch((e) => { throw new HttpError(400, e.message); });
    await recordChange(kit, { kind: "file-replaced", tutorial: guide, target: `media/${guide}/${name}`, before: "", after: `${data.length} bytes (voice of ${step}, ${lang})` });
    return json(res, { file: `media/${guide}/${name}` });
  }

  m = /^\/api\/media\/([\w-]+)$/.exec(p);
  if (m && req.method === "GET") return json(res, await mediaOverview(kit, m[1]!));
  if (p === "/api/media-file" && req.method === "POST") {
    const area = url.searchParams.get("area") as Area;
    if (area !== "shared" && area !== "media") throw new HttpError(400, "area must be shared or media");
    const guide = url.searchParams.get("guide") ?? undefined;
    const data = await readRaw(req);
    const rel = cleanName(url.searchParams.get("name") ?? "");
    const existing = await stat(path.join(areaDir(kit, area, guide), rel)).then((s) => s.size, () => null);
    const name = await saveMediaFile(kit, area, guide, rel, data).catch((e) => { throw new HttpError(400, e.message); });
    if (existing !== null) await recordChange(kit, { kind: "file-replaced", tutorial: guide, target: `${area === "shared" ? "shared" : "media/" + guide}/${name}`, before: `${existing} bytes`, after: `${data.length} bytes` });
    return json(res, { saved: name, replaced: existing !== null });
  }
  if (p === "/api/media-file" && req.method === "DELETE") {
    const area = url.searchParams.get("area") as Area;
    await deleteMediaFile(kit, area, url.searchParams.get("guide") ?? undefined, url.searchParams.get("name") ?? "").catch((e) => { throw new HttpError(409, e.message); });
    return json(res, { deleted: true });
  }

  // the whole tutorial system: every video, and the dashboard (catalog + pages) that gathers them
  if (p === "/api/export-all" && req.method === "POST") {
    const b = await readBody(req);
    return progressive(res, b.progress === true, async (report) => {
    report(0, "Preparing…");
    const sync = await syncSite(kit);
    const built = [];
    const ids = await listGuides(kit);
    // the guides take 90% of the bar (their audio is what takes time), the dashboard the rest
    for (const [i, id] of ids.entries()) built.push({ id, ...(await buildGuide(kit, id, undefined, { onProgress: (d, t) => report(((i + (t ? d / t : 1)) / ids.length) * 90, `Video ${i + 1} of ${ids.length}: ${id}`) })) });
    report(90, "Building the dashboard…");
    const r = await buildSite(kit, { posters: b.posters === true });
    return ({ url: "/out/site/index.html", outDir: kit.out, guides: built.map((x) => ({ id: x.id, audioFiles: x.audioFiles, silent: x.silent })), pages: r.pages.length, warnings: [...new Set([...built.flatMap((x) => x.warnings), ...r.warnings])], siteCreated: sync.created, siteAdded: sync.added });
    });
  }

  if (p === "/api/check" && req.method === "POST") {
    const b = await readBody(req);
    const report = await validateGuide(kit, await loadGuide(kit, String(b.guide)));
    const out: { errors: string[]; warnings: string[]; layout?: string[]; layoutError?: string } = { ...report };
    if (b.layout && !report.errors.length) {
      try {
        out.layout = await checkLayout(kit, String(b.guide), { lang: b.lang ? String(b.lang) : undefined });
      } catch (e) {
        out.layoutError = `The layout check needs a browser (Playwright): ${e instanceof Error ? e.message : e}`;
      }
    }
    return json(res, out);
  }

  if (p === "/api/export-mp4" && req.method === "POST") {
    const b = await readBody(req);
    let size: string;
    try { size = videoPreset(b.size).id; } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (b.progress === true) {
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
      const event = (value: unknown) => { if (!res.destroyed) res.write(JSON.stringify(value) + "\n"); };
      try {
        const r = await buildVideo(kit, String(b.guide), String(b.lang), (progress) => event({ progress }), { size });
        event({ result: { url: `/out/${encodeURIComponent(r.name)}`, warnings: r.warnings } });
      } catch (e) {
        event({ error: e instanceof Error ? e.message : String(e) });
      }
      return void res.end();
    }
    const r = await buildVideo(kit, String(b.guide), String(b.lang), undefined, { size });
    return json(res, { url: `/out/${encodeURIComponent(r.name)}`, warnings: r.warnings });
  }

  if (p === "/api/build" && req.method === "POST") {
    // builds with the voices chosen in cueflow.json: an external voice is called here, deliberately
    const b = await readBody(req);
    if (b.target === "site") {
      return progressive(res, b.progress === true, async (report) => {
        report(0, "Building the site…");
        await syncSite(kit);
        const r = await buildSite(kit, { posters: b.posters === true });
        return { target: "site", url: "/out/site/index.html", pages: r.pages.length, warnings: r.warnings };
      });
    }
    const id = String(b.guide);
    return progressive(res, b.progress === true, async (report) => {
      const r = await buildGuide(kit, id, undefined, { onProgress: (d, t) => report(t ? (d / t) * 100 : 100, "Narration " + d + " of " + t) });
      return { target: "guide", url: `/out/${id}.html`, audioFiles: r.audioFiles, silent: r.silent, warnings: r.warnings };
    });
  }

  if (p === "/api/out-dir" && req.method === "POST") {
    // where builds write: typed relative to the project (or absolute); empty = back to the default. Files already built stay where they are.
    const b = await readBody(req);
    const raw = await readRawSettings(kit);
    try {
      raw.outDir = typeof b.outDir === "string" && b.outDir.trim() ? outDirSetting(kit, b.outDir) : defaultOutDir(kit);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    await writeRawSettings(kit, raw);
    return json(res, { outDir: kit.out });
  }

  if (p === "/api/share" && req.method === "POST") {
    // the page of a video for phones; its card language is the one being edited
    const b = await readBody(req);
    const id = String(b.guide);
    const r = await buildShare(kit, id, { lang: b.lang ? String(b.lang) : undefined });
    return json(res, { url: `/out/share/${id}/index.html`, dir: r.dir, poster: Boolean(r.poster), link: r.link, warnings: r.warnings });
  }

  if (p === "/api/guide-create" && req.method === "POST") {
    const b = await readBody(req);
    if ((await listGuides(kit)).includes(String(b.id))) throw new HttpError(409, `a video "${b.id}" already exists`);
    if (!(await listScenes(kit)).includes(String(b.scene))) throw new HttpError(400, `the scene "${b.scene}" does not exist (available: ${(await listScenes(kit)).join(", ") || "none"})`);
    const guide = orientedGuide(Guide.parse({ id: b.id, title: b.title, scene: b.scene, vertical: b.vertical, languages: b.languages?.length ? b.languages : ["en"], steps: [] }));
    await saveGuide(kit, guide);
    return json(res, { id: guide.id });
  }

  m = /^\/api\/elements\/([\w-]+)$/.exec(p);
  if (m) return json(res, describeScene(await readScene(kit, m[1]!, lang)));
  if (p === "/api/brief" && req.method === "POST") {
    const b = await readBody(req);
    const patch = Brief.partial().parse(b);
    return json(res, await updateBrief(kit, patch));
  }

  if (p === "/api/credit" && req.method === "GET") return json(res, await keyCredit());
  if (p === "/api/speech-models" && req.method === "GET") return json(res, { models: await speechModels() });
  if (p === "/api/voices") return json(res, { options: voiceOptions(), current: kit.settings.voices, table: await voiceTable(kit), hasKey: Boolean(process.env.FANTASTICO_API_KEY) });
  if (p === "/api/voice" && req.method === "POST") {
    const b = await readBody(req);
    const target = b.scope === "global" ? { scope: "global" as const } : b.scope === "language" ? { scope: "language" as const, language: String(b.language) } : { scope: "video" as const, guide: String(b.guide), language: b.language ? String(b.language) : undefined };
    await setVoice(kit, target, b.voice ?? null);
    return json(res, { current: kit.settings.voices, table: await voiceTable(kit) });
  }
  if (p === "/api/key" && req.method === "POST") {
    // the key is written to the kit's .env (git-ignored) and never sent back to the page
    const key = String((await readBody(req)).key ?? "").trim();
    if (!/^(?:sk|ck)-fant-[\w-]{8,}$/.test(key)) throw new HttpError(400, `Enter a Fantastico key (ck-fant-… or sk-fant-…). Get a key at ${FANTASTICO_PORTAL}`);
    const file = path.join(kit.root, ".env");
    const old = await readFile(file, "utf8").catch(() => "");
    await writeAtomic(file, old.split("\n").filter((l) => l && !l.startsWith("FANTASTICO_API_KEY=")).concat(`FANTASTICO_API_KEY=${key}`).join("\n") + "\n");
    await chmod(file, 0o600).catch(() => {});
    process.env.FANTASTICO_API_KEY = key;
    return json(res, { hasKey: true });
  }
  // a narration as the tutorial will say it: the voice cueflow.json gives that video in that language, with the
  // pronunciation applied. An external voice goes through the same cache as the build, so listening first costs nothing more.
  if (p === "/api/listen" && req.method === "POST") {
    const b = await readBody(req);
    const id = String(b.guide ?? ""), lang = String(b.language ?? "");
    const guide = await loadGuide(kit, id);
    const said = spokenText(String(b.text ?? "").slice(0, 2000), { ...(await loadBrief(kit)).pronunciation, ...guide.pronunciation });
    const voice = voiceFor(kit, id, lang);
    // the browser's voice, or none (a silent video): either way the browser reads it here, and says which
    if (!voice.provider) return json(res, { browser: true, silent: !voice.browser, text: said });
    return send(res, 200, await narrationAudio(kit, voice.provider, said, lang), audioMime(voice.provider));
  }
  if (p === "/api/voice-sample" && req.method === "POST") {
    const b = await readBody(req);
    const provider = providerFromSpec(VoiceSpec.parse(b.voice));
    if (!provider) throw new HttpError(400, "this voice is read by the browser: there is no file to play");
    const audio = await narrationAudio(kit, provider, String(b.text ?? "").slice(0, 300), String(b.language ?? "en"));
    return send(res, 200, audio, audioMime(provider));
  }

  throw new HttpError(404, "not found");
}


const authOk = (req: IncomingMessage, url: URL, token: string) => {
  const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
  return given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
};

/** The HTTP door of an assistant: everything under /agent/, with Studio's key. */
async function agentRoutes(req: IncomingMessage, res: ServerResponse, url: URL, ctx: Ctx & { kit: Kit }) {
  const { bridge } = ctx;
  // the link printed at start: the key is in the address, so an assistant can read the full prompt with one plain GET
  const link = /^\/agent\/instructions\/(\w+)$/.exec(url.pathname);
  if (link) {
    if (req.method !== "GET" || link[1] !== bridge.token) throw new HttpError(401, "wrong key: copy the link again from the terminal or from Studio's AI button (it may belong to another project's Studio)");
    bridge.lastSeen = Date.now();
    return send(res, 200, await agentPrompt(ctx.kit, {}, ctx.link()), "text/plain; charset=utf-8");
  }
  if (!authOk(req, url, bridge.token)) throw new HttpError(401, "missing or wrong key: use the header Authorization: Bearer <key> given in the prompt of Studio (the key is in .studio-key of the kit, so it may be another project's Studio)");
  bridge.lastSeen = Date.now();
  const p = url.pathname;

  if (p === "/agent/help") {
    const tools = await bridge.listTools();
    const base = ctx.link().url.replace(/\/$/, "");
    return send(res, 200, [
      "Cueflow Studio: the door for an assistant. Valid while Studio runs, on this computer. Every call carries the header Authorization: Bearer <key>.",
      "",
      `GET  ${base}/agent/help          this text`,
      `GET  ${base}/agent/method        how to make good tutorials with Cueflow: read it before starting`,
      `GET  ${base}/agent/tools         the tools, with their arguments (JSON)`,
      `POST ${base}/agent/call/<tool>   body: the arguments as JSON ({} if none) → {"ok":…,"result":…}; a picture comes back as a file path`,
      `GET  ${base}/agent/next?wait=540 LISTEN: returns {"task":{id,title,prompt}} when the person sends you something from Studio, or {"task":null} after the wait. Run it in the background and run it again each time.`,
      `POST ${base}/agent/say           {"text":"…","task":"<id>"} what you are doing, shown in Studio`,
      `POST ${base}/agent/done          {"task":"<id>","summary":"…"} when a task is finished`,
      "",
      "Start with the method, then the tool get_brief: it says where the kit stands and what comes next.",
      "",
      "Tools: " + tools.map((t) => t.name).join(", ")
    ].join("\n"), "text/plain; charset=utf-8");
  }
  if (p === "/agent/method") return send(res, 200, METHOD, "text/plain; charset=utf-8");
  if (p === "/agent/tools") return json(res, await bridge.listTools());

  const call = /^\/agent\/call\/([\w-]+)$/.exec(p);
  if (call && req.method === "POST") {
    const args = await readBody(req);
    return json(res, await bridge.call(call[1]!, args));
  }

  if (p === "/agent/next" && req.method === "GET") {
    const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 60), 1), 540) * 1000;
    const { promise, abort } = bridge.next(wait);
    req.on("close", abort); // the assistant hung up (it was stopped): it is not waiting any more
    return json(res, { task: await promise });
  }
  if (p === "/agent/say" && req.method === "POST") {
    const b = await readBody(req);
    bridge.say(String(b.text ?? ""), b.task ? String(b.task) : undefined);
    return json(res, { ok: true });
  }
  if (p === "/agent/done" && req.method === "POST") {
    const b = await readBody(req);
    if (!bridge.done(String(b.task), b.summary ? String(b.summary) : undefined)) throw new HttpError(404, `no task "${b.task}"`);
    return json(res, { ok: true });
  }
  throw new HttpError(404, "no such call: GET /agent/help lists them");
}

/** Cueflow Studio: a local page to look at and edit a kit. It binds to this computer only. */
export async function startStudio(kit: Kit, opts: { port?: number; open?: boolean } = {}): Promise<{ url: string; link: StudioLink; bridge: AgentBridge; close: () => void }> {
  const clients = new Set<ServerResponse>();
  const bridge = new AgentBridge(kit);
  let link: StudioLink = { url: "", token: bridge.token };
  const ctx: Ctx = { history: new StudioHistory(kit), bridge, link: () => link };
  bridge.onChange = () => { for (const c of clients) c.write("event: agent\ndata: changed\n\n"); };
  const server = createServer((req, res) => {
    // only this computer, under its own name: a web page elsewhere must not be able to drive the kit
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "")) return send(res, 403, "forbidden", "text/plain");
    handle(kit, req, res, clients, ctx).catch((e) => {
      const status = e instanceof HttpError || e instanceof ArticleError || e instanceof HistoryConflict || e instanceof FantasticoError ? e.status : e?.name === "ZodError" ? 422 : 500;
      const message = e?.name === "ZodError" ? e.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);
      if (!res.headersSent) json(res, { error: message, ...(e instanceof FantasticoError ? { code: e.code, ...(status === 402 ? { rechargeUrl: FANTASTICO_PORTAL } : {}) } : {}) }, status);
      else res.end();
    });
  });
  let last = await signature(kit);
  const timer = setInterval(async () => {
    const now = await signature(kit);
    if (now !== last) {
      last = now;
      for (const c of clients) c.write("data: changed\n\n");
    }
  }, 1000);
  timer.unref();

  const start = opts.port ?? 4310;
  const port = await new Promise<number>((resolve, reject) => {
    // a failed attempt must not leave its "listening" callback behind: it would resolve with the busy port
    const tryPort = (n: number) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (e.code === "EADDRINUSE" && n < start + 20) tryPort(n + 1);
        else reject(e);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(n);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(n, "127.0.0.1");
    };
    tryPort(start);
  });
  const url = `http://localhost:${port}/`;
  link = { url, token: bridge.token };
  if (opts.open !== false) openBrowser(url);
  return { url, link, bridge, close: () => { clearInterval(timer); for (const c of clients) c.end(); server.close(); } };
}

/** Runs `work`; with `stream` the answer is NDJSON lines ({progress}, then {result} or {error}), like the MP4 export, otherwise one JSON. */
async function progressive(res: ServerResponse, stream: boolean, work: (report: (percent: number, phase: string) => void) => Promise<unknown>) {
  if (!stream) return json(res, await work(() => {}));
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  const event = (value: unknown) => { if (!res.destroyed) res.write(JSON.stringify(value) + "\n"); };
  try {
    event({ result: await work((percent, phase) => event({ progress: { percent: Math.round(Math.min(100, percent)), phase } })) });
  } catch (e) {
    event({ error: e instanceof Error ? e.message : String(e) });
  }
  res.end();
}

function openBrowser(url: string) {
  const isWsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : isWsl ? ["cmd.exe", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd!, args as string[], () => {}); // no browser to open is not an error: the address is printed
}
