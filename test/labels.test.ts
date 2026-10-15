import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

/** The LABELS object literal of a runtime file (plain browser JS, so it is read from the source). */
async function labelsOf(file: string): Promise<Record<string, Record<string, string>>> {
  const src = await readFile(path.join(import.meta.dirname, "..", "src", file), "utf8");
  const start = src.indexOf("var LABELS = {");
  assert.ok(start >= 0, `${file} has no LABELS`);
  let depth = 0, end = start + "var LABELS = ".length;
  for (; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}" && --depth === 0) break;
  }
  return new Function("return " + src.slice(start + "var LABELS = ".length, end + 1))();
}

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

for (const file of ["player/player.js", "site/site.js"]) {
  describe(`words of ${file}`, () => {
    it("has every word in every language, with the same placeholders as English", async () => {
      const labels = await labelsOf(file);
      const en = labels.en!;
      for (const [lang, words] of Object.entries(labels)) {
        assert.deepEqual(Object.keys(words).sort(), Object.keys(en).sort(), `${lang}: same keys as en`);
        for (const k of Object.keys(en)) assert.deepEqual(vars(words[k]!), vars(en[k]!), `${lang}.${k}: same placeholders as en`);
      }
    });
  });
}

describe("player words", () => {
  it("says what the big button does before, at the end, and when a link starts from a step", async () => {
    const labels = await labelsOf("player/player.js");
    for (const words of Object.values(labels)) for (const k of ["start", "note", "ended", "again", "resume"]) assert.ok(words[k], k);
    assert.equal(labels.it!.step, "Passo", "#passo-3 is read as a link to step 3 in an Italian guide");
  });
});
