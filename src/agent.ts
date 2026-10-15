import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Kit } from "./kit.ts";
import { createServer } from "./mcp.ts";

/**
 * Studio's door for an AI assistant that cannot (or does not want to) use an MCP server: plain HTTP on this
 * computer, usable with curl, valid only while Studio runs. Behind it are the same tools as the MCP server.
 *
 * The talk goes both ways: the assistant asks Studio (call a tool), and Studio asks the assistant. For the second
 * the assistant waits with a long request (`next`) that comes back when the person sends something from Studio;
 * it does the work, answers (`done`), and waits again. Studio knows an assistant is there when one is waiting.
 */
export type AgentTask = {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  at: string;
  status: "waiting" | "working" | "done" | "cancelled";
  deliveredAt?: string;
  doneAt?: string;
  summary?: string;
};
/**
 * The key of Studio's door. It is kept in the kit (.studio-key, git-ignored, owner only) so that a link already given to
 * an assistant still works after Studio is restarted, by choice or not. Still random and unguessable by a web page.
 */
function studioKey(kit: Kit): string {
  const file = path.join(kit.root, ".studio-key");
  try {
    const k = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{36}$/.test(k)) return k;
  } catch {
    // none yet
  }
  const key = randomBytes(18).toString("hex");
  try {
    writeFileSync(file, key + "\n", { mode: 0o600 });
    const ignore = path.join(kit.root, ".gitignore");
    if (existsSync(ignore) && !/^\.studio-key$/m.test(readFileSync(ignore, "utf8"))) appendFileSync(ignore, "\n.studio-key\n");
  } catch {
    // a kit that cannot be written: the key then lasts only this run, as before
  }
  return key;
}
export type AgentNote = { at: string; text: string; task?: string };

const WORKING_MS = 20 * 60_000; // an assistant that took a task is considered busy this long
const RECENT_MS = 25_000; // seen this recently between two waits: still there

type Waiter = { resolve: (t: AgentTask | null) => void; timer: NodeJS.Timeout; beat: NodeJS.Timeout };

export class AgentBridge {
  /** random, kept in the kit between runs: a web page cannot guess it, and the door only exists while Studio runs */
  readonly token: string;
  tasks: AgentTask[] = [];
  log: AgentNote[] = [];
  lastSeen = 0;
  onChange: () => void = () => {};
  private waiters = new Set<Waiter>();
  private client: Promise<Client> | null = null;

  private kit: Kit;

  constructor(kit: Kit) {
    this.kit = kit;
    this.token = studioKey(kit);
  }

  private tools() {
    return (this.client ??= (async () => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await createServer(this.kit).connect(b);
      const client = new Client({ name: "studio-bridge", version: "1" });
      await client.connect(a);
      return client;
    })());
  }

  async listTools() {
    return (await (await this.tools()).listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  /** Calls a tool as the MCP server would; a picture is saved to a file whose path is returned. */
  async call(name: string, args: Record<string, unknown>) {
    const res = (await (await this.tools()).callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
    const out: { type: string; text?: string; file?: string }[] = [];
    for (const c of res.content ?? []) {
      if (c.type === "image" && c.data) {
        const dir = path.join(tmpdir(), "cueflow-images");
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, `${randomUUID().slice(0, 8)}.png`);
        await writeFile(file, Buffer.from(c.data, "base64"));
        out.push({ type: "image", file });
      } else out.push({ type: "text", text: c.text });
    }
    return { ok: !res.isError, result: out.length === 1 && out[0]!.type === "text" ? out[0]!.text : out };
  }

  connected(): boolean {
    const now = Date.now();
    return this.waiters.size > 0 || now - this.lastSeen < RECENT_MS || this.tasks.some((t) => t.status === "working" && now - Date.parse(t.deliveredAt ?? t.at) < WORKING_MS);
  }

  state() {
    return { connected: this.connected(), listening: this.waiters.size > 0, lastSeen: this.lastSeen ? new Date(this.lastSeen).toISOString() : null, tasks: this.tasks.slice(-20), log: this.log.slice(-40) };
  }

  /** Queues something for the assistant; it goes at once if one is waiting. False when nobody is there. */
  send(kind: string, title: string, prompt: string): AgentTask | null {
    if (!this.connected()) return null;
    const task: AgentTask = { id: randomUUID().slice(0, 8), kind, title, prompt, at: new Date().toISOString(), status: "waiting" };
    this.tasks.push(task);
    this.dispatch();
    this.onChange();
    return task;
  }

  private dispatch() {
    const task = this.tasks.find((t) => t.status === "waiting");
    const waiter = this.waiters.values().next().value as Waiter | undefined;
    if (!task || !waiter) return;
    task.status = "working";
    task.deliveredAt = new Date().toISOString();
    this.finish(waiter, task);
  }

  private finish(w: Waiter, task: AgentTask | null) {
    clearTimeout(w.timer);
    clearInterval(w.beat);
    this.waiters.delete(w);
    this.lastSeen = Date.now();
    w.resolve(task);
    this.onChange();
  }

  /** The assistant's long wait: returns the next task, or null after `waitMs`. `abort` is called when it hangs up. */
  next(waitMs: number): { promise: Promise<AgentTask | null>; abort: () => void } {
    this.lastSeen = Date.now();
    let waiter!: Waiter;
    const promise = new Promise<AgentTask | null>((resolve) => {
      waiter = {
        resolve,
        timer: setTimeout(() => this.finish(waiter, null), Math.min(Math.max(waitMs, 1000), 540_000)),
        beat: setInterval(() => { this.lastSeen = Date.now(); }, 5000)
      };
      this.waiters.add(waiter);
    });
    waiter.beat.unref();
    waiter.timer.unref();
    this.dispatch();
    this.onChange();
    return { promise, abort: () => { if (this.waiters.has(waiter)) { clearTimeout(waiter.timer); clearInterval(waiter.beat); this.waiters.delete(waiter); this.onChange(); } } };
  }

  done(taskId: string, summary?: string): boolean {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return false;
    t.status = "done";
    t.doneAt = new Date().toISOString();
    t.summary = summary;
    this.lastSeen = Date.now();
    this.say(summary ? `Done: ${summary}` : "Done.", taskId);
    return true;
  }

  say(text: string, task?: string) {
    this.lastSeen = Date.now();
    this.log.push({ at: new Date().toISOString(), text: text.slice(0, 2000), task });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    this.onChange();
  }

  cancel(taskId: string): boolean {
    const t = this.tasks.find((x) => x.id === taskId && x.status === "waiting");
    if (!t) return false;
    t.status = "cancelled";
    this.onChange();
    return true;
  }
}
