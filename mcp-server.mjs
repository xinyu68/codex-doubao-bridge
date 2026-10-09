import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mediaTools, mediaRoutesByTool } from "./media-api.mjs";
import { ManagedBridgeClient } from "./managed-client.mjs";

const root = process.env.DOUBAO_BRIDGE_ROOT
  ? path.resolve(process.env.DOUBAO_BRIDGE_ROOT)
  : path.dirname(fileURLToPath(import.meta.url));
let resolveBridgeRoot = async () => root;
let client;
let closing = false;
let activeCalls = 0;

export function setBridgeRootResolver(resolver) {
  resolveBridgeRoot = resolver;
}

function bridgeKey(bridgeRoot) {
  if (process.env.DOUBAO_BRIDGE_KEY) return process.env.DOUBAO_BRIDGE_KEY;
  const extensionConfig = path.join(bridgeRoot, "extension", "config.js");
  if (!fs.existsSync(extensionConfig)) throw new Error("Doubao bridge is not configured. Run the plugin setup Skill, or scripts/install.ps1 for a standalone installation.");
  const source = fs.readFileSync(extensionConfig, "utf8");
  const match = source.match(/bridgeKey\s*=\s*["']([^"']+)["']/);
  if (!match || match[1].startsWith("REPLACE_")) {
    throw new Error("Set DOUBAO_BRIDGE_KEY or configure extension/config.js first");
  }
  return match[1];
}

async function bridge(pathname, method = "GET", body) {
  const bridgeRoot = await resolveBridgeRoot();
  const key = bridgeKey(bridgeRoot);
  const port = Number(process.env.DOUBAO_BRIDGE_PORT || 8765);
  await connect(bridgeRoot, key, port);
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "Doubao bridge request failed");
  return payload;
}

async function connect(bridgeRoot, key, port = Number(process.env.DOUBAO_BRIDGE_PORT || 8765)) {
  if (closing) throw new Error("The MCP connection is closing.");
  if (!client || client.config.root !== bridgeRoot || client.config.key !== key || client.config.port !== port) {
    client?.close();
    client = new ManagedBridgeClient({ root: bridgeRoot, key, port }, { idleMs: Number(process.env.DOUBAO_BRIDGE_IDLE_MS || 30000) });
  }
  await client.ensure();
}

function release() {
  closing = true;
  client?.close();
  if (!activeCalls) process.exit(0);
}
process.stdin.on("end", release);
process.stdin.on("error", release);
process.stdout.on("error", release);
process.on("SIGINT", release);
process.on("SIGTERM", release);

function cleanReply(text, prompt) {
  const normalize = (value) => value
    .replace(/\s+/gu, "")
    .replace(/[？?]/gu, "")
    .replace(/等于/gu, "=");
  const target = normalize(prompt);
  const lines = text.split("\n");
  const promptLine = lines.reduce((match, line, index) =>
    normalize(line) === target ? index : match, -1);
  let reply = promptLine >= 0 ? lines.slice(promptLine + 1).join("\n") : text;
  reply = reply.replace(/^\s*今天\s+\d{1,2}:\d{2}\s*/u, "").trim();
  const footerIndex = reply.indexOf("\n对话\n");
  if (footerIndex >= 0) reply = reply.slice(0, footerIndex);
  return reply.trim() || text.trim();
}

const tools = [
  {
    name: "doubao_ask",
    description: "Send one question to the currently logged-in Doubao browser session and return its reply. Set newChat to start a fresh conversation first.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The message to send to Doubao" },
        newChat: { type: "boolean", description: "Start a new Doubao conversation before sending", default: false }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  {
    name: "doubao_status",
    description: "Automatically prepare the shared local connection and check whether the Doubao Chrome extension is connected. Does not send a message or generate media.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "doubao_delegate",
    description: "Delegate one independent text task to Doubao in a new chat and return only the final answer.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete task for Doubao to finish independently" }
      },
      required: ["task"],
      additionalProperties: false
    }
  }
];

tools.push(...mediaTools);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callTool(name, args) {
  if (mediaRoutesByTool[name]) return bridge(mediaRoutesByTool[name], "POST", args);
  if (name === "doubao_status") {
    const state = await bridge("/v1/health");
    return { ...state, status: state.connected ? "connected" : "disconnected",
      instruction: state.versionMismatch ? "Chrome is running a different extension version. Check the expectedDirectory and reload that extension." : null };
  }
  if (name === "doubao_ask") {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) throw new Error("prompt must be a non-empty string");
    if (args.newChat) await bridge("/v1/new-chat", "POST");
    const result = await bridge("/v1/chat", "POST", { prompt });
    return cleanReply(result.text, prompt);
  }
  if (name === "doubao_delegate") {
    const task = String(args.task || "").trim();
    if (!task) throw new Error("task must be a non-empty string");
    const result = await bridge("/v1/delegate", "POST", { task });
    return result.text.trim();
  }
  throw new Error(`Unknown tool: ${name}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      if (request.method === "notifications/initialized") continue;
      if (request.method === "initialize") {
        // Discovery remains usable before onboarding; every later tool call rechecks the binding.
        try {
          const bridgeRoot = await resolveBridgeRoot();
          await connect(bridgeRoot, bridgeKey(bridgeRoot));
        } catch (error) { console.error(error.message); }
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "doubao-local", version: "0.5.1" }
          }
        });
        continue;
      }
      if (request.method === "tools/list") {
        send({ jsonrpc: "2.0", id: request.id, result: { tools } });
        continue;
      }
      if (request.method === "tools/call") {
        activeCalls++;
        try {
          const result = await callTool(request.params.name, request.params.arguments || {});
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          send({ jsonrpc: "2.0", id: request.id, result: {
            content: [{ type: "text", text }],
            ...(typeof result === "object" ? { structuredContent: result } : {})
          } });
        } catch (error) {
          send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: error.message }], isError: true } });
        } finally { activeCalls--; if (closing && !activeCalls) process.exit(0); }
        continue;
      }
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    } catch (error) {
      if (request?.id !== undefined) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } });
      }
    }
  }
});
