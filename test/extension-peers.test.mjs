import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionPeers } from "../extension-peers.mjs";
test("a later legacy connection cannot displace a connected newer extension", () => {
  const peers = new ExtensionPeers(() => 1000);
  const current = {}, legacy = {};
  peers.add(current); peers.announce(current, { version: "0.3.1", workerVersion: "0.3.1", extensionId: "new", capabilities: ["mediaV1"] });
  peers.add(legacy); peers.announce(legacy, { version: "0.2.0", capabilities: ["mediaV1"] });
  assert.equal(peers.selected(), current);
  const health = peers.state("0.3.1", "extension");
  assert.equal(health.clients.length, 2);
  assert.equal(health.versionMismatch, false);
  peers.remove(current);
  assert.equal(peers.selected(), legacy);
  assert.equal(peers.state("0.3.1", "extension").versionMismatch, true);
});
test("an expired or unannounced connection is not reported as usable", () => {
  let now = 0;
  const peers = new ExtensionPeers(() => now); const client = {};
  peers.add(client); assert.equal(peers.selected(), null);
  peers.announce(client, { version: "0.3.1" }); assert.equal(peers.selected(), client);
  now = 70001; assert.equal(peers.selected(), null);
});
