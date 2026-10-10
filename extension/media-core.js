(() => {
  const version = globalThis.DoubaoBridgeVersion || "0.4.0";
  const revision = globalThis.DoubaoBridgeRevision || "attachments-v2";
  if (globalThis.DoubaoMediaCore?.version === version && globalThis.DoubaoMediaCore?.revision === revision) return;
  const normalize = (value) => String(value || "").replace(/\s+/gu, "");
  function mediaIdentity(value) {
    try {
      const url = new URL(value);
      url.hash = "";
      // Keep media identifiers, but exclude credentials that can rotate for the same file.
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:token|auth_key|signature|sign|expires?|expiration|policy|key-pair-id|x-expires|x-signature|x-amz-.+|x-oss-.+)$/i.test(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return url.href;
    } catch { return String(value || ""); }
  }
  function classifyMedia({ videos, baselineUrls = [], adoptedUrl, text = "" }) {
    const baseline = new Set(baselineUrls.map(mediaIdentity));
    const candidates = [...new Map(videos.filter((video) => video.url && (adoptedUrl
      ? mediaIdentity(video.url) === mediaIdentity(adoptedUrl) : !baseline.has(mediaIdentity(video.url))))
      .map((video) => [mediaIdentity(video.url), video])).values()];
    const ready = candidates.filter((video) => Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 1 && !video.error);
    if (ready.length > 1) return { state: "needs_recovery", reason: "Multiple new playable videos; select the intended video explicitly", candidateCount: ready.length };
    if (ready.length === 1) return { state: "ready", media: ready[0] };
    if (/(?:次数|额度|配额|限额).{0,18}(?:用完|耗尽|不足|已满)|(?:用完|耗尽).{0,12}(?:次数|额度)|达到.{0,12}(?:次数|上限)|今日.{0,12}不能再生成/u.test(text)) {
      return { state: "quota_exhausted", reason: text.slice(0, 600), retrySafe: false };
    }
    if (/无法.{0,12}生成|不能.{0,12}生成|暂不支持.{0,12}视频|不支持.{0,12}生成|违反.{0,12}(?:规则|政策)|不符合.{0,12}(?:规则|要求)|无法满足.{0,12}请求/u.test(text)) {
      return { state: "rejected", reason: text.slice(0, 600), retrySafe: false };
    }
    if (candidates.some((video) => video.error)) return { state: "failed", reason: "Video element reports a media error" };
    if (/生成失败|生成出错|视频失败|任务失败/u.test(text)) return { state: "failed" };
    if (/确认.*(?:生成|参数)|确认后.*生成/u.test(text)) return { state: "needs_confirmation" };
    if (/排队|队列/u.test(text)) return { state: "queued" };
    if (/生成中|正在生成/u.test(text)) return { state: "generating" };
    return { state: "pending", reason: "No new playable video element; text promises are not completion evidence" };
  }
  globalThis.DoubaoMediaCore = { version, revision, normalize, mediaIdentity, classifyMedia };
})();
