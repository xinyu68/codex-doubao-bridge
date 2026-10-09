import http from "node:http";
import { startBridge } from "./service.mjs";

export class ManagedBridgeClient {
  constructor(config, { idleMs = 30000 } = {}) {
    this.config = config;
    this.idleMs = idleMs;
    this.closed = false;
  }

  async ensure() {
    if (this.closed) throw new Error("The MCP connection is closing.");
    if (this.lease && !this.lease.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async connect() {
    const state = await startBridge(this.config, { managed: true, idleMs: this.idleMs });
    if (this.closed) return;
    if (state.lifecycle?.protocol !== 1) {
      throw new Error("An older bridge is running. Stop that installation's old service and run setup before using the updated MCP.");
    }
    await new Promise((resolve, reject) => {
      let settled = false;
      const request = http.get({ hostname: "127.0.0.1", port: this.config.port, path: "/v1/client",
        headers: { authorization: "Bearer " + this.config.key } }, (response) => {
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (settled) return;
          buffer += chunk;
          if (buffer.length > 65536) return fail(new Error("Unexpected MCP connection response."));
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          let message;
          try { message = JSON.parse(buffer.slice(0, newline)); }
          catch { return fail(new Error("Invalid MCP connection response.")); }
          if (response.statusCode !== 200 || !message.ok || message.lifecycle?.instanceId !== state.lifecycle.instanceId) {
            return fail(new Error("Cannot register this MCP client with the expected bridge."));
          }
          settled = true;
          request.setTimeout(0);
          this.lease = request;
          if (this.closed) request.destroy();
          resolve();
        });
        response.on("error", fail);
        response.on("end", () => fail(new Error("The MCP connection closed before registration.")));
        response.on("close", () => {
          if (this.lease === request) this.lease = null;
          fail(new Error("The MCP connection closed before registration."));
        });
      });
      this.request = request;
      const fail = (error) => {
        if (!settled) { settled = true; reject(error); }
        request.destroy();
      };
      request.setTimeout(5000, () => fail(new Error("MCP connection registration timed out.")));
      request.on("error", fail);
      request.on("close", () => { if (this.request === request) this.request = null; });
      if (this.closed) fail(new Error("The MCP connection is closing."));
    });
  }

  close() {
    this.closed = true;
    this.lease?.destroy();
    this.request?.destroy();
  }
}
