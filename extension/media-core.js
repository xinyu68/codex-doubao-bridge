(() => {
  const version = globalThis.DoubaoBridgeVersion || "0.3.1";
  const revision = globalThis.DoubaoBridgeRevision || "attachments-v2";
  if (globalThis.DoubaoMediaCore?.version === version && globalThis.DoubaoMediaCore?.revision === revision) return;
  const normalize = (value) => String(value || "").replace(/\s+/gu, "");
  function classifyMedia({ videos, baselineUrls = [], adoptedUrl, text = "" }) {
    const candidates = videos.filter((video) => adoptedUrl ? video.url === adoptedUrl : !baselineUrls.includes(video.url));
    const ready = candidates.find((video) => video.url && Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 1 && !video.error);
    if (ready) return { state: "ready", media: ready };
    if (candidates.some((video) => video.error)) return { state: "failed", reason: "Video element reports a media error" };
    if (/生成失败|生成出错|视频失败|任务失败/u.test(text)) return { state: "failed" };
    if (/确认.*(?:生成|参数)|确认后.*生成/u.test(text)) return { state: "needs_confirmation" };
    if (/排队|队列/u.test(text)) return { state: "queued" };
    if (/生成中|正在生成/u.test(text)) return { state: "generating" };
    return { state: "pending", reason: "No new playable video element; text promises are not completion evidence" };
  }
  globalThis.DoubaoMediaCore = { version, revision, normalize, classifyMedia };
})();
