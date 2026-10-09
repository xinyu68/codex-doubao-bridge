import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeFiles, setupPlugin, pluginStatus, resolveRuntime } from "../scripts/plugin-runtime.mjs";
import { readConfiguration } from "../service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "doubao-plugin-"));
  t.after(async () => {
    const absolute = path.resolve(directory);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith("doubao-plugin-"));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const home = path.join(directory, "data with spaces");
  const sourceRoot = path.join(directory, "cache v1");
  const env = { ...process.env, CODEX_HOME: path.join(directory, "codex"), DOUBAO_BRIDGE_HOME: home };
  for (const file of [...runtimeFiles, "plugin.json"]) {
    const destination = path.join(sourceRoot, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, file), destination);
  }
  return { directory, home, sourceRoot, env, checkState: async () => ({ running: false, connected: false }) };
}

test("plugin setup separates cache from user data and preserves keys and jobs across updates", async (t) => {
  const options = await fixture(t);
  assert.equal((await pluginStatus(options)).configured, false);
  await fs.writeFile(path.join(options.sourceRoot, "extension", "config.js"), 'export const bridgeKey = "do-not-distribute-this-source-key";');
  const first = await setupPlugin(options);
  assert.equal(first.serviceStarted, false);
  assert.equal(first.generatedKey, true);
  const key = (await readConfiguration(first.bridgeRoot)).key;
  assert.match(key, /^[0-9a-f]{64}$/);
  const job = path.join(first.bridgeRoot, "media", "jobs", "saved", "job.json");
  await fs.mkdir(path.dirname(job), { recursive: true });
  await fs.writeFile(job, '{"jobId":"saved","status":"submitted"}');
  const nextRoot = path.join(options.directory, "cache v2");
  await fs.cp(options.sourceRoot, nextRoot, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(nextRoot, "plugin.json"), "utf8"));
  manifest.version = "0.4.1";
  await fs.writeFile(path.join(nextRoot, "plugin.json"), JSON.stringify(manifest));
  assert.equal((await pluginStatus({ ...options, sourceRoot: nextRoot })).needsSetup, true);
  const second = await setupPlugin({ ...options, sourceRoot: nextRoot });
  assert.equal(second.bridgeRoot, first.bridgeRoot);
  assert.equal(second.generatedKey, false);
  assert.equal((await readConfiguration(second.bridgeRoot)).key, key);
  assert.equal(JSON.parse(await fs.readFile(job, "utf8")).jobId, "saved");
  assert.equal((await pluginStatus({ ...options, sourceRoot: nextRoot })).needsSetup, false);
  assert.equal(await resolveRuntime(options), first.bridgeRoot);
  await assert.rejects(setupPlugin({ ...options, bridgeRoot: path.join(options.directory, "other") }), /already bound/);
});

test("existing standalone installation is adopted without moving its extension or media", async (t) => {
  const options = await fixture(t);
  const bridgeRoot = path.join(options.directory, "legacy bridge");
  await setupPlugin({ ...options, home: path.join(options.directory, "legacy setup"), bridgeRoot });
  const key = (await readConfiguration(bridgeRoot)).key;
  const skill = path.join(options.env.CODEX_HOME, "skills", "doubao-chat");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "bridge-local.json"), JSON.stringify({ bridgeRoot, mcpServer: "doubao_local" }));
  await fs.mkdir(path.join(bridgeRoot, "media"), { recursive: true });
  await fs.writeFile(path.join(bridgeRoot, "media", "existing.mp4"), "preserve-existing-video");
  const result = await setupPlugin(options);
  assert.equal(result.bridgeRoot, bridgeRoot);
  assert.equal(result.reusedExisting, true);
  assert.equal(result.generatedKey, false);
  assert.equal((await readConfiguration(bridgeRoot)).key, key);
  assert.equal(await fs.readFile(path.join(bridgeRoot, "media", "existing.mp4"), "utf8"), "preserve-existing-video");
});

test("running backend update and cache-contained runtime are refused before changing public files", async (t) => {
  const options = await fixture(t);
  const first = await setupPlugin(options);
  const target = path.join(first.bridgeRoot, "server.mjs");
  const original = await fs.readFile(target);
  await fs.appendFile(path.join(options.sourceRoot, "server.mjs"), "\n// new backend\n");
  await assert.rejects(setupPlugin({ ...options, checkState: async () => ({ running: true }) }), /service is running/);
  assert.deepEqual(await fs.readFile(target), original);
  const applied = await setupPlugin(options);
  assert.ok(applied.updatedFiles.includes("server.mjs"));
  await assert.rejects(setupPlugin({ ...options, home: path.join(options.directory, "other-home"), bridgeRoot: path.join(options.sourceRoot, "runtime") }), /outside the plugin/);
});

test("MCP starts before setup and resolves a later adoption without restarting or starting the bridge", async (t) => {
  const options = await fixture(t);
  const mock = path.join(options.directory, "mock-fetch.mjs");
  await fs.writeFile(mock, 'globalThis.fetch = async (_url, request) => ({ok:true,json:async()=>({ok:true,connected:false,authorized:request.headers.authorization === "Bearer isolated-test-key"})});\n');
  const child = spawn(process.execPath, ["--import", pathToFileURL(mock).href, path.join(root, "scripts", "plugin-mcp.mjs")], {
    env: { ...options.env, DOUBAO_BRIDGE_KEY: "" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    }
  });
  let buffer = "";
  let id = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => reject(new Error("MCP response timed out")), 5000);
    pending.set(requestId, (message) => { clearTimeout(timeout); pending.delete(requestId); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  assert.equal((await call("initialize", { protocolVersion: "2024-11-05" })).result.serverInfo.version, "0.4.0");
  const listed = await call("tools/list");
  assert.ok(listed.result.tools.some((tool) => tool.name === "doubao_video_submit"));
  assert.equal((await call("tools/call", { name: "doubao_status" })).result.isError, true);
  const bridgeRoot = path.join(options.directory, "adopted after initialization");
  await fs.mkdir(path.join(bridgeRoot, "extension"), { recursive: true });
  await fs.writeFile(path.join(bridgeRoot, "extension", "config.js"), 'export const bridgeKey = "isolated-test-key";\n');
  await fs.mkdir(options.home, { recursive: true });
  await fs.writeFile(path.join(options.home, "binding.json"), JSON.stringify({ bridgeRoot }));
  const response = await call("tools/call", { name: "doubao_status" });
  assert.equal(response.result.structuredContent.authorized, true);
  await assert.rejects(fs.access(path.join(options.home, "runtime")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(bridgeRoot, ".runtime", "server.json")), { code: "ENOENT" });
});
