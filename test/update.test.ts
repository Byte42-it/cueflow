import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkForUpdate, isNewer, updateCommand } from "../src/update.ts";

const answer = (version: string) => (async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;

describe("update check", () => {
  it("compares plain versions only", () => {
    assert.equal(isNewer("0.1.44", "0.1.43"), true);
    assert.equal(isNewer("0.2.0", "0.1.99"), true);
    assert.equal(isNewer("0.1.43", "0.1.43"), false);
    assert.equal(isNewer("0.1.9", "0.1.10"), false);
    assert.equal(isNewer("1.0.0-beta.1", "0.1.43"), false);
  });
  it("proposes a newer version, keeps the answer for a day, and can be switched off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cueflow-update-"));
    try {
      const env = { XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv;
      assert.equal((await checkForUpdate(env, "0.1.43", answer("0.1.44")))?.latest, "0.1.44");
      const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
      assert.equal((await checkForUpdate(env, "0.1.43", offline))?.latest, "0.1.44"); // from the kept answer
      assert.equal(await checkForUpdate({ ...env, CUEFLOW_NO_UPDATE_CHECK: "1" }, "0.1.43", answer("9.9.9")), null);
      assert.equal(await checkForUpdate({ XDG_CACHE_HOME: path.join(dir, "x") } as NodeJS.ProcessEnv, "0.1.43", offline), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("suggests npx when started through npx", () => {
    assert.match(updateCommand("/home/a/.npm/_npx/123/node_modules/.bin/cueflow"), /^npx /);
    assert.match(updateCommand("/usr/lib/node_modules/@byte-42/cueflow/build/cli.js"), /npm install -g/);
  });
});
