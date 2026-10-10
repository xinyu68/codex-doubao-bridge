import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import vm from "node:vm";
import { File } from "node:buffer";
import { encodeFrame, FrameDecoder } from "../websocket.mjs";
import { createMediaRoutes } from "../media-routes.mjs";
import { loadImages } from "../media-files.mjs";

function clientFrame(text, final = true, opcode = 1) {
  const encoded = encodeFrame(Buffer.from(text), opcode);
  encoded[0] = (final ? 0x80 : 0) | opcode;
  const headerLength = encoded[1] === 127 ? 10 : encoded[1] === 126 ? 4 : 2;
  const mask = Buffer.from([11, 29, 53, 71]);
  const body = Buffer.from(encoded.subarray(headerLength));
  for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
  const header = Buffer.from(encoded.subarray(0, headerLength));
  header[1] |= 0x80;
  return Buffer.concat([header, mask, body]);
}

test("image-size messages use 64-bit framing and decode across packet boundaries", () => {
  const body = JSON.stringify({ image: "a".repeat(100000) });
  const encoded = encodeFrame(body);
  assert.equal(encoded[1], 127);
  assert.equal(Number(encoded.readBigUInt64BE(2)), Buffer.byteLength(body));
  const result = [];
  const decoder = new FrameDecoder((value) => result.push(value.toString()));
  const frame = clientFrame(body);
  for (let start = 0; start < frame.length; start += 997) decoder.push(frame.subarray(start, start + 997));
  assert.deepEqual(result, [body]);
});

test("fragmented messages survive interleaved ping frames", () => {
  const messages = [];
  const controls = [];
  const decoder = new FrameDecoder((value) => messages.push(value.toString()), (opcode) => controls.push(opcode));
  decoder.push(Buffer.concat([clientFrame("hello", false), clientFrame("ping", true, 9), clientFrame(" world", true, 0)]));
  assert.deepEqual(messages, ["hello world"]);
  assert.deepEqual(controls, [9]);
});

test("oversized and unmasked frames are rejected", () => {
  assert.throws(() => new FrameDecoder(() => {}).push(encodeFrame("x")), /masked/);
  const header = Buffer.alloc(10);
  header[0] = 0x81; header[1] = 0xff;
  header.writeBigUInt64BE(100000000n, 2);
  assert.throws(() => new FrameDecoder(() => {}).push(header), /too large/);
});

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doubao-test-"));
  t.after(async () => {
    const absolute = path.resolve(dir);
    if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(absolute).startsWith("doubao-test-")) throw new Error("Unexpected cleanup path");
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return dir;
}

test("image loading preserves real file bytes and rejects mislabeled non-images", async (t) => {
  const dir = await temporary(t);
  const png = path.join(dir, "real.png");
  const bytes = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(100000)]);
  await fs.writeFile(png, bytes);
  const [image] = await loadImages([png]);
  assert.equal(image.mime, "image/png");
  assert.deepEqual(Buffer.from(image.base64, "base64"), bytes);
  const invalid = path.join(dir, "fake.png");
  await fs.writeFile(invalid, "plain text");
  await assert.rejects(loadImages([invalid]), /Only PNG/);
  await assert.rejects(loadImages(["relative.png"]), /absolute/);
});

async function gateway(t, implementation, connected = { connected: true, capabilities: ["mediaV1"] }, existingRoot) {
  const root = existingRoot || await temporary(t);
  let queue = Promise.resolve();
  const handler = createMediaRoutes({
    root, key: "test-key", connection: () => connected,
    enqueue(operation) { const next = queue.then(operation, operation); queue = next.catch(() => {}); return next; },
    command: implementation
  });
  const server = http.createServer(async (request, response) => {
    if (!await handler(request, response)) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (route, body, key = "test-key") => {
    const response = await fetch(base + route, { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { call, root };
}
const specification = { sessionId: "11111111-1111-4111-8111-111111111111", prompt: "one action", idempotencyKey: "clip-01", duration: 5, ratio: "9:16" };

test("concurrent retries submit only once and survive a restarted job store", async (t) => {
  let calls = 0;
  const implementation = async () => { calls++; return { state: "submitted", context: { conversationUrl: "https://www.doubao.com/chat/123" } }; };
  const { call, root } = await gateway(t, implementation);
  const replies = await Promise.all([call("/v1/video/submit", specification), call("/v1/video/submit", specification)]);
  assert.equal(calls, 1);
  assert.equal(replies[0].data.jobId, replies[1].data.jobId);
  assert.equal(replies.filter((reply) => reply.data.reused).length, 1);
  const restarted = await gateway(t, implementation, undefined, root);
  const recovered = await restarted.call("/v1/video/submit", specification);
  assert.equal(recovered.data.reused, true);
  assert.equal(calls, 1);
  const conflict = await call("/v1/video/submit", { ...specification, prompt: "different action" });
  assert.equal(conflict.status, 400);
  assert.equal(calls, 1);
  const jobs = await fs.readdir(path.join(root, "media", "jobs"));
  assert.equal(jobs.length, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(root, "media", "jobs", jobs[0], "job.json"), "utf8"));
  assert.equal(persisted.state, "submitted");
});

test("uncertain submissions keep a job and never resubmit automatically", async (t) => {
  let calls = 0;
  const { call } = await gateway(t, async () => { calls++; throw new Error("connection lost after send"); });
  const first = await call("/v1/video/submit", specification);
  assert.equal(first.data.state, "unknown");
  assert.equal(first.data.retrySafe, false);
  const retry = await call("/v1/video/submit", specification);
  assert.equal(retry.data.jobId, first.data.jobId);
  assert.equal(retry.data.reused, true);
  assert.equal(calls, 1);
});

test("an old extension is blocked before generation and unauthenticated requests cannot read the page", async (t) => {
  let calls = 0;
  const { call } = await gateway(t, async () => { calls++; }, { connected: true, capabilities: [] });
  assert.equal((await call("/v1/video/submit", specification)).status, 400);
  assert.equal((await call("/v1/page", { sessionId: specification.sessionId }, "wrong-key")).status, 401);
  assert.equal(calls, 0);
});

test("an old media-capable extension cannot bypass prepared submission checks", async (t) => {
  let calls = 0;
  const { call } = await gateway(t, async () => { calls++; }, { connected: true, capabilities: ["mediaV1"] });
  assert.equal((await call("/v1/video/submit", { ...specification, requirePrepared: true })).status, 400);
  assert.equal(calls, 0);
});

async function mediaContext() {
  const context = vm.createContext({ URL, console, atob: (input) => Buffer.from(input, "base64").toString("binary"), Uint8Array, File,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; } });
  vm.runInContext(await fs.readFile(new URL("../extension/media-core.js", import.meta.url), "utf8"), context);
  return context;
}

test("completion requires a new ready video; old clips and success promises do not count", async () => {
  const context = await mediaContext();
  const classify = context.DoubaoMediaCore.classifyMedia;
  const old = { url: "https://example.test/old.mp4", duration: 5, readyState: 4 };
  assert.equal(classify({ videos: [old], baselineUrls: [old.url], text: "视频已生成好，稍后发送" }).state, "pending");
  assert.equal(classify({ videos: [{ url: "https://example.test/new.mp4", duration: null, readyState: 0 }] }).state, "pending");
  assert.equal(classify({ videos: [old, { url: "https://example.test/new.mp4", duration: 5, readyState: 1 }], baselineUrls: [old.url] }).state, "ready");
  assert.equal(classify({ videos: [], text: "排队中" }).state, "queued");
});

async function uploadPage() {
  const context = await mediaContext();
  const previews = [];
  const form = { id: "composer", tagName: "FORM", innerText: "视频生成 Seedance 2.0 Mini 自动·10s 9:16",
    querySelectorAll: (query) => query === "img" ? previews : [] };
  class TextArea {
    constructor() { this.value = ""; this.id = "editor"; this.tagName = "TEXTAREA"; }
    getAttribute() { return null; }
    getClientRects() { return [{}]; }
    closest() { return form; }
  }
  class Input {
    constructor() { this.id = "upload"; this.type = "file"; this.accept = "image/*"; this.multiple = true; this.files = []; this.parentElement = { innerText: "" }; }
    getAttribute() { return ""; }
    dispatchEvent(event) {
      if (event.type === "change") {
        for (const file of this.files) previews.push({ src: "blob:" + file.name, complete: true, naturalWidth: 100, getClientRects: () => [{}] });
      }
    }
  }
  class Transfer {
    constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
  }
  const editor = new TextArea();
  const input = new Input();
  context.document = {
    body: { innerText: "", textContent: "" },
    documentElement: {},
    querySelectorAll: (query) => {
      if (query === "textarea, [contenteditable='true']") return [editor];
      if (query === "input[type='file']" || query === "#upload") return [input];
      return [];
    }
  };
  context.HTMLTextAreaElement = TextArea; context.HTMLInputElement = Input; context.DataTransfer = Transfer;
  context.Event = class { constructor(type) { this.type = type; } };
  context.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  context.location = { href: "https://www.doubao.com/chat/123", origin: "https://www.doubao.com", pathname: "/chat/123" };
  context.CSS = { escape: (value) => value };
  let sends = 0;
  context.DoubaoChat = {
    enterPrompt: (field, prompt) => { field.value = prompt; },
    sendPrompt: async (field) => { sends++; context.document.body.textContent = field.value; context.document.body.innerText = field.value; field.value = ""; }
  };
  vm.runInContext(await fs.readFile(new URL("../extension/media.js", import.meta.url), "utf8"), context);
  const images = [{ name: "cast.png", mime: "image/png", base64: Buffer.from("actual bytes").toString("base64") }];
  return { context, editor, input, images, previews, sends: () => sends };
}

test("upload sends real File bytes and requires visible loaded previews before submission", async () => {
  const { context, input, images, sends } = await uploadPage();
  const uploaded = await context.DoubaoMedia.handle({ type: "uploadImages", images });
  assert.equal(uploaded.confirmation, "loaded_preview");
  assert.equal(input.files[0].name, "cast.png");
  assert.equal(await input.files[0].text(), "actual bytes");
  const submitted = await context.DoubaoMedia.handle({ type: "videoSubmit", images: [], imageRole: "reference", duration: 5, ratio: "9:16", prompt: "flip a ledger" });
  assert.equal(submitted.state, "submitted");
  assert.equal(sends(), 1);
  assert.match(submitted.context.prompt, /flip a ledger/);
});

test("ordinary image upload cannot be reported as a verified first-frame upload", async () => {
  const { context, input, images } = await uploadPage();
  await assert.rejects(context.DoubaoMedia.handle({ type: "uploadImages", images, inputSelector: "#upload", imageRole: "first_frame" }), /not labeled/);
  assert.equal(input.files.length, 0);
});

test("switching the pinned conversation does not return an unrelated completed video", async () => {
  const { context } = await uploadPage();
  const result = await context.DoubaoMedia.handle({ type: "videoStatus", job: { context: { conversationUrl: "https://www.doubao.com/chat/different" } } });
  assert.equal(result.state, "conversation_mismatch");
});

test("an unsent draft is preserved before uploading or sending a video request", async () => {
  const { context, editor, input, images, sends } = await uploadPage();
  editor.value = "keep my draft";
  const result = await context.DoubaoMedia.handle({ type: "videoSubmit", images, duration: 5, ratio: "9:16", prompt: "test" });
  assert.equal(result.state, "preflight_failed");
  assert.equal(result.sendAttempted, false);
  assert.equal(result.retrySafe, true);
  assert.match(result.error, /unsent draft/);
  assert.equal(editor.value, "keep my draft");
  assert.equal(input.files.length, 0);
  assert.equal(sends(), 0);
});

test("tail extraction selects the final decoded blue frame, not the earlier red near-tail frame", async (t) => {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const execute = promisify(execFile);
  const { extractTail } = await import("../media-files.mjs");
  const dir = await temporary(t);
  const clip = path.join(dir, "red-then-blue.mp4");
  const tail = path.join(dir, "tail.png");
  await execute(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=1.8",
    "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=0.2",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip
  ], { windowsHide: true, timeout: 30000 });
  const result = await extractTail(clip, tail);
  assert.equal(result.width, 64);
  assert.equal(result.height, 64);
  const { stdout } = await execute(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", tail, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"
  ], { encoding: "buffer", windowsHide: true, timeout: 30000 });
  assert.ok(stdout[2] > 220 && stdout[0] < 30 && stdout[1] < 30, "Expected the final blue frame");
});

async function backgroundContext(overrides = {}, probe = async () => ({ version: "0.4.0", mediaVersion: "0.4.0" })) {
  const chrome = {
    tabs: { get: async () => ({ id: 123, url: "https://www.doubao.com/chat", status: "complete" }),
      sendMessage: async () => ({ editors: [{ selector: "textarea" }] }) },
    storage: { local: { get: async () => ({ mediaSessions: { test: { tabId: 123 } } }), set: async () => {} } },
    downloads: { search: async () => [], download: async () => 42 },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { id: "test-extension", getManifest: () => ({ version: "0.4.0" }), onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    scripting: { executeScript: async () => {} }
  };
  Object.assign(chrome, overrides);
  const originalSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = (tabId, message, ...args) => message.type === "bridgePing" ? probe(tabId, message, ...args) : originalSend(tabId, message, ...args);
  class Socket { static OPEN = 1; static CONNECTING = 0; constructor() { this.readyState = 1; } }
  const context = vm.createContext({ chrome, WebSocket: Socket, URL, console, Date,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; } });
  let source = await fs.readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  source = source.replace('import { bridgeKey, bridgeUrl } from "./config.js";',
    'const bridgeKey = "test-key"; const bridgeUrl = "ws://test.invalid";');
  vm.runInContext(source + "\nglobalThis.testReadyTab = readyTab; globalThis.testCommand = runCommand; globalThis.testEnsureContent = ensureContent;", context);
  return context;
}

test("a new tab's temporary blank/pending URL is awaited before page inspection", async () => {
  let count = 0;
  const context = await backgroundContext({ tabs: {
    get: async () => {
      count++;
      if (count === 1) return { id: 123, url: "about:blank", pendingUrl: "https://www.doubao.com/chat", status: "loading" };
      if (count === 2) return { id: 123, url: "https://www.doubao.com/chat", status: "loading" };
      return { id: 123, url: "https://www.doubao.com/chat", status: "complete" };
    },
    sendMessage: async () => ({ editors: [{ selector: "textarea" }] })
  } });
  const result = await context.testReadyTab(123);
  assert.equal(result.url, "https://www.doubao.com/chat");
  assert.equal(count, 3);
});

test("a browser download already started for a job is reused after response loss", async () => {
  let starts = 0;
  const id = "11111111-1111-4111-8111-111111111111";
  const context = await backgroundContext({
    tabs: {
      get: async () => ({ id: 123, url: "https://www.doubao.com/chat", status: "complete" }),
      sendMessage: async () => ({ state: "ready", media: { url: "https://example.test/video.mp4" } })
    },
    downloads: {
      search: async () => [{ id: 42, state: "in_progress", filename: "/Downloads/DoubaoBridge/" + id + ".mp4" }],
      download: async () => { starts++; return 43; }
    }
  });
  const result = await context.testCommand({ type: "videoDownload", sessionId: "test", job: {}, filename: id + ".mp4" });
  assert.equal(result.downloadId, 42);
  assert.equal(result.reused, true);
  assert.equal(starts, 0);
});

async function chatPage(responseText) {
  let clock = 0;
  let listener;
  class Element {
    getClientRects() { return [{}]; }
    getAttribute() { return null; }
    focus() {}
    dispatchEvent() {}
  }
  class TextArea extends Element {
    constructor() { super(); this._value = ""; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
  }
  const input = new TextArea();
  const body = { innerText: "initial home" };
  const button = new Element();
  button.disabled = false;
  button.click = () => { input.value = ""; body.innerText = responseText; };
  const context = vm.createContext({
    HTMLElement: Element, HTMLTextAreaElement: TextArea,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class {},
    Date: { now: () => clock },
    setTimeout: (callback, milliseconds) => { clock += milliseconds; queueMicrotask(callback); return 1; },
    chrome: { runtime: { onMessage: { addListener: (callback) => { listener = callback; } } } },
    document: { body, querySelector: (query) => query === "#flow-end-msg-send" ? button : null,
      querySelectorAll: (query) => query === "textarea, [contenteditable='true']" ? [input] : [] }
  });
  vm.runInContext(await fs.readFile(new URL("../extension/content.js", import.meta.url), "utf8"), context);
  return new Promise((resolve) => listener({ type: "ask", prompt: "bridgecheck" }, {}, resolve));
}

test("legacy chat rejects home/sidebar changes instead of claiming a reply", async () => {
  const result = await chatPage("下载电脑版\n有什么我能帮你的吗？\nsidebar");
  assert.match(result.__bridgeError, /Timed out/);
  assert.equal(result.text, undefined);
});

test("legacy chat still reads an actual response following the submitted prompt", async () => {
  const result = await chatPage("bridgecheck\nactual reply");
  assert.equal(result.text, "actual reply");
});

test("session creation preserves a pending Doubao tab instead of rejecting its blank URL", async () => {
  let saved;
  const context = await backgroundContext({
    tabs: {
      create: async () => ({ id: 123, url: "about:blank", pendingUrl: "https://www.doubao.com/chat", status: "loading" }),
      get: async () => ({ id: 123, url: "https://www.doubao.com/chat", status: "complete" }),
      sendMessage: async () => ({ editors: [{ selector: "textarea" }] })
    },
    storage: { local: { get: async () => ({}), set: async (value) => { saved = value; } } }
  });
  const result = await context.testCommand({ type: "sessionOpen", sessionId: "test-new" });
  assert.equal(result.state, "ready");
  assert.equal(result.dedicated, true);
  assert.equal(saved.mediaSessions["test-new"].tabId, 123);
});

test("hidden upload inputs outside the composer do not make a real attachment input ambiguous", async () => {
  const { context, input, images } = await uploadPage();
  const outside = new context.HTMLInputElement();
  const original = context.document.querySelectorAll;
  context.document.querySelectorAll = (query) => query === "input[type='file']" ? [outside, input] : original(query);
  const form = context.document.querySelectorAll("textarea, [contenteditable='true']")[0].closest("form");
  form.contains = (element) => element === input;
  const result = await context.DoubaoMedia.handle({ type: "uploadImages", images });
  assert.equal(result.confirmation, "loaded_preview");
  assert.equal(outside.files.length, 0);
  assert.equal(input.files[0].name, "cast.png");
});

test("a stale webpage script is updated before a media operation, without resending the operation", async () => {
  let injected = 0;
  const context = await backgroundContext({ scripting: { executeScript: async ({ files }) => {
    assert.ok(files.includes("version.js")); injected++;
  } } }, async () => ({ version: injected ? "0.4.0" : "0.2.1", mediaVersion: injected ? "0.4.0" : "0.2.1" }));
  const result = await context.testEnsureContent(123);
  assert.equal(result.version, "0.4.0");
  assert.equal(injected, 1);
});

test("read-only diagnostics reports stale scripts without injecting or refreshing a page", async () => {
  let injected = 0;
  const context = await backgroundContext({
    tabs: { query: async () => [{ id: 123, url: "https://www.doubao.com/chat/123" }] },
    scripting: { executeScript: async () => { injected++; } }
  }, async () => ({ version: "0.2.1", mediaVersion: "0.2.1" }));
  const result = await context.testCommand({ type: "diagnostics" });
  assert.equal(result.pages[0].compatible, false);
  assert.equal(injected, 0);
});

test("new content listeners replace previous tracked listeners instead of sending twice", async () => {
  const listeners = new Set();
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) } } }
  });
  const source = await fs.readFile(new URL("../extension/content.js", import.meta.url), "utf8");
  context.DoubaoBridgeVersion = "0.4.0";
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  assert.equal(listeners.size, 1);
  context.DoubaoBridgeVersion = "0.4.0";
  vm.runInContext(source, context);
  assert.equal(listeners.size, 1);
  assert.equal(context.__doubaoBridgeController.version, "0.4.0");
});

test("legacy untracked webpage listeners require a refresh and are not doubled", async () => {
  let registered = 0;
  const context = vm.createContext({ __doubaoBridgeContentReady: true,
    chrome: { runtime: { onMessage: { addListener: () => { registered++; } } } }
  });
  const source = await fs.readFile(new URL("../extension/content.js", import.meta.url), "utf8");
  assert.throws(() => vm.runInContext(source, context), /Legacy webpage script/);
  assert.equal(registered, 0);
});

test("diagnostics stays usable while an old extension is connected", async (t) => {
  let commands = 0;
  const { call } = await gateway(t, async () => { commands++; }, { connected: true, extensionVersion: "0.2.0", expectedVersion: "0.4.0", capabilities: ["mediaV1"], versionMismatch: true });
  const result = await call("/v1/diagnostics", {});
  assert.equal(result.data.extensionVersion, "0.2.0");
  assert.equal(result.data.versionMismatch, true);
  assert.equal(result.data.browser, null);
  assert.equal(commands, 0);
});


test("loaded SVG placeholders cannot confirm a still-unloaded reference image", async () => {
  const { context, input, images, previews } = await uploadPage();
  let clock = 0;
  context.Date = { now: () => clock };
  context.setTimeout = (callback, ms) => { clock += ms; queueMicrotask(callback); return 1; };
  input.dispatchEvent = (event) => {
    if (event.type !== "change") return;
    previews.push({ src: "data:image/svg+xml,%3csvg/%3e", complete: true, naturalWidth: 54, getClientRects: () => [{}] });
    previews.push({ src: "blob:cast", complete: false, naturalWidth: 0, getClientRects: () => [{}] });
  };
  await assert.rejects(context.DoubaoMedia.handle({ type: "uploadImages", images }), /previews were not confirmed/);
});

test("lazy attachment previews are requested in the background and only the decoded image confirms upload", async () => {
  const { context, input, images, previews } = await uploadPage();
  let requested = false;
  input.dispatchEvent = (event) => {
    if (event.type !== "change") return;
    previews.push({ src: "data:image/svg+xml,%3csvg/%3e", complete: true, naturalWidth: 54, getClientRects: () => [{}] });
    const image = { src: "blob:cast", complete: false, naturalWidth: 0, getClientRects: () => [{}] };
    Object.defineProperty(image, "loading", { get: () => requested ? "eager" : "lazy", set: (value) => {
      assert.equal(value, "eager"); requested = true; image.complete = true; image.naturalWidth = 100;
    } });
    previews.push(image);
  };
  const result = await context.DoubaoMedia.handle({ type: "uploadImages", images });
  assert.equal(requested, true);
  assert.equal(result.confirmation, "loaded_preview");
});

test("a same-version content revision change triggers a script update", async () => {
  let injected = 0;
  const context = await backgroundContext({ scripting: { executeScript: async () => { injected++; } } },
    async () => ({ version: "0.4.0", mediaVersion: "0.4.0", revision: injected ? "new-build" : "old-build", mediaRevision: injected ? "new-build" : "old-build" }));
  const result = await context.testEnsureContent(123, "new-build");
  assert.equal(result.revision, "new-build"); assert.equal(injected, 1);
});

test("confirmation text preserves an existing draft and never submits automatically", async () => {
  const { context, editor, input, sends } = await uploadPage();
  editor.id = "editor";
  editor.tagName = "TEXTAREA";
  editor.getAttribute = () => null;
  input.id = "upload";
  const form = editor.closest("form");
  form.id = "form";
  const original = context.document.querySelectorAll;
  context.document.querySelectorAll = (query) => query === "#editor" ? [editor] : original(query);
  editor.value = "keep this draft";
  await assert.rejects(context.DoubaoMedia.handle({ type: "uiClick", selector: "#editor", text: "确认生成" }), /unsent draft/);
  assert.equal(editor.value, "keep this draft");
  editor.value = "";
  const result = await context.DoubaoMedia.handle({ type: "uiClick", selector: "#editor", text: "确认生成" });
  assert.equal(editor.value, "确认生成");
  assert.equal(result.sent, false);
  assert.equal(sends(), 0);
});

test("video submissions use existing account benefits without injecting a free-only restriction", async () => {
  for (const script of ["翻开账本", "使用当前已开通的会员权益生成视频", "这次只用免费额度，翻开账本"]) {
    const { context, images, sends } = await uploadPage();
    await context.DoubaoMedia.handle({ type: "uploadImages", images });
    const result = await context.DoubaoMedia.handle({ type: "videoSubmit", duration: 10, ratio: "9:16", prompt: script });
    const sent = context.document.body.textContent;
    assert.equal(result.state, "submitted");
    assert.equal(sends(), 1);
    assert.equal(sent, result.context.prompt);
    assert.equal(sent.endsWith(script), true);
    assert.doesNotMatch(sent.slice(0, -script.length), /免费|付费|会员|额度/u);
  }
});

test("quota exhaustion and refusals end waiting while ordinary quota notices do not", async () => {
  const { DoubaoMediaCore: { classifyMedia } } = await mediaContext();
  for (const text of ["今日视频生成免费次数用完了，你明天再来找我继续吧。", "当前视频生成额度不足", "配额已耗尽"]) {
    const result = classifyMedia({ videos: [], text });
    assert.equal(result.state, "quota_exhausted");
    assert.equal(result.retrySafe, false);
  }
  assert.equal(classifyMedia({ videos: [], text: "这个请求无法生成视频" }).state, "rejected");
  assert.equal(classifyMedia({ videos: [], text: "本次生成将消耗每日免费额度，正在生成" }).state, "generating");
});

test("rotated signatures identify the same file and multiple new clips require explicit recovery", async () => {
  const { DoubaoMediaCore: { classifyMedia } } = await mediaContext();
  const video = (url) => ({ url, duration: 10, readyState: 4 });
  assert.equal(classifyMedia({ videos: [video("https://example.test/clip.mp4?video_id=1&token=new&expires=200")],
    baselineUrls: ["https://example.test/clip.mp4?expires=100&token=old&video_id=1"] }).state, "pending");
  assert.equal(classifyMedia({ videos: [video("https://example.test/clip.mp4?video_id=2")],
    baselineUrls: ["https://example.test/clip.mp4?video_id=1"] }).state, "ready");
  const ambiguous = classifyMedia({ videos: [video("https://example.test/a.mp4"), video("https://example.test/b.mp4")] });
  assert.equal(ambiguous.state, "needs_recovery");
  assert.equal(ambiguous.candidateCount, 2);
});

test("a new video at a reused DOM position is ready and later replies do not contaminate an old task", async () => {
  const { context } = await uploadPage();
  const video = { id: "virtual-video", tagName: "VIDEO", currentSrc: "https://example.test/new.mp4", duration: 10,
    readyState: 4, videoWidth: 720, videoHeight: 1280, getClientRects: () => [{}], querySelector: () => null };
  const later = { ...video, id: "later-video", currentSrc: "https://example.test/later.mp4" };
  const original = context.document.querySelectorAll;
  context.document.querySelectorAll = (query) => query === "video" ? [video] : original(query);
  context.document.body.innerText = "my submitted prompt\nvideo ready";
  const job = { context: { conversationUrl: context.location.href, prompt: "my submitted prompt",
    baselineKeys: ["#virtual-video"], baselineUrls: ["https://example.test/old.mp4"] } };
  assert.equal((await context.DoubaoMedia.handle({ type: "videoStatus", job })).state, "ready");
  const message = (kind, text, videos = []) => ({ innerText: text, getAttribute: (key) => key === "data-testid" ? kind : null,
    querySelectorAll: () => videos });
  const messages = [message("send_message", "my submitted prompt"), message("receive_message", "video ready", [video]),
    message("send_message", "another generation"), message("receive_message", "今日免费次数用完了", [later])];
  context.document.querySelectorAll = (query) => query === "video" ? [video, later] : query.includes("send_message") ? messages : original(query);
  const result = await context.DoubaoMedia.handle({ type: "videoStatus", job });
  assert.equal(result.state, "ready");
  assert.equal(result.media.url, video.currentSrc);
  const laterJob = { context: { conversationUrl: context.location.href, prompt: "another generation", baselineUrls: [video.currentSrc, later.currentSrc] } };
  assert.equal((await context.DoubaoMedia.handle({ type: "videoStatus", job: laterJob })).state, "quota_exhausted");
});

test("preparation verifies UI settings and files without sending; settings changes invalidate it", async () => {
  const { context, editor, input, images, sends } = await uploadPage();
  const prepared = await context.DoubaoMedia.handle({ type: "videoPrepare", images, duration: 10, ratio: "9:16", model: "Seedance 2.0 Mini" });
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.sent, false);
  assert.equal(prepared.observed.duration, 10);
  assert.equal(input.files.length, 1);
  assert.equal(sends(), 0);
  editor.closest("form").innerText = "视频生成 Seedance 2.0 Mini 自动·5s 9:16";
  const blocked = await context.DoubaoMedia.handle({ type: "videoSubmit", duration: 10, ratio: "9:16", model: "Seedance 2.0 Mini", requirePrepared: true, prompt: "one action" });
  assert.equal(blocked.state, "preflight_failed");
  assert.equal(blocked.sendAttempted, false);
  assert.equal(sends(), 0);
});

test("unverifiable automatic ratio is not reported as prepared and user drafts survive preparation", async () => {
  const { context, editor, images, sends } = await uploadPage();
  editor.closest("form").innerText = "视频生成 Seedance 2.0 Mini 自动·10s";
  const result = await context.DoubaoMedia.handle({ type: "videoPrepare", images, duration: 10, ratio: "9:16" });
  assert.equal(result.state, "needs_manual_settings");
  assert.equal(result.observed.ratio, null);
  editor.value = "user draft";
  assert.equal((await context.DoubaoMedia.handle({ type: "videoPrepare", images, duration: 10, ratio: "9:16" })).state, "preflight_failed");
  assert.equal(editor.value, "user draft");
  assert.equal(sends(), 0);
});

test("prepared attachments can be reused without duplicate uploads and media preferences are optional", async () => {
  const { context, images, previews, sends } = await uploadPage();
  await context.DoubaoMedia.handle({ type: "videoPrepare", images, duration: 10, ratio: "9:16" });
  const result = await context.DoubaoMedia.handle({ type: "videoSubmit", images, duration: 10, ratio: "9:16", requirePrepared: true, prompt: "one action" });
  assert.equal(result.state, "submitted");
  assert.equal(result.parameterControl, "ui_verified");
  assert.equal(previews.length, 1);
  assert.equal(sends(), 1);
  assert.doesNotMatch(result.context.prompt, /无字幕|背景音乐|不要对白/);
  const next = await uploadPage();
  await next.context.DoubaoMedia.handle({ type: "uploadImages", images: next.images });
  const silent = await next.context.DoubaoMedia.handle({ type: "videoSubmit", duration: 10, ratio: "9:16", silent: true, noText: true, prompt: "one action" });
  assert.match(silent.context.prompt, /不要字幕/);
  assert.match(silent.context.prompt, /不要对白/);
});

test("compact inspection omits deep structures; generic UI clicks cannot submit", async () => {
  const { context, editor, sends } = await uploadPage();
  const summary = await context.DoubaoMedia.handle({ type: "inspect" });
  const full = await context.DoubaoMedia.handle({ type: "inspect", detail: "full" });
  assert.equal(summary.detail, "summary");
  assert.equal(summary.composer.domText, undefined);
  assert.equal(full.detail, "full");
  const send = { id: "flow-end-msg-send", getClientRects: () => [{}], getAttribute: () => null, innerText: "发送" };
  context.document.querySelectorAll = (query) => query === "#send" ? [send] : query.includes("contenteditable") ? [editor] : [];
  await assert.rejects(context.DoubaoMedia.handle({ type: "uiClick", selector: "#send" }), /idempotent/);
  assert.equal(sends(), 0);
});

test("focusing a session selects its bound tab, not another active conversation", async () => {
  const updates = [];
  const windows = [];
  const context = await backgroundContext({
    tabs: { get: async () => ({ id: 123, windowId: 7, active: updates.length > 0, url: "https://www.doubao.com/chat/123" }),
      update: async (id, properties) => updates.push([id, properties]), sendMessage: async () => ({ editors: [{}], visibility: "visible" }) },
    windows: { update: async (id, properties) => windows.push([id, properties]) }
  });
  const result = await context.testCommand({ type: "sessionFocus", sessionId: "test" });
  assert.equal(result.tabId, 123);
  assert.equal(result.active, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 123);
  assert.equal(windows[0][0], 7);
});

test("a certain pre-send failure resumes only explicitly with the same job and key", async (t) => {
  let calls = 0;
  const { call } = await gateway(t, async () => ++calls === 1
    ? { state: "preflight_failed", sendAttempted: false, retrySafe: true, error: "editor hidden" }
    : { state: "submitted", sendAttempted: true, context: { conversationUrl: "https://www.doubao.com/chat/123" } });
  const first = await call("/v1/video/submit", specification);
  const repeated = await call("/v1/video/submit", specification);
  assert.equal(repeated.data.reused, true);
  assert.equal(calls, 1);
  assert.equal((await call("/v1/video/status", { jobId: first.data.jobId })).data.error, "editor hidden");
  const resumed = await call("/v1/video/submit", { ...specification, retryPreflight: true });
  assert.equal(resumed.data.jobId, first.data.jobId);
  assert.equal(resumed.data.state, "submitted");
  assert.equal(calls, 2);
});

test("old idempotency records remain reusable after optional settings are added", async (t) => {
  const crypto = await import("node:crypto");
  const root = await temporary(t);
  const id = "22222222-2222-4222-8222-222222222222";
  const spec = { sessionId: specification.sessionId, prompt: specification.prompt, imagePaths: [], duration: 5, ratio: "9:16",
    imageRole: "reference", inputSelector: null, uploadTriggerSelector: null, controls: null };
  const dir = path.join(root, "media", "jobs", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify({ id, idempotencyKey: specification.idempotencyKey, spec,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex"), state: "unknown" }));
  let calls = 0;
  const { call } = await gateway(t, async () => { calls++; }, undefined, root);
  const result = await call("/v1/video/submit", specification);
  assert.equal(result.status, 200);
  assert.equal(result.data.jobId, id);
  assert.equal(result.data.reused, true);
  assert.equal(calls, 0);
});

test("downloaded status and task overview remain available offline without regressing completion", async (t) => {
  const root = await temporary(t);
  const id = "33333333-3333-4333-8333-333333333333";
  const dir = path.join(root, "media", "jobs", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "job.json"), JSON.stringify({ id, sessionId: specification.sessionId, state: "downloaded",
    adopted: true, localPath: path.join(dir, "video.mp4"), video: { duration: 10, width: 720, height: 1280 } }));
  let calls = 0;
  const { call } = await gateway(t, async () => { calls++; }, { connected: false }, root);
  assert.equal((await call("/v1/video/status", { jobId: id })).data.state, "downloaded");
  const overview = (await call("/v1/video/jobs", { sessionId: specification.sessionId })).data;
  assert.equal(overview.total, 1);
  assert.equal(overview.adopted, 1);
  assert.equal(overview.confirmedSubmissions, 0);
  assert.equal(overview.quotaRemaining, null);
  assert.equal(overview.jobs[0].video.duration, 10);
  assert.equal(calls, 0);
});

test("Chinese prompts survive HTTP chunks split inside UTF-8 characters", async (t) => {
  const root = await temporary(t);
  let received;
  const handler = createMediaRoutes({ root, key: "test-key", connection: () => ({ connected: true, capabilities: ["mediaV1"] }),
    enqueue: (operation) => operation(), command: async (_type, payload) => { received = payload.prompt; return { state: "submitted" }; } });
  const prompt = "只翻开账本，不增加纸片和字幕。";
  const bytes = Buffer.from(JSON.stringify({ ...specification, prompt }));
  const chunks = [...bytes].map((byte) => Buffer.from([byte]));
  const request = { url: "/v1/video/submit", method: "POST", headers: { authorization: "Bearer test-key" },
    async *[Symbol.asyncIterator]() { yield* chunks; } };
  let reply;
  const response = { writeHead() {}, end: (text) => { reply = JSON.parse(text); } };
  await handler(request, response);
  assert.equal(reply.ok, true);
  assert.equal(received, prompt);
});
