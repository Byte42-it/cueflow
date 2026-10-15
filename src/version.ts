import { readFileSync } from "node:fs";

/** The package's own version, read from package.json (next to src/ and to build/), so it is written in one place only. */
export function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
