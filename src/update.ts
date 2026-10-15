import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { packageVersion } from "./version.ts";

export const PACKAGE = "@byte-42/cueflow";
export type UpdateInfo = { current: string; latest: string; command: string };

const DAY = 24 * 3600_000;
const cacheFile = (env: NodeJS.ProcessEnv) => path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "cueflow", "update.json");

/** x.y.z as numbers; a pre-release or anything else is not comparable (null), so it never triggers a proposal. */
function parse(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** How to update, depending on how Cueflow was started (npx runs the latest by itself when asked for it). */
export function updateCommand(argv1 = process.argv[1] ?? ""): string {
  return /_npx[\\/]/.test(argv1) ? `npx ${PACKAGE}@latest` : `npm install -g ${PACKAGE}@latest`;
}

/**
 * Asks the npm registry which version is the latest (one small GET, nothing about you or your project is sent) and says
 * whether it is newer than the running one. At most once a day (the answer is kept in the user's cache folder), never
 * longer than a few seconds, and never an error: offline or blocked simply means no proposal. CUEFLOW_NO_UPDATE_CHECK=1 switches it off.
 */
export async function checkForUpdate(env: NodeJS.ProcessEnv = process.env, current = packageVersion(), fetchImpl: typeof fetch = fetch): Promise<UpdateInfo | null> {
  if (env.CUEFLOW_NO_UPDATE_CHECK || env.CI) return null;
  const file = cacheFile(env);
  let latest: string | null = null;
  try {
    const kept = JSON.parse(await readFile(file, "utf8")) as { at: number; latest: string };
    if (Date.now() - kept.at < DAY && typeof kept.latest === "string") latest = kept.latest;
  } catch {
    // no answer kept yet
  }
  if (!latest) {
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } });
      if (!res.ok) return null;
      latest = String(((await res.json()) as { version?: string }).version ?? "");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ at: Date.now(), latest }));
    } catch {
      return null;
    }
  }
  return isNewer(latest, current) ? { current, latest, command: updateCommand() } : null;
}
