import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readConfiguration } from "../service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillFiles = ["SKILL.md", "references/video-workflow.md", "references/media-tools.md", "agents/openai.yaml"];

export async function configureInstallation({ bridgeRoot = root, skillHome, replaceExisting = false }) {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or newer is required.");
  if (!skillHome) throw new Error("A skill installation directory is required.");
  const skillDir = path.join(path.resolve(skillHome), "doubao-chat");
  const bindingPath = path.join(skillDir, "bridge-local.json");
  let previousBinding;
  try { previousBinding = JSON.parse(await fs.readFile(bindingPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Cannot read the existing Skill binding; inspect it before reinstalling."); }
  if (previousBinding && path.resolve(previousBinding.bridgeRoot) !== path.resolve(bridgeRoot) && !replaceExisting) {
    throw new Error("doubao-chat is bound to another installation. Use -ReplaceExisting only when intentionally migrating.");
  }
  const sources = await Promise.all(skillFiles.map(async (file) => ({ file, bytes: await fs.readFile(path.join(bridgeRoot, "skills", "doubao-chat", file)) })));
  const configPath = path.join(bridgeRoot, "extension", "config.js");
  let generatedKey = false;
  try {
    await fs.writeFile(configPath,
      `export const bridgeKey = "${crypto.randomBytes(32).toString("hex")}";\nexport const bridgeUrl = "ws://127.0.0.1:8765/extension";\n`,
      { flag: "wx", mode: 0o600 });
    generatedKey = true;
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  await readConfiguration(bridgeRoot);
  const backupDir = path.join(bridgeRoot, ".runtime", "skill-backups", crypto.randomUUID());
  let backedUp = false;
  for (const { file, bytes } of sources) {
    const destination = path.join(skillDir, file);
    try {
      const oldBytes = await fs.readFile(destination);
      if (oldBytes.equals(bytes)) continue;
      const backup = path.join(backupDir, file);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, oldBytes);
      backedUp = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }
  if (previousBinding && previousBinding.bridgeRoot !== bridgeRoot) {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(bindingPath, path.join(backupDir, "bridge-local.json"));
    backedUp = true;
  }
  await fs.writeFile(bindingPath, JSON.stringify({ bridgeRoot: path.resolve(bridgeRoot), mcpServer: "doubao_local" }, null, 2) + "\n");
  return { bridgeRoot, skillDir, generatedKey, ...(backedUp ? { skillBackup: backupDir } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf("--skill-home");
    if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node scripts/setup.mjs --skill-home <directory> [--replace-existing]");
    console.log(JSON.stringify(await configureInstallation({ skillHome: process.argv[index + 1], replaceExisting: process.argv.includes("--replace-existing") }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
