const session = { type: "string", description: "Pinned sessionId from doubao_media_session" };
const job = { type: "string", description: "Existing jobId; querying never submits a new generation" };
const imageProperties = {
  imagePaths: { type: "array", items: { type: "string" }, maxItems: 5, description: "Absolute paths to actual PNG/JPEG/WebP/GIF files" },
  imageRole: { type: "string", enum: ["reference", "first_frame"], default: "reference" },
  inputSelector: { type: "string", description: "Unique file input selector from page inspection; optional when unambiguous" },
  uploadTriggerSelector: { type: "string", description: "Optional inspected button selector exposing the image upload input" }
};
const videoSettings = {
  duration: { type: "integer", minimum: 2, maximum: 15, default: 5 },
  ratio: { type: "string", enum: ["9:16", "16:9", "1:1", "3:4", "4:3"], default: "9:16" },
  model: { type: "string", maxLength: 100, description: "Optional exact visible model name; verified during preparation" },
  controls: { type: "object", description: "Inspected UI selectors for selecting settings; never use send or purchase controls.",
    additionalProperties: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" }, optionSelector: { type: "string" } }, required: ["selector"], additionalProperties: false } }
};
const definitions = [
  ["doubao_diagnostics", "Read backend, extension and webpage script versions without injecting scripts, changing drafts, or sending prompts.", {}, [], "/v1/diagnostics", "diagnostics"],
  ["doubao_media_tabs", "List open Doubao tabs without sending a message.", {}, [], "/v1/tabs", "tabs"],
  ["doubao_media_session", "Open an independent background Doubao tab, or bind an explicitly selected existing tab. All media operations stay pinned to that tab.", { tabId: { type: "integer", minimum: 0 } }, [], "/v1/session", "session"],
  ["doubao_media_focus", "Activate the pinned Doubao tab and optionally focus its Chrome window. Does not send, refresh, or switch conversations.", { sessionId: session, focusWindow: { type: "boolean", default: true } }, ["sessionId"], "/v1/session/focus", "focus"],
  ["doubao_page", "Read compact pinned-page controls and real videos. Use detail=full for deeper DOM diagnosis. Does not send a prompt.", { sessionId: session, detail: { type: "string", enum: ["summary", "full"], default: "summary" } }, ["sessionId"], "/v1/page", "inspect"],
  ["doubao_ui_click", "Click an inspected visible control, adjust an inspected slider, or enter short text into an empty inspected message editor without sending. Does not operate payment controls.", { sessionId: session, selector: { type: "string" }, key: { type: "string", enum: ["ArrowLeft", "ArrowRight", "Home", "End"] }, text: { type: "string", maxLength: 1000 } }, ["sessionId", "selector"], "/v1/ui/click", "click"],
  ["doubao_upload_images", "Upload real local images via the pinned webpage file input. Requires loaded attachment previews; does not start video generation.", { sessionId: session, ...imageProperties }, ["sessionId", "imagePaths"], "/v1/images", "upload"],
  ["doubao_video_prepare", "Activate the pinned tab, apply inspected settings, verify actual model/duration/ratio and upload references. Never sends. Returns prepared only after real UI readback; unverified settings require inspected controls and preparation again.", {
    sessionId: session, ...imageProperties, ...videoSettings, activateTab: { type: "boolean", default: true }
  }, ["sessionId"], "/v1/video/prepare", "prepare"],
  ["doubao_video_submit", "Submit one image-conditioned video request with a required idempotency key. Never retry a new generation automatically after uncertain results. No-reference submissions are rejected unless images were already uploaded.", {
    sessionId: session, prompt: { type: "string" }, ...imageProperties,
    ...videoSettings,
    idempotencyKey: { type: "string", description: "Stable per deliberate attempt, e.g. episode001-shot01-attempt01" },
    requirePrepared: { type: "boolean", default: false, description: "Require successful preparation with matching UI settings and references before sending" },
    retryPreflight: { type: "boolean", default: false, description: "Explicitly resume the SAME key only after a certain before-send failure has been corrected" },
    silent: { type: "boolean", default: false, description: "Request no audio; a prompt preference, not a guarantee" },
    noText: { type: "boolean", default: false, description: "Request no text/subtitles; a prompt preference, not a guarantee" }
  }, ["sessionId", "prompt", "idempotencyKey"], "/v1/video/submit", "submit"],
  ["doubao_video_status", "Query actual video elements for an existing job. Stable text promises are not treated as completed video. Does not send any message.", { jobId: job }, ["jobId"], "/v1/video/status", "status"],
  ["doubao_video_jobs", "Read persistent task records and counts without inspecting pages or generating. Includes adopted/reused sources and actual downloaded durations; never infers remaining quota.", {
    sessionId: session, limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
  }, [], "/v1/video/jobs", "jobs"],
  ["doubao_video_adopt", "Record one explicitly selected ready video already visible in a pinned conversation, without generating again.", { sessionId: session, videoIndex: { type: "integer", minimum: 0, default: 0 } }, ["sessionId"], "/v1/video/adopt", "adopt"],
  ["doubao_video_download", "Download an existing ready video through Chrome, then verify and copy it into the local media/jobs directory. Repeated calls reuse the same download.", { jobId: job }, ["jobId"], "/v1/video/download", "download"],
  ["doubao_video_tail", "Extract the last decoded frame from an already downloaded video with local FFmpeg. Returns an image path usable for the next upload.", { jobId: job }, ["jobId"], "/v1/video/tail", "tail"]
];
export const mediaTools = definitions.map(([name, description, properties, required]) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }
}));
export const mediaRoutesByTool = Object.fromEntries(definitions.map(([name, , , , route]) => [name, route]));
export const mediaToolsByOperation = Object.fromEntries(definitions.map(([name, , , , , operation]) => [operation, name]));
