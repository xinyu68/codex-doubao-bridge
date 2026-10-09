import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { bridgeState, startBridge, readConfiguration } from "../service.mjs";
import { configureInstallation } from "../scripts/setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doubao-startup-"));
  t.after(async () => {
    const absolute = path.resolve(dir);
    if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(absolute).startsWith("doubao-startup-")) throw new Error("Unexpected cleanup path");
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return dir;
}
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("a running installation is reused without starting a second process", async (t) => {
  const dir = await temporary(t);
  const port = await listen(t, (_req, res) => res.end(JSON.stringify({ ok: true, connected: false, expectedDirectory: path.join(root, "extension") })));
  const result = await startBridge({ root, key: "test-key", port }, { stateDir: dir });
  assert.equal(result.running, true);
  assert.equal(result.started, false);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("wrong authentication and a different installation never trigger another server", async (t) => {
  const dir = await temporary(t);
  const unauthorized = await listen(t, (_req, res) => res.writeHead(401).end());
  await assert.rejects(startBridge({ root, key: "wrong", port: unauthorized }, { stateDir: dir }), /different bridge key/);
  const different = await listen(t, (_req, res) => res.end(JSON.stringify({ ok: true, expectedDirectory: path.join(dir, "extension") })));
  await assert.rejects(startBridge({ root, key: "test", port: different }, { stateDir: dir }), /different bridge installation/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("a stopped real backend starts once even when two starters run concurrently", async (t) => {
  const dir = await temporary(t);
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const config = { root, key: "isolated-startup-test-key", port };
  assert.equal((await bridgeState(config)).running, false);
  const results = await Promise.all([startBridge(config, { stateDir: dir }), startBridge(config, { stateDir: dir })]);
  const started = results.filter((result) => result.started);
  assert.equal(started.length, 1);
  const pid = started[0].pid;
  t.after(async () => {
    // This PID was created by this test and is never read from user state.
    try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    for (let tries = 0; tries < 50; tries++) {
      try { if (!(await bridgeState(config)).running) break; }
      catch (error) { if (error.code !== "ECONNRESET") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  assert.equal(results.every((result) => result.running), true);
  assert.equal((await bridgeState(config)).connected, false);
  assert.equal((await startBridge(config, { stateDir: dir })).started, false);
});

test("fresh setup preserves keys, unrelated Skill files and generates a portable binding", async (t) => {
  const dir = await temporary(t);
  const bridgeRoot = path.join(dir, "bridge with spaces");
  const skillHome = path.join(dir, "skills");
  await fs.mkdir(path.join(bridgeRoot, "extension"), { recursive: true });
  await fs.cp(path.join(root, "skills"), path.join(bridgeRoot, "skills"), { recursive: true });
  const first = await configureInstallation({ bridgeRoot, skillHome });
  assert.equal(first.generatedKey, true);
  const key = (await readConfiguration(bridgeRoot)).key;
  assert.match(key, /^[0-9a-f]{64}$/);
  const binding = JSON.parse(await fs.readFile(path.join(first.skillDir, "bridge-local.json"), "utf8"));
  assert.equal(binding.bridgeRoot, bridgeRoot);
  await fs.writeFile(path.join(first.skillDir, "personal-note.md"), "preserve");
  await fs.writeFile(path.join(first.skillDir, "SKILL.md"), "previous skill content");
  const second = await configureInstallation({ bridgeRoot, skillHome });
  assert.equal(second.generatedKey, false);
  assert.equal((await readConfiguration(bridgeRoot)).key, key);
  assert.equal(await fs.readFile(path.join(first.skillDir, "personal-note.md"), "utf8"), "preserve");
  assert.equal(await fs.readFile(path.join(second.skillBackup, "SKILL.md"), "utf8"), "previous skill content");
  await assert.rejects(configureInstallation({ bridgeRoot: path.join(dir, "another"), skillHome }), /bound to another/);
});
