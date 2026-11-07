import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

test("the Claude plugin manifest has the package's version", () => {
  assert.equal(read(".claude-plugin/plugin.json").version, read("package.json").version,
    "bump .claude-plugin/plugin.json together with package.json");
});

test("the plugin's MCP server runs exactly this package version (the directory refuses unpinned npx)", () => {
  const args: string[] = read(".mcp.json").mcpServers.cueflow.args;
  assert.ok(args.includes(`@byte-42/cueflow@${read("package.json").version}`),
    "bump the pinned version in .mcp.json together with package.json");
});
