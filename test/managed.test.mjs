import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeFiles } from "../scripts/plugin-runtime.mjs";
import { ManagedBridgeClient } from "../managed-client.mjs";
import { bridgeState, stopIdleManagedBridge } from "../service.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail("The expected lifecycle transition did not occur.");
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "doubao-managed-"));
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  for (const file of runtimeFiles) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(root, file));
  }
  const config = { root, port, key: "isolated-managed-test-key" };
  await fs.writeFile(path.join(root, "extension", "config.js"), 'export const bridgeKey = "isolated-managed-test-key";\n');
  const clients = [];
  const client = () => {
    const value = new ManagedBridgeClient(config, { idleMs: 600 });
    clients.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of clients) value.close();
    await until(async () => !(await bridgeState(config)).running);
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith("doubao-managed-"));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return { config, client, root };
}

test("concurrent MCP clients share one worker, and only the last client releases it", async (t) => {
  const { config, client } = await fixture(t);
  const first = client(), second = client();
  await Promise.all([first.ensure(), second.ensure(), first.ensure()]);
  const state = await bridgeState(config);
  assert.equal(state.lifecycle.clients, 2);
  assert.equal(state.lifecycle.managed, true);
  first.close();
  await until(async () => (await bridgeState(config)).lifecycle.clients === 1);
  await delay(850);
  assert.equal((await bridgeState(config)).lifecycle.instanceId, state.lifecycle.instanceId);
  const refusal = await fetch(`http://127.0.0.1:${config.port}/v1/shutdown`, {
    method: "POST", headers: { authorization: "Bearer " + config.key }
  });
  assert.equal(refusal.status, 409);
  second.close();
  await until(async () => !(await bridgeState(config)).running);
});

test("a client disconnect does not shut down an operation that is still receiving its request", async (t) => {
  const { config, client } = await fixture(t);
  const lease = client();
  await lease.ensure();
  const request = http.request({ host: "127.0.0.1", port: config.port, path: "/v1/video/status", method: "POST",
    headers: { authorization: "Bearer " + config.key, "content-type": "application/json" } });
  t.after(() => request.destroy());
  const completed = new Promise((resolve, reject) => {
    request.once("response", (response) => { response.resume(); response.once("end", resolve); });
    request.once("error", reject);
  });
  request.write("{");
  await until(async () => (await bridgeState(config)).lifecycle.operations === 1);
  lease.close();
  await delay(850);
  const state = await bridgeState(config);
  assert.equal(state.running, true);
  assert.equal(state.lifecycle.clients, 0);
  assert.equal(state.lifecycle.operations, 1);
  request.end("}");
  await completed;
  await until(async () => !(await bridgeState(config)).running);
});

test("a crashed MCP releases its lease while another MCP keeps the shared worker alive", async (t) => {
  const { config, client, root } = await fixture(t);
  const survivor = client();
  await survivor.ensure();
  const child = spawn(process.execPath, [path.join(root, "mcp-server.mjs")], {
    env: { ...process.env, DOUBAO_BRIDGE_ROOT: root, DOUBAO_BRIDGE_KEY: config.key,
      DOUBAO_BRIDGE_PORT: String(config.port), DOUBAO_BRIDGE_IDLE_MS: "600" },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
  await until(() => output.includes('"id":1'));
  const state = await bridgeState(config);
  assert.equal(state.lifecycle.clients, 2);
  assert.equal(JSON.parse(output.trim()).result.serverInfo.version, "0.5.0");
  await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
  await until(async () => (await bridgeState(config)).lifecycle.clients === 1);
  await delay(850);
  assert.equal((await bridgeState(config)).lifecycle.instanceId, state.lifecycle.instanceId);
});

test("an idle worker can exit and a later client recovers stored jobs without resubmission", async (t) => {
  const { config, client, root } = await fixture(t);
  const id = "11111111-1111-4111-8111-111111111111";
  const jobPath = path.join(root, "media", "jobs", id, "job.json");
  await fs.mkdir(path.dirname(jobPath), { recursive: true });
  const saved = JSON.stringify({ id, state: "submitted", idempotencyKey: "keep-this-attempt", sessionId: "pinned-in-extension-storage" });
  await fs.writeFile(jobPath, saved);
  const first = client();
  await first.ensure();
  const old = (await bridgeState(config)).lifecycle.instanceId;
  first.close();
  await until(async () => !(await bridgeState(config)).running);
  const next = client();
  await next.ensure();
  assert.notEqual((await bridgeState(config)).lifecycle.instanceId, old);
  assert.equal(await fs.readFile(jobPath, "utf8"), saved);
  const recovered = await fetch(`http://127.0.0.1:${config.port}/v1/video/tail`, {
    method: "POST", headers: { authorization: "Bearer " + config.key, "content-type": "application/json" },
    body: JSON.stringify({ jobId: id })
  });
  assert.match((await recovered.json()).error, /Download and verify/);
});

test("connection conflicts cannot start, replace or stop another installation", async (t) => {
  const { config, client, root } = await fixture(t);
  await client().ensure();
  const before = await bridgeState(config);
  const wrongKey = new ManagedBridgeClient({ ...config, key: "wrong-key" });
  await assert.rejects(wrongKey.ensure(), /different bridge key/);
  const otherRoot = new ManagedBridgeClient({ ...config, root: path.join(root, "other") });
  await assert.rejects(otherRoot.ensure(), /different bridge installation/);
  const refusal = await fetch(`http://127.0.0.1:${config.port}/v1/shutdown`, { method: "POST" });
  assert.equal(refusal.status, 401);
  assert.equal((await bridgeState(config)).lifecycle.instanceId, before.lifecycle.instanceId);
  assert.equal((await bridgeState(config)).lifecycle.clients, 1);
});

test("setup can stop an idle managed worker but refuses one with a live client", async (t) => {
  const { config, client } = await fixture(t);
  const lease = client();
  await lease.ensure();
  await assert.rejects(stopIdleManagedBridge(config), /service is running/);
  lease.close();
  await until(async () => (await bridgeState(config)).lifecycle.clients === 0);
  await stopIdleManagedBridge(config);
  assert.equal((await bridgeState(config)).running, false);
});

test("a surviving MCP can reconnect after an unexpected worker crash without replaying a tool", async (t) => {
  const { config, client, root } = await fixture(t);
  const lease = client();
  await lease.ensure();
  const old = (await bridgeState(config)).lifecycle.instanceId;
  const record = JSON.parse(await fs.readFile(path.join(root, ".runtime", "server.json"), "utf8"));
  // This authenticated worker was spawned by this fixture at its private port.
  process.kill(record.pid, "SIGKILL");
  await until(async () => !(await bridgeState(config)).running);
  await until(() => !lease.lease || lease.lease.destroyed);
  await lease.ensure();
  const state = await bridgeState(config);
  assert.notEqual(state.lifecycle.instanceId, old);
  assert.equal(state.lifecycle.clients, 1);
});

test("an aborted request releases its operation without crashing the shared worker", async (t) => {
  const { config, client } = await fixture(t);
  await client().ensure();
  const request = http.request({ host: "127.0.0.1", port: config.port, path: "/v1/chat", method: "POST",
    headers: { authorization: "Bearer " + config.key, "content-type": "application/json" } });
  request.on("error", () => {});
  request.write("{");
  await until(async () => (await bridgeState(config)).lifecycle.operations === 1);
  request.destroy();
  await until(async () => (await bridgeState(config)).lifecycle.operations === 0);
  assert.equal((await bridgeState(config)).lifecycle.clients, 1);
});
