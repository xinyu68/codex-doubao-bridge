import { bridgeKey, bridgeUrl } from "./config.js";

const workerVersion = "0.3.1";
let socket;
let activeCommands = 0;
const commands = new Set([
  "ask", "read", "newChat", "tabs", "sessionOpen", "inspect", "uiClick",
  "diagnostics", "uploadImages", "videoSubmit", "videoStatus", "videoAdopt", "videoDownload", "downloadStatus"
]);
const isDoubao = (url) => {
  try { return new URL(url).protocol === "https:" && ["www.doubao.com", "doubao.com"].includes(new URL(url).hostname); }
  catch { return false; }
};

async function probeContent(tabId) {
  const result = await chrome.tabs.sendMessage(tabId, { type: "bridgePing" }, { frameId: 0 });
  if (result?.__bridgeError) throw new Error(result.__bridgeError);
  return result;
}

async function ensureContent(tabId, expectedRevision, force = false) {
  const expected = chrome.runtime.getManifest().version;
  let current;
  try { current = await probeContent(tabId); } catch { /* Missing or legacy content script. */ }
  const matches = () => current?.version === expected && current.mediaVersion === expected &&
    (!expectedRevision || (current.revision === expectedRevision && current.mediaRevision === expectedRevision));
  if (!force && matches()) return current;
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    files: ["version.js", "media-core.js", "media.js", "content.js"] });
  current = await probeContent(tabId);
  if (!matches()) {
    throw new Error("Doubao webpage script version mismatch; refresh the pinned tab once.");
  }
  return current;
}

async function messageDoubaoTab(tabId, message) {
  await ensureContent(tabId, message.contentRevision);
  const result = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  if (result?.__bridgeError) throw new Error(result.__bridgeError);
  return result;
}

async function readyTab(tabId, contentRevision) {
  const deadline = Date.now() + 20000;
  let lastError = "";
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    const target = tab.pendingUrl || tab.url;
    const waitingForAddress = !target || target === "about:blank" || target === "chrome://newtab/";
    if (!waitingForAddress && !isDoubao(target)) throw new Error("The pinned tab is no longer a Doubao page: " + new URL(target).origin);
    if (tab.status === "complete" && isDoubao(tab.url)) {
      try {
        const page = await messageDoubaoTab(tabId, { type: "inspect", contentRevision });
        if (page.editors?.length) return tab;
      } catch (error) { lastError = error.message; }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(lastError || "Doubao page/editor not ready; log in or refresh the pinned tab");
}

async function savedSessions() {
  return (await chrome.storage.local.get("mediaSessions")).mediaSessions || {};
}

async function pinnedTab(sessionId) {
  const session = (await savedSessions())[sessionId];
  if (!session) throw new Error("Pinned session not found; create or bind a media session first");
  let tab;
  try { tab = await chrome.tabs.get(session.tabId); }
  catch { throw new Error("Pinned Doubao tab was closed; no other tab was selected"); }
  if (!isDoubao(tab.url)) throw new Error("Pinned tab left Doubao; refusing to operate another page");
  return tab;
}

async function downloadStatus(downloadId) {
  if (!Number.isInteger(downloadId)) throw new Error("downloadId must be an integer");
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item) throw new Error("Browser download not found");
  return {
    downloadId: item.id, state: item.state, filename: item.state === "complete" ? item.filename : null,
    bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, error: item.error || null
  };
}

async function runCommand(message) {
  if (message.type === "diagnostics") return diagnostics();
  if (message.type === "tabs") {
    const tabs = await chrome.tabs.query({ url: ["https://www.doubao.com/*", "https://doubao.com/*"] });
    return { tabs: tabs.map((tab) => ({ tabId: tab.id, title: tab.title, url: tab.url, active: tab.active })) };
  }
  if (message.type === "sessionOpen") {
    const tab = message.tabId === undefined
      ? await chrome.tabs.create({ url: "https://www.doubao.com/chat", active: false })
      : await chrome.tabs.get(message.tabId);
    if (message.tabId !== undefined && !isDoubao(tab.pendingUrl || tab.url)) throw new Error("Only an existing Doubao tab can be bound");
    const sessions = await savedSessions();
    sessions[message.sessionId] = { tabId: tab.id, createdAt: new Date().toISOString() };
    await chrome.storage.local.set({ mediaSessions: sessions });
    try {
      const ready = await readyTab(tab.id, message.contentRevision);
      return { sessionId: message.sessionId, tabId: tab.id, url: ready.url, dedicated: message.tabId === undefined, state: "ready" };
    } catch (error) {
      return { sessionId: message.sessionId, tabId: tab.id, dedicated: message.tabId === undefined,
        state: "needs_page_ready", error: error.message };
    }
  }
  if (message.type === "downloadStatus") return downloadStatus(message.downloadId);
  let tab;
  if (message.sessionId) tab = await pinnedTab(message.sessionId);
  else {
    const tabs = await chrome.tabs.query({ url: ["https://www.doubao.com/*", "https://doubao.com/*"] });
    tab = tabs.find((item) => item.active) || tabs[0];
    if (!tab?.id) throw new Error("Open an already logged-in Doubao tab first");
  }
  if (message.type === "newChat") {
    await chrome.tabs.update(tab.id, { url: "https://www.doubao.com/chat" });
    await readyTab(tab.id, message.contentRevision);
    return { text: "New chat ready" };
  }
  if (message.type === "videoDownload") {
    const result = await messageDoubaoTab(tab.id, { type: "videoStatus", job: message.job });
    if (result.state !== "ready" || !result.media?.url) throw new Error("No verified ready video in this pinned conversation");
    const url = new URL(result.media.url);
    if (!["https:", "http:", "blob:"].includes(url.protocol)) throw new Error("Unsupported video URL");
    const extension = /\.webm(?:[?#]|$)/i.test(url.href) ? ".webm" : ".mp4";
    const baseName = message.filename.replace(/\.(?:mp4|webm)$/i, "");
    if (!/^[a-f0-9-]{36}$/i.test(baseName)) throw new Error("Invalid download filename");
    const previous = await chrome.downloads.search({ query: [baseName], orderBy: ["-startTime"], limit: 5 });
    const reusable = previous.find((item) => item.filename.includes(baseName) && ["in_progress", "complete"].includes(item.state) && item.exists !== false);
    if (reusable) return { downloadId: reusable.id, state: reusable.state, reused: true };
    const downloadId = await chrome.downloads.download({
      url: url.href, filename: "DoubaoBridge/" + baseName + extension, conflictAction: "uniquify", saveAs: false
    });
    return { downloadId, state: "in_progress" };
  }
  return messageDoubaoTab(tab.id, message);
}

function connect() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const current = new WebSocket(bridgeUrl + "?key=" + encodeURIComponent(bridgeKey));
  socket = current;
  current.onopen = () => current.send(JSON.stringify({ type: "ready", version: chrome.runtime.getManifest().version,
    workerVersion, extensionId: chrome.runtime.id, capabilities: ["mediaV1", "diagnosticsV1", "contentVersionV1"] }));
  current.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (!commands.has(message.type)) return;
    activeCommands++;
    try {
      const result = await runCommand(message);
      if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({
        type: "result", id: message.id, ok: true, text: result.text, data: result
      }));
    } catch (error) {
      if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: error.message }));
    } finally { activeCommands--; }
  };
  current.onclose = () => { if (socket === current) socket = null; };
  current.onerror = () => current.close();
}

chrome.alarms.create("bridge-heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "bridge-heartbeat") return;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  else connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

async function diagnostics() {
  const tabs = await chrome.tabs.query({ url: ["https://www.doubao.com/*", "https://doubao.com/*"] });
  const pages = await Promise.all(tabs.map(async (tab) => {
    try {
      const content = await probeContent(tab.id);
      return { tabId: tab.id, url: tab.url, ...content,
        compatible: content?.version === chrome.runtime.getManifest().version && content?.mediaVersion === workerVersion };
    } catch (error) { return { tabId: tab.id, url: tab.url, compatible: false, error: error.message }; }
  }));
  return { extensionId: chrome.runtime.id, installedVersion: chrome.runtime.getManifest().version,
    workerVersion, connected: socket?.readyState === WebSocket.OPEN, activeCommands, pages };
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!["bridgeDiagnostics", "bridgeRepair", "bridgeReconnect"].includes(message.type)) return;
  (async () => {
    if (message.type === "bridgeDiagnostics") return diagnostics();
    if (activeCommands) throw new Error("桥接正在处理任务，请完成后再操作。");
    if (message.type === "bridgeReconnect") {
      const previous = socket; socket = null; previous?.close(); connect();
      return { reconnected: true };
    }
    const tabs = await chrome.tabs.query({ url: ["https://www.doubao.com/*", "https://doubao.com/*"] });
    const results = [];
    for (const tab of tabs) {
      try { results.push({ tabId: tab.id, ...await ensureContent(tab.id, undefined, true) }); }
      catch (error) { results.push({ tabId: tab.id, error: error.message }); }
    }
    return { results };
  })().then((data) => respond({ ok: true, data }), (error) => respond({ ok: false, error: error.message }));
  return true;
});
