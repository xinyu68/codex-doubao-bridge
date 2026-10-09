import { bridgeKey, bridgeUrl } from "./config.js";
const $ = (id) => document.getElementById(id);
const healthUrl = new URL(bridgeUrl); healthUrl.protocol = "http:"; healthUrl.pathname = "/v1/health"; healthUrl.search = "";
async function refresh() {
  const [runtime, backend] = await Promise.allSettled([
    chrome.runtime.sendMessage({ type: "bridgeDiagnostics" }),
    fetch(healthUrl, { headers: { authorization: "Bearer " + bridgeKey } }).then((response) => response.json())
  ]);
  const info = runtime.status === "fulfilled" ? runtime.value.data : null;
  const health = backend.status === "fulfilled" ? backend.value : null;
  $("installed").textContent = chrome.runtime.getManifest().version;
  $("worker").textContent = info?.workerVersion || "未读到后台状态";
  $("extensionId").textContent = chrome.runtime.id;
  $("expected").textContent = health?.expectedVersion || "本机服务未连接";
  $("directory").textContent = health?.expectedDirectory || "请检查本机服务";
  $("summary").textContent = health?.versionMismatch ? "服务与扩展版本不同，请核对加载目录并重新加载扩展。" :
    info?.connected ? "扩展已连接本机服务。" : "扩展尚未连接本机服务。";
  $("pages").replaceChildren();
  for (const page of info?.pages || []) {
    const box = document.createElement("div"); box.className = "page";
    box.textContent = "标签 " + page.tabId + "：" + (page.compatible ? "脚本版本一致" : "需要更新网页脚本或刷新页面") +
      "\n版本：" + (page.version || "未知") + (page.draftPresent ? "；有未发送草稿" : "") + "\n" + page.url +
      (page.error ? "\n" + page.error : "");
    box.style.whiteSpace = "pre-wrap"; $("pages").append(box);
  }
  if (!info?.pages?.length) $("pages").textContent = "请打开已登录的豆包网页。";
}
async function action(type) {
  const buttons = [...document.querySelectorAll("button")]; buttons.forEach((button) => button.disabled = true);
  try {
    const result = await chrome.runtime.sendMessage({ type });
    $("notice").textContent = result.ok ? (result.data?.results?.find((item) => item.error)?.error || "操作完成。") : result.error;
    await refresh();
  } catch (error) { $("notice").textContent = error.message; }
  finally { buttons.forEach((button) => button.disabled = false); }
}
$("refresh").addEventListener("click", () => refresh().catch((error) => $("notice").textContent = error.message));
$("repair").addEventListener("click", () => action("bridgeRepair"));
$("reconnect").addEventListener("click", () => action("bridgeReconnect"));
refresh().catch((error) => $("notice").textContent = error.message);
