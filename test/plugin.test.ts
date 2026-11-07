import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

test("the Claude plugin manifest has the package's version", () => {
  assert.equal(read(".claude-plugin/plugin.json").version, read("package.json").version,
    "bump .claude-plugin/plugin.json together with package.json");
});
