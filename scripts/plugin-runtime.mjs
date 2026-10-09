import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readConfiguration, bridgeState, stopIdleManagedBridge } from "../service.mjs";
import { ensureConfiguration } from "./setup.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeFiles = [
  "server.mjs", "service.mjs", "websocket.mjs", "extension-peers.mjs", "delegate.mjs",
  "managed-client.mjs", "managed-lifecycle.mjs",
  "mcp-server.mjs", "cli.mjs", "media-api.mjs", "media-cli.mjs", "media-routes.mjs", "media-files.mjs",
  "start-bridge.ps1", "run-bridge.ps1", "package.json",
  "extension/manifest.json", "extension/version.js", "extension/build.json", "extension/config.example.js",
  "extension/background.js", "extension/content.js", "extension/media.js", "extension/media-core.js",
  "extension/popup.html", "extension/popup.css", "extension/popup.js"
];
const backendFiles = new Set(["server.mjs", "websocket.mjs", "extension-peers.mjs", "delegate.mjs", "media-routes.mjs", "media-files.mjs", "managed-lifecycle.mjs", "extension/manifest.json"]);
const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
const contained = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
};

export function pluginHome(env = process.env) {
  if (env.DOUBAO_BRIDGE_HOME) {
    if (!path.isAbsolute(env.DOUBAO_BRIDGE_HOME)) throw new Error("DOUBAO_BRIDGE_HOME must be an absolute path.");
    return path.resolve(env.DOUBAO_BRIDGE_HOME);
  }
  const dataDirectory = env.LOCALAPPDATA || (process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"));
  return path.join(dataDirectory, "codex-doubao-bridge");
}

async function readBinding(home) {
  try {
    const binding = JSON.parse(await fs.readFile(path.join(home, "binding.json"), "utf8"));
    if (typeof binding.bridgeRoot !== "string" || !path.isAbsolute(binding.bridgeRoot)) throw new Error("Invalid bridgeRoot.");
    return binding;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read the plugin runtime binding. Inspect binding.json before setup.");
  }
}

export async function resolveRuntime({ home = pluginHome(), sourceRoot = packageRoot, requireCurrentVersion = false } = {}) {
  const binding = await readBinding(home);
  if (binding && requireCurrentVersion) {
    const version = JSON.parse(await fs.readFile(path.join(sourceRoot, "plugin.json"), "utf8")).version;
    if (binding.pluginVersion !== version) throw new Error("Run the plugin setup Skill to update the runtime before using Doubao tools.");
  }
  return binding?.bridgeRoot || path.join(home, "runtime");
}

async function legacyInstallation(env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const bindingFile = path.join(codexHome, "skills", "doubao-chat", "bridge-local.json");
  try {
    const binding = JSON.parse(await fs.readFile(bindingFile, "utf8"));
    if (typeof binding.bridgeRoot !== "string" || !path.isAbsolute(binding.bridgeRoot)) throw new Error("Invalid legacy bridgeRoot.");
    await readConfiguration(binding.bridgeRoot);
    return binding.bridgeRoot;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("An existing standalone Skill has an invalid binding. Inspect it before adopting or migrating.");
  }
}

export async function setupPlugin({ home = pluginHome(), sourceRoot = packageRoot, bridgeRoot, env = process.env, checkState = bridgeState } = {}) {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or newer is required.");
  await fs.mkdir(home, { recursive: true });
  const lockPath = path.join(home, "setup.lock");
  let lock;
  let updateLock;
  let updateLockPath;
  try { lock = await fs.open(lockPath, "wx"); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Another setup is active. Inspect setup.lock if an earlier setup crashed."); throw error; }
  try {
    const previous = await readBinding(home);
    if (bridgeRoot && !path.isAbsolute(bridgeRoot)) throw new Error("--bridge-root must be absolute.");
    if (previous && bridgeRoot && !samePath(previous.bridgeRoot, bridgeRoot)) throw new Error("The plugin is already bound to another runtime. Existing data was not moved.");
    const target = previous?.bridgeRoot || bridgeRoot || await legacyInstallation(env) || path.join(home, "runtime");
    if (contained(sourceRoot, target) || contained(target, sourceRoot)) throw new Error("The runtime must be outside the plugin package/cache directory.");
    // Read the complete public allowlist first. Never copy keys, media or cache state from a package.
    const sources = await Promise.all(runtimeFiles.map(async (file) => ({ file, bytes: await fs.readFile(path.join(sourceRoot, file)) })));
    const changed = [];
    for (const source of sources) {
      let old;
      try { old = await fs.readFile(path.join(target, source.file)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!old || !source.bytes.equals(old)) changed.push(source);
    }
    let configuration;
    try { await fs.access(path.join(target, "extension", "config.js")); configuration = await readConfiguration(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (configuration && changed.some(({ file }) => backendFiles.has(file))) {
      // Use the starter's lock so a new MCP cannot start partially updated backend files.
      updateLockPath = path.join(target, ".runtime", "start.lock");
      await fs.mkdir(path.dirname(updateLockPath), { recursive: true });
      try { updateLock = await fs.open(updateLockPath, "wx"); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error("Another MCP is preparing this connection. Run setup again after it completes; no files or credentials were changed.");
        throw error;
      }
      await updateLock.writeFile(JSON.stringify({ pid: process.pid }));
      await stopIdleManagedBridge(configuration, { checkState });
    }
    for (const { file, bytes } of changed) {
      const destination = path.join(target, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes);
    }
    const generatedKey = await ensureConfiguration(target);
    const version = JSON.parse(await fs.readFile(path.join(sourceRoot, "plugin.json"), "utf8")).version;
    const binding = { bridgeRoot: target, pluginVersion: version, updatedAt: new Date().toISOString() };
    const temporary = path.join(home, `binding-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(binding, null, 2) + "\n");
    await fs.rename(temporary, path.join(home, "binding.json"));
    return { configured: true, ...binding, extensionDirectory: path.join(target, "extension"), generatedKey,
      updatedFiles: changed.map(({ file }) => file), reusedExisting: !samePath(target, path.join(home, "runtime")),
      serviceStarted: false };
  } finally {
    if (updateLock) { await updateLock.close(); await fs.unlink(updateLockPath); }
    await lock.close(); await fs.unlink(lockPath);
  }
}

export async function pluginStatus({ home = pluginHome(), sourceRoot = packageRoot, checkState = bridgeState } = {}) {
  const binding = await readBinding(home);
  if (!binding) return { configured: false, home, instruction: "Run the plugin setup Skill before using Doubao." };
  const version = JSON.parse(await fs.readFile(path.join(sourceRoot, "plugin.json"), "utf8")).version;
  const state = await checkState(await readConfiguration(binding.bridgeRoot));
  return { configured: true, ...state, extensionDirectory: path.join(binding.bridgeRoot, "extension"),
    installedPluginVersion: version, runtimePluginVersion: binding.pluginVersion, needsSetup: binding.pluginVersion !== version };
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const operation = process.argv[2] || "status";
    let result;
    if (operation === "setup") {
      const index = process.argv.indexOf("--bridge-root");
      if (index >= 0 && !process.argv[index + 1]) throw new Error("--bridge-root requires a directory.");
      result = await setupPlugin({ ...(index >= 0 ? { bridgeRoot: process.argv[index + 1] } : {}) });
    } else if (operation === "status") result = await pluginStatus();
    else throw new Error("Usage: node scripts/plugin-runtime.mjs setup [--bridge-root <existing-directory>]|status");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
