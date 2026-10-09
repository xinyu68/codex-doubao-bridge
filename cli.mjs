import { readConfiguration } from "./service.mjs";
import { ManagedBridgeClient } from "./managed-client.mjs";

const prompt = process.argv.slice(2).join(" ");
let client;
try {
  if (!prompt) throw new Error("Usage: node cli.mjs 'Your question'");
  const config = await readConfiguration();
  client = new ManagedBridgeClient(config);
  await client.ensure();
  const response = await fetch(`http://127.0.0.1:${config.port}/v1/chat`, {
    method: "POST",
    headers: { authorization: "Bearer " + config.key, "content-type": "application/json" },
    body: JSON.stringify({ prompt })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Bridge request failed");
  console.log(body.text);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client?.close(); }
