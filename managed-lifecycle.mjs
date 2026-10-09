import crypto from "node:crypto";

// A streaming HTTP lease ties each client to its live MCP process, including crashes.
export function createManagedLifecycle({ managed = false, idleMs = 30000, heartbeatMs = 10000, stop }) {
  const instanceId = crypto.randomUUID();
  const clients = new Set();
  let operations = 0;
  let timer;
  let stopping = false;
  const state = () => ({ protocol: 1, managed, instanceId, clients: clients.size, operations, stopping });
  const schedule = () => {
    clearTimeout(timer);
    if (managed && !stopping && !clients.size && !operations) {
      timer = setTimeout(() => { stopping = true; stop(); }, idleMs);
    }
  };
  const attach = (response) => {
    clients.add(response);
    schedule();
    response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    response.write(JSON.stringify({ ok: true, lifecycle: state() }) + "\n");
    const heartbeat = setInterval(() => response.write('{"heartbeat":true}\n'), heartbeatMs);
    const release = () => {
      clearInterval(heartbeat);
      if (clients.delete(response)) schedule();
    };
    response.on("close", release);
    response.on("error", release);
  };
  const begin = () => {
    operations++;
    schedule();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      operations--;
      schedule();
    };
  };
  schedule();
  return {
    state, attach, begin,
    stopIfIdle() {
      if (!managed || clients.size || operations || stopping) return false;
      stopping = true;
      clearTimeout(timer);
      setImmediate(stop);
      return true;
    },
    dispose() {
      stopping = true;
      clearTimeout(timer);
      for (const response of clients) response.destroy();
    }
  };
}
