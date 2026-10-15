// The player and the docs-site runtime are plain browser files that build.ts/site.ts read next to themselves:
// copy them beside the compiled JavaScript.
import { cp } from "node:fs/promises";
for (const dir of ["player", "site"]) await cp(new URL(`../src/${dir}/`, import.meta.url), new URL(`../build/${dir}/`, import.meta.url), { recursive: true });
