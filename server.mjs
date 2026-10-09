import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import { ExtensionPeers } from "./extension-peers.mjs";
import { runDelegation } from "./delegate.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "./websocket.mjs";
import { createMediaRoutes } from "./media-routes.mjs";
import { createManagedLifecycle } from "./managed-lifecycle.mjs";

const port = Number(process.env.PORT || 8765);
const key = process.env.DOUBAO_BRIDGE_KEY;
if (!key) {
  console.error("Set DOUBAO_BRIDGE_KEY before starting the bridge.");
  process.exit(1);
}

const root = path.dirname(fileURLToPath(import.meta.url));
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8")).version;
const peers = new ExtensionPeers();
const pending = new Map();
let commandQueue = Promise.resolve();
const sockets = new Set();
const managed = process.env.DOUBAO_BRIDGE_MANAGED === "1";
const idleMs = Number(process.env.DOUBAO_BRIDGE_IDLE_MS || 30000);
if (!Number.isFinite(idleMs) || idleMs < 100) throw new Error("Invalid managed idle timeout.");
const lifecycle = createManagedLifecycle({ managed, idleMs, stop: () => {
  lifecycle.dispose();
  server.close(() => process.exit(0));
  for (const socket of sockets) socket.destroy();
} });

function hasLiveExtension() {
  return Boolean(peers.selected());
}

function sendWebSocket(socket, value) {
  socket.write(encodeFrame(JSON.stringify(value)));
}

function enqueueCommand(operation) {
  const queued = commandQueue.then(operation, operation);
  commandQueue = queued.catch(() => undefined);
  return queued;
}

function invokeExtension(type, payload, timeoutMs) {
  const extensionSocket = peers.selected();
  if (!extensionSocket) throw new Error("Chrome extension is not connected");
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.get(id).resolve({ ok: false, error: `Timed out waiting for Doubao during ${type}` });
      pending.delete(id);
    }, timeoutMs);
    pending.set(id, { socket: extensionSocket, resolve: (message) => {
      clearTimeout(timeout);
      resolve(message);
    } });
    const contentRevision = JSON.parse(fs.readFileSync(path.join(root, "extension", "build.json"), "utf8")).contentRevision;
    sendWebSocket(extensionSocket, { type, id, ...payload, contentRevision });
  });
}

async function runExtensionCommand(type, payload, timeoutMs) {
  const result = await invokeExtension(type, payload, timeoutMs);
  if (!result.ok) throw new Error(result.error || `Doubao command failed: ${type}`);
  return result.text;
}

async function runExtensionData(type, payload, timeoutMs) {
  const result = await invokeExtension(type, payload, timeoutMs);
  if (!result.ok) throw new Error(result.error || "Doubao extension command failed: " + type);
  if (!result.data) throw new Error("Reload the Chrome extension to enable mediaV1");
  return result.data;
}

function handleWebSocketMessage(body, socket) {
  try {
    const message = JSON.parse(body.toString("utf8"));
    if (message.type === "ready") {
      peers.announce(socket, message);
    }
    if (message.type === "result" && pending.get(message.id)?.socket === socket) {
      pending.get(message.id).resolve(message);
      pending.delete(message.id);
    }
  } catch {
    // Ignore malformed extension messages; the local API remains available.
  }
}

const mediaRoutes = createMediaRoutes({
  root,
  key,
  connection: () => ({ ...peers.state(expectedVersion, path.join(root, "extension")), lifecycle: lifecycle.state() }),
  enqueue: enqueueCommand,
  command: runExtensionData
});

async function handleRequest(request, response) {
  if (await mediaRoutes(request, response)) return;
  if (request.method === "POST" && request.url === "/v1/new-chat") {
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (!hasLiveExtension()) {
      response.writeHead(503).end(JSON.stringify({ error: "Chrome extension is not connected" }));
      return;
    }
    try {
      const text = await enqueueCommand(() => runExtensionCommand("newChat", {}, 20000));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, text }));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (request.method === "GET" && request.url === "/v1/latest") {
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (!hasLiveExtension()) {
      response.writeHead(503).end(JSON.stringify({ error: "Chrome extension is not connected" }));
      return;
    }
    try {
      const text = await enqueueCommand(() => runExtensionCommand("read", {}, 15000));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, text }));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (request.method !== "POST" || !["/v1/chat", "/v1/delegate"].includes(request.url)) {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${key}`) {
    response.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  let raw = "";
  for await (const part of request) raw += part;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    response.writeHead(400).end(JSON.stringify({ error: "Body must be JSON" }));
    return;
  }
  const isDelegate = request.url === "/v1/delegate";
  const input = isDelegate ? payload.task : payload.prompt;
  if (typeof input !== "string" || !input.trim()) {
    response.writeHead(400).end(JSON.stringify({ error: `${isDelegate ? "task" : "prompt"} must be a non-empty string` }));
    return;
  }
  if (!hasLiveExtension()) {
    response.writeHead(503).end(JSON.stringify({ error: "Chrome extension is not connected" }));
    return;
  }
  try {
    const text = await enqueueCommand(async () => {
      if (!isDelegate) return runExtensionCommand("ask", { prompt: input.trim() }, Number(payload.timeoutMs) || 120000);
      return runDelegation(input.trim(), (type, commandPayload, timeoutMs) =>
        runExtensionCommand(type, commandPayload, timeoutMs));
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, text }));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/v1/client" || request.url === "/v1/shutdown") {
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401).end(JSON.stringify({ ok: false, error: "Unauthorized" }) + "\n");
    } else if (request.url === "/v1/client" && request.method === "GET" && !lifecycle.state().stopping) {
      lifecycle.attach(response);
    } else if (request.url === "/v1/shutdown" && request.method === "POST" && lifecycle.stopIfIdle()) {
      response.writeHead(200).end(JSON.stringify({ ok: true }));
    } else response.writeHead(409).end(JSON.stringify({ ok: false, error: "The bridge has active clients or operations, or is not managed." }) + "\n");
    return;
  }
  if (lifecycle.state().stopping && request.url !== "/v1/health") {
    response.writeHead(503).end(JSON.stringify({ ok: false, error: "The bridge is closing. Check status before retrying; do not repeat an uncertain submission." }));
    return;
  }
  const finish = request.url === "/v1/health" ? () => {} : lifecycle.begin();
  try { await handleRequest(request, response); }
  catch (error) {
    if (!response.destroyed && !response.headersSent) response.writeHead(502).end(JSON.stringify({ ok: false, error: error.message }));
    else response.destroy();
  } finally { finish(); }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/extension" || url.searchParams.get("key") !== key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  peers.add(socket);
  const decoder = new FrameDecoder(
    (body) => handleWebSocketMessage(body, socket),
    (opcode, body) => {
      if (opcode === 9) socket.write(encodeFrame(body, 10));
      if (opcode === 8) socket.end(encodeFrame(body, 8));
    }
  );
  socket.on("data", (chunk) => {
    socket.lastSeen = Date.now();
    try { decoder.push(chunk); } catch { socket.destroy(); }
  });
  const disconnected = () => {
    peers.remove(socket);
    for (const [id, request] of pending) {
      if (request.socket !== socket) continue;
      request.resolve({ ok: false, error: "Chrome extension disconnected; inspect before retrying" });
      pending.delete(id);
    }
  };
  socket.on("close", disconnected);
  socket.on("error", disconnected);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Bridge listening at http://127.0.0.1:${port}`);
});
