function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}
function compare(left, right) {
  const a = versionParts(left.workerVersion || left.version);
  const b = versionParts(right.workerVersion || right.version);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
export class ExtensionPeers {
  constructor(now = () => Date.now()) { this.now = now; this.sockets = new Set(); this.current = null; }
  add(socket) { socket.connectedAt = this.now(); socket.lastSeen = this.now(); this.sockets.add(socket); }
  announce(socket, message) {
    socket.ready = true;
    socket.version = typeof message.version === "string" ? message.version : null;
    socket.workerVersion = typeof message.workerVersion === "string" ? message.workerVersion : null;
    socket.extensionId = typeof message.extensionId === "string" ? message.extensionId : null;
    socket.capabilities = Array.isArray(message.capabilities) ? message.capabilities.filter((item) => typeof item === "string") : [];
    this.selected();
  }
  remove(socket) { this.sockets.delete(socket); if (this.current === socket) this.current = null; }
  live() { return [...this.sockets].filter((socket) => socket.ready && !socket.destroyed && this.now() - socket.lastSeen < 70000); }
  selected() {
    const live = this.live();
    if (!live.includes(this.current)) this.current = live[0] || null;
    for (const socket of live) if (!this.current || compare(socket, this.current) > 0) this.current = socket;
    return this.current;
  }
  state(expectedVersion, expectedDirectory) {
    const selected = this.selected();
    return { connected: Boolean(selected), expectedVersion, expectedDirectory,
      extensionVersion: selected?.version || null, workerVersion: selected?.workerVersion || null,
      extensionId: selected?.extensionId || null, capabilities: selected?.capabilities || [],
      versionMismatch: Boolean(selected && (selected.version !== expectedVersion ||
        (selected.workerVersion && selected.workerVersion !== expectedVersion))),
      clients: this.live().map((socket) => ({ selected: socket === selected, version: socket.version,
        workerVersion: socket.workerVersion, extensionId: socket.extensionId,
        connectedAt: new Date(socket.connectedAt).toISOString() })) };
  }
}
