import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mediaToolsByOperation } from "./media-api.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--request") {
  console.error("Usage: node media-cli.mjs --request <request.json>");
  process.exit(1);
}
const request = JSON.parse((await fs.readFile(path.resolve(args[1]), "utf8")).replace(/^\uFEFF/, ""));
const name = mediaToolsByOperation[request.operation];
if (!name) throw new Error("Unknown operation: " + request.operation);
const { operation, ...parameters } = request;
const root = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(root, "mcp-server.mjs")], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
let buffer = "";
let finished = false;
const deadline = setTimeout(() => {
  if (!finished) console.error("Request timed out. Inspect the existing job before submitting anything again.");
  child.kill();
  process.exitCode = 1;
}, 150000);
child.on("error", (error) => { console.error(error.message); clearTimeout(deadline); process.exitCode = 1; });
child.on("exit", (code) => {
  clearTimeout(deadline);
  if (!finished) { console.error("MCP process exited before returning the result: " + code); process.exitCode = 1; }
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: parameters } }) + "\n");
    } else if (message.id === 2) {
      finished = true;
      const result = message.result;
      if (result?.structuredContent) process.stdout.write(JSON.stringify(result.structuredContent, null, 2) + "\n");
      else for (const content of result?.content || []) if (content.type === "text") process.stdout.write(content.text + "\n");
      if (result?.isError || message.error) process.exitCode = 1;
      clearTimeout(deadline);
      child.kill();
    }
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
