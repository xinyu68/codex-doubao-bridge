import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};

export async function readConfiguration(root = projectRoot) {
  let source;
  try { source = await fs.readFile(path.join(root, "extension", "config.js"), "utf8"); }
  catch { throw new Error("Missing extension/config.js. Run scripts/install.ps1 first."); }
  const key = source.match(/bridgeKey\s*=\s*["']([^"']+)["']/)?.[1];
  const url = source.match(/bridgeUrl\s*=\s*["']([^"']+)["']/)?.[1];
  if (!key || /^(REPLACE_|CHANGE_ME)/.test(key)) throw new Error("Configure the local bridge key with scripts/install.ps1 first.");
  if (url !== "ws://127.0.0.1:8765/extension") throw new Error("This installer supports the default loopback port 8765 only.");
  return { root, key, port: 8765 };
}

// Only a refused loopback connection means stopped; authentication errors and timeouts never trigger a second server.
export function bridgeState({ root, key, port = 8765 }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/v1/health", headers: { authorization: "Bearer " + key } }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (part) => {
        raw += part;
        if (raw.length > 65536) response.destroy(new Error("Unexpected health response size."));
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode === 401) return reject(new Error("Port is occupied by a service with a different bridge key. No new server was started."));
        let data;
        try { data = JSON.parse(raw); } catch { return reject(new Error("Port is occupied by an unexpected service. No new server was started.")); }
        if (response.statusCode !== 200 || data.ok !== true || !samePath(data.expectedDirectory, path.join(root, "extension"))) {
          return reject(new Error("Port is occupied by a different bridge installation. No new server was started."));
        }
        resolve({ running: true, connected: data.connected === true, root, port,
          expectedVersion: data.expectedVersion, extensionVersion: data.extensionVersion,
          workerVersion: data.workerVersion, versionMismatch: data.versionMismatch,
          capabilities: data.capabilities || [] });
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error("Bridge health check timed out; inspect the port before restarting.")));
    request.on("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve({ running: false, connected: false, root, port });
      else reject(error);
    });
  });
}

export async function startBridge(config, { stateDir = path.join(config.root, ".runtime"), waitMs = 10000 } = {}) {
  const existing = await bridgeState(config);
  if (existing.running) return { ...existing, started: false };
  await fs.mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "start.lock");
  let lock;
  const deadline = Date.now() + waitMs;
  while (!lock && Date.now() < deadline) {
    try {
      lock = await fs.open(lockPath, "wx");
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Recover a crashed starter without terminating any process.
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probeError) { if (probeError.code === "ESRCH") await fs.unlink(lockPath); }
        }
      } catch { /* A concurrent writer may not have finished the lock yet. */ }
      await delay(150);
    }
  }
  if (!lock) throw new Error("Another bridge starter is still active; inspect .runtime/start.lock.");
  try {
    const state = await bridgeState(config);
    if (state.running) return { ...state, started: false };
    const stdout = await fs.open(path.join(stateDir, "server.log"), "a");
    const stderr = await fs.open(path.join(stateDir, "server-error.log"), "a");
    let child;
    try {
      child = spawn(process.execPath, [path.join(config.root, "server.mjs")], {
        cwd: config.root, env: { ...process.env, DOUBAO_BRIDGE_KEY: config.key, PORT: String(config.port) },
        detached: true, windowsHide: true, stdio: ["ignore", stdout.fd, stderr.fd]
      });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    } finally { await stdout.close(); await stderr.close(); }
    let childExit;
    child.once("exit", (code) => { childExit = code; });
    await fs.writeFile(path.join(stateDir, "server.json"), JSON.stringify({ pid: child.pid, root: config.root, startedAt: new Date().toISOString() }, null, 2));
    while (Date.now() < deadline) {
      if (childExit !== undefined) throw new Error("Bridge server exited during startup. See .runtime/server-error.log.");
      const current = await bridgeState(config);
      if (current.running) return { ...current, started: true, pid: child.pid };
      await delay(150);
    }
    throw new Error("Bridge startup is still unconfirmed. Inspect .runtime logs and run status; do not start another copy.");
  } finally { await lock.close(); await fs.unlink(lockPath).catch(() => undefined); }
}

async function doctor(config) {
  const state = await bridgeState(config);
  const executable = async (name) => new Promise((resolve) => {
    const child = spawn(name, ["-version"], { windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
  const [ffmpeg, ffprobe] = await Promise.all([executable(process.env.FFMPEG_PATH || "ffmpeg"), executable(process.env.FFPROBE_PATH || "ffprobe")]);
  return { ...state, nodeVersion: process.version, ffmpeg, ffprobe };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const operation = process.argv[2] || "status";
    if (!["start", "status", "doctor", "run"].includes(operation)) throw new Error("Usage: node service.mjs start|status|doctor|run");
    const config = await readConfiguration();
    if (operation === "run") {
      const child = spawn(process.execPath, [path.join(config.root, "server.mjs")], {
        env: { ...process.env, DOUBAO_BRIDGE_KEY: config.key, PORT: String(config.port) }, windowsHide: true, stdio: "inherit"
      });
      child.on("error", () => { console.error("Cannot launch the bridge server."); process.exitCode = 1; });
      child.on("exit", (code) => { process.exitCode = code ?? 1; });
    } else {
      const result = operation === "start" ? await startBridge(config) : operation === "doctor" ? await doctor(config) : await bridgeState(config);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
