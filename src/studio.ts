import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrief } from "./brief.ts";
import { renderGuideHtml, writeAtomic } from "./build.ts";
import { listGuides, listScenes, loadGuide, openKit, saveGuide, guideFile, type Kit } from "./kit.ts";
import { inlineScene } from "./scene.ts";
import { Guide } from "./schema.ts";
import { narrationAudio, providerFromSpec, audioMime } from "./tts.ts";
import { VoiceSpec } from "./settings.ts";
import { validateGuide } from "./validate.ts";
import { setVoice, voiceOptions, voiceTable } from "./voices.ts";

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

const mtime = (file: string) => stat(file).then((s) => s.mtimeMs, () => 0);

/** What changed on disk, as one string: when it differs from the last one, somebody (an assistant, an editor) edited the kit. */
async function signature(kit: Kit): Promise<string> {
  const parts: string[] = [];
  for (const dir of ["guides", "scenes", "scenes/it", "scenes/en"]) {
    for (const f of await readdir(path.join(kit.root, dir)).catch(() => [] as string[])) parts.push(`${dir}/${f}:${await mtime(path.join(kit.root, dir, f))}`);
  }
  for (const f of ["cueflow.json", "brief.json"]) parts.push(`${f}:${await mtime(path.join(kit.root, f))}`);
  return parts.join("|");
}

async function state(kit: Kit) {
  const guides = [];
  for (const id of await listGuides(kit)) {
    const g = await loadGuide(kit, id).catch(() => null);
    if (!g) continue;
    guides.push({ id, title: g.title, languages: g.languages, scene: g.scene, steps: g.steps.map((s) => ({ id: s.id, title: s.title ?? null, narration: s.narration })) });
  }
  return { kitRoot: kit.root, outDir: kit.out, brief: await loadBrief(kit), guides, scenes: await listScenes(kit), hasKey: Boolean(process.env.OPENAI_API_KEY) };
}

async function handle(kit: Kit, req: IncomingMessage, res: ServerResponse, clients: Set<ServerResponse>) {
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

  if (req.method !== "GET" && req.headers["x-cueflow"] !== "studio") throw new HttpError(403, "not allowed from this page");

  if (p === "/api/state") return json(res, await state(kit));

  let m = /^\/api\/guide\/([\w-]+)$/.exec(p);
  if (m && req.method === "GET") return json(res, { guide: await loadGuide(kit, m[1]!), version: await mtime(guideFile(kit, m[1]!)) });
  if (m && req.method === "PUT") {
    const body = await readBody(req);
    const id = m[1]!;
    if ((await mtime(guideFile(kit, id))) !== body.version) throw new HttpError(409, "the guide changed on disk meanwhile (an assistant, or another editor): reload it before saving");
    const guide = Guide.parse(body.guide);
    if (guide.id !== id) throw new HttpError(400, "the guide's id cannot change here");
    const report = await validateGuide(kit, guide);
    if (report.errors.length) return json(res, { saved: false, errors: report.errors, warnings: report.warnings }, 422);
    await saveGuide(kit, guide);
    return json(res, { saved: true, warnings: report.warnings, version: await mtime(guideFile(kit, id)) });
  }

  m = /^\/preview\/([\w-]+)$/.exec(p);
  if (m) {
    // silent build (no paid voice is called for a preview); the browser reads the narration so it can be heard
    const { html } = await renderGuideHtml(kit, m[1]!, null, { browserVoice: true });
    return send(res, 200, html, "text/html; charset=utf-8");
  }
  m = /^\/scene\/([\w-]+)$/.exec(p);
  if (m) return send(res, 200, await inlineScene(kit, m[1]!, lang), "text/html; charset=utf-8");

  if (p === "/api/voices") return json(res, { options: voiceOptions(), current: kit.settings.voices, table: await voiceTable(kit), hasKey: Boolean(process.env.OPENAI_API_KEY) });
  if (p === "/api/voice" && req.method === "POST") {
    const b = await readBody(req);
    const target = b.scope === "global" ? { scope: "global" as const } : b.scope === "language" ? { scope: "language" as const, language: String(b.language) } : { scope: "video" as const, guide: String(b.guide), language: b.language ? String(b.language) : undefined };
    await setVoice(kit, target, b.voice ?? null);
    return json(res, { current: kit.settings.voices, table: await voiceTable(kit) });
  }
  if (p === "/api/key" && req.method === "POST") {
    // the key is written to the kit's .env (git-ignored) and never sent back to the page
    const key = String((await readBody(req)).key ?? "").trim();
    if (!/^[\w-]{20,}$/.test(key)) throw new HttpError(400, "that does not look like an OpenAI key (it starts with sk-)");
    const file = path.join(kit.root, ".env");
    const old = await readFile(file, "utf8").catch(() => "");
    await writeAtomic(file, old.split("\n").filter((l) => l && !l.startsWith("OPENAI_API_KEY=")).concat(`OPENAI_API_KEY=${key}`).join("\n") + "\n");
    await chmod(file, 0o600).catch(() => {});
    process.env.OPENAI_API_KEY = key;
    return json(res, { hasKey: true });
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

/** Cueflow Studio: a local page to look at and edit a kit. It binds to this computer only. */
export async function startStudio(kit: Kit, opts: { port?: number; open?: boolean } = {}): Promise<{ url: string; close: () => void }> {
  const clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    // only this computer, under its own name: a web page elsewhere must not be able to drive the kit
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? "")) return send(res, 403, "forbidden", "text/plain");
    handle(kit, req, res, clients).catch((e) => {
      const status = e instanceof HttpError ? e.status : e?.name === "ZodError" ? 422 : 500;
      const message = e?.name === "ZodError" ? e.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);
      if (!res.headersSent) json(res, { error: message }, status);
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
    const tryPort = (n: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && n < start + 20 ? tryPort(n + 1) : reject(e)));
      server.listen(n, "127.0.0.1", () => resolve(n));
    };
    tryPort(start);
  });
  const url = `http://localhost:${port}/`;
  if (opts.open !== false) openBrowser(url);
  return { url, close: () => { clearInterval(timer); for (const c of clients) c.end(); server.close(); } };
}

function openBrowser(url: string) {
  const isWsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : isWsl ? ["cmd.exe", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd!, args as string[], () => {}); // no browser to open is not an error: the address is printed
}
