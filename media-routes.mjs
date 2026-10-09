import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadImages, probeVideo, extractTail } from "./media-files.mjs";

const ROUTES = new Set([
  "/v1/diagnostics", "/v1/health", "/v1/tabs", "/v1/session", "/v1/page", "/v1/images", "/v1/ui/click",
  "/v1/video/submit", "/v1/video/status", "/v1/video/download", "/v1/video/tail", "/v1/video/adopt"
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_RATIOS = new Set(["9:16", "16:9", "1:1", "3:4", "4:3"]);

export function createMediaRoutes({ root, key, connection, enqueue, command }) {
  const jobsDir = path.join(root, "media", "jobs");
  const jobs = new Map();
  let initialized;
  const initialize = () => initialized ||= (async () => {
    await fs.mkdir(jobsDir, { recursive: true });
    for (const entry of await fs.readdir(jobsDir)) {
      if (!UUID.test(entry)) continue;
      try {
        const job = JSON.parse(await fs.readFile(path.join(jobsDir, entry, "job.json"), "utf8"));
        if (job.id === entry) jobs.set(job.id, job);
      } catch { /* A partial or unrelated file is not a usable task record. */ }
    }
  })();
  async function save(job) {
    await initialize();
    const dir = path.join(jobsDir, job.id);
    await fs.mkdir(dir, { recursive: true });
    const temporary = path.join(dir, "job.json.tmp");
    await fs.writeFile(temporary, JSON.stringify(job, null, 2), "utf8");
    await fs.rename(temporary, path.join(dir, "job.json"));
    jobs.set(job.id, job);
  }
  async function getJob(id) {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("A valid jobId is required");
    await initialize();
    const job = jobs.get(id);
    if (!job) throw new Error("Video job not found");
    return job;
  }
  function session(payload) {
    if (typeof payload.sessionId !== "string" || !UUID.test(payload.sessionId)) throw new Error("A valid sessionId is required");
    return payload.sessionId;
  }
  function requireExtension() {
    const state = connection();
    if (!state.connected) throw new Error("Chrome extension is not connected");
    if (!state.capabilities?.includes("mediaV1")) {
      throw new Error("Reload Local Doubao Bridge at chrome://extensions, then refresh the Doubao tab; mediaV1 is not connected");
    }
  }
  async function body(request) {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("Request JSON must not exceed 128 KiB; pass local image paths, not base64");
    }
    const result = JSON.parse(raw || "{}");
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Body must be a JSON object");
    return result;
  }
  function send(response, code, data) {
    response.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
  }
  async function videoStatus(job) {
    const result = await command("videoStatus", { sessionId: job.sessionId, job }, 20000);
    job.lastStatus = result;
    job.state = result.state;
    job.updatedAt = new Date().toISOString();
    await save(job);
    return { jobId: job.id, ...result };
  }

  return async (request, response) => {
    const route = request.url;
    if (!ROUTES.has(route)) return false;
    if (request.headers.authorization !== "Bearer " + key) {
      send(response, 401, { ok: false, error: "Unauthorized" });
      return true;
    }
    if (route === "/v1/health" && request.method === "GET") {
      send(response, 200, { ok: true, ...connection() });
      return true;
    }
    if (request.method !== "POST") {
      send(response, 405, { ok: false, error: "Use POST for this operation" });
      return true;
    }
    try {
      const payload = await body(request);
      let result;
      if (route === "/v1/diagnostics") {
        const state = connection();
        result = { ...state, browser: null };
        if (state.connected && state.capabilities?.includes("diagnosticsV1")) {
          result.browser = await enqueue(() => command("diagnostics", {}, 15000));
        } else result.instruction = "Detailed diagnostics needs the updated Chrome extension; this call did not change any page.";
      } else if (route === "/v1/video/tail") {
        const job = await getJob(payload.jobId);
        if (!job.localPath) throw new Error("Download and verify the video before extracting its tail frame");
        const output = path.join(jobsDir, job.id, "tail.png");
        result = await extractTail(job.localPath, output);
        job.tailPath = result.path;
        await save(job);
      } else if (route === "/v1/video/submit") {
        session(payload);
        if (typeof payload.prompt !== "string" || !payload.prompt.trim()) throw new Error("prompt is required");
        if (typeof payload.idempotencyKey !== "string" || !/^[\w.-]{1,128}$/.test(payload.idempotencyKey)) {
          throw new Error("idempotencyKey is required; reuse it when checking an uncertain submission");
        }
        const duration = payload.duration ?? 5;
        const ratio = payload.ratio ?? "9:16";
        if (!Number.isInteger(duration) || duration < 2 || duration > 15) throw new Error("duration must be an integer from 2 to 15 seconds");
        if (!VIDEO_RATIOS.has(ratio)) throw new Error("Unsupported ratio");
        if (!["reference", "first_frame"].includes(payload.imageRole ?? "reference")) throw new Error("Invalid imageRole");
        const spec = {
          sessionId: payload.sessionId, prompt: payload.prompt.trim(), imagePaths: payload.imagePaths ?? [],
          duration, ratio, imageRole: payload.imageRole ?? "reference",
          inputSelector: payload.inputSelector ?? null, uploadTriggerSelector: payload.uploadTriggerSelector ?? null,
          controls: payload.controls ?? null
        };
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex");
        result = await enqueue(async () => {
          if (response.destroyed) throw new Error("Client disconnected before submission started; nothing was sent");
          await initialize();
          const existing = [...jobs.values()].find((job) => job.idempotencyKey === payload.idempotencyKey);
          if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error("Idempotency key already belongs to different parameters; use a new key for a deliberate new attempt");
            return { jobId: existing.id, state: existing.state, reused: true, localPath: existing.localPath };
          }
          requireExtension();
          const images = await loadImages(spec.imagePaths);
          const job = {
            id: crypto.randomUUID(), idempotencyKey: payload.idempotencyKey, fingerprint,
            sessionId: spec.sessionId, spec, state: "submitting", createdAt: new Date().toISOString()
          };
          await save(job);
          try {
            const submission = await command("videoSubmit", { ...spec, images, jobId: job.id }, 65000);
            job.context = submission.context;
            job.state = submission.state;
            job.submission = submission;
            await save(job);
            return { jobId: job.id, ...submission };
          } catch (error) {
            job.state = "unknown";
            job.error = error.message;
            await save(job);
            return { jobId: job.id, state: "unknown", error: error.message, retrySafe: false,
              instruction: "Do not submit again automatically. Inspect this session and query the existing job." };
          }
        });
      } else {
        requireExtension();
        result = await enqueue(async () => {
          if (route === "/v1/tabs") return command("tabs", {}, 10000);
          if (route === "/v1/session") {
            if (payload.tabId !== undefined && (!Number.isInteger(payload.tabId) || payload.tabId < 0)) throw new Error("tabId must be an integer");
            return command("sessionOpen", { sessionId: crypto.randomUUID(), tabId: payload.tabId }, 30000);
          }
          if (route === "/v1/page") return command("inspect", { sessionId: session(payload) }, 20000);
          if (route === "/v1/ui/click") {
            if (typeof payload.selector !== "string" || !payload.selector.trim()) throw new Error("selector is required");
            if (payload.key !== undefined && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(payload.key)) throw new Error("Only slider adjustment keys are allowed");
            if (payload.text !== undefined && (payload.key !== undefined || typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 1000)) throw new Error("Invalid short text input");
            return command("uiClick", { sessionId: session(payload), selector: payload.selector, key: payload.key, text: payload.text }, 15000);
          }
          if (route === "/v1/images") {
            const images = await loadImages(payload.imagePaths);
            if (!images.length) throw new Error("imagePaths must include at least one image");
            return command("uploadImages", {
              sessionId: session(payload), images, imageRole: payload.imageRole ?? "reference",
              inputSelector: payload.inputSelector, uploadTriggerSelector: payload.uploadTriggerSelector
            }, 45000);
          }
          if (route === "/v1/video/adopt") {
            const media = await command("videoAdopt", { sessionId: session(payload), videoIndex: payload.videoIndex ?? 0 }, 20000);
            const job = { id: crypto.randomUUID(), sessionId: payload.sessionId, state: "ready",
              createdAt: new Date().toISOString(), context: media.context, lastStatus: media, adopted: true };
            await save(job);
            return { jobId: job.id, ...media };
          }
          const job = await getJob(payload.jobId);
          if (route === "/v1/video/status") return videoStatus(job);
          if (route === "/v1/video/download") {
            if (job.localPath) {
              await fs.stat(job.localPath);
              return { jobId: job.id, path: job.localPath, video: job.video, reused: true };
            }
            if (job.downloadId === undefined) {
              const status = await videoStatus(job);
              if (status.state !== "ready") throw new Error("Video is not ready: " + status.state);
              const download = await command("videoDownload", { sessionId: job.sessionId, job, filename: job.id + ".mp4" }, 25000);
              job.downloadId = download.downloadId;
              await save(job);
            }
            const download = await command("downloadStatus", { downloadId: job.downloadId }, 10000);
            if (download.state !== "complete") return { jobId: job.id, downloadId: job.downloadId, ...download };
            if (!download.filename) throw new Error("Browser did not return the completed download filename");
            const video = await probeVideo(download.filename);
            const suffix = path.extname(download.filename).toLowerCase() === ".webm" ? ".webm" : ".mp4";
            const destination = path.join(jobsDir, job.id, "video" + suffix);
            await fs.copyFile(download.filename, destination);
            job.localPath = destination;
            job.video = video;
            job.state = "downloaded";
            await save(job);
            return { jobId: job.id, path: destination, video, downloadId: job.downloadId,
              matchesRequestedDuration: job.spec ? Math.abs(video.duration - job.spec.duration) < 0.6 : null,
              matchesRequestedRatio: job.spec ? Math.abs(video.width / video.height - Number(job.spec.ratio.split(":")[0]) / Number(job.spec.ratio.split(":")[1])) < 0.03 : null };
          }
          throw new Error("Unknown media route");
        });
      }
      send(response, 200, { ok: true, ...result });
    } catch (error) {
      send(response, 400, { ok: false, error: error.message });
    }
    return true;
  };
}
