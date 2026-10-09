(() => {
  const version = globalThis.DoubaoBridgeVersion || "0.3.1";
  const revision = globalThis.DoubaoBridgeRevision || "attachments-v2";
  if (globalThis.DoubaoMedia?.version === version && globalThis.DoubaoMedia?.revision === revision) return;
  const { normalize, classifyMedia } = globalThis.DoubaoMediaCore;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
  };
  const editors = () => [...document.querySelectorAll("textarea, [contenteditable='true']")].filter(visible);
  const inputValue = (input) => input instanceof HTMLTextAreaElement ? input.value : input?.textContent || "";
  let lastUpload = null;

  function selector(element) {
    if (element.id) return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 80) {
      const tag = current.tagName.toLowerCase();
      const siblings = [...(current.parentElement?.children || [])].filter((item) => item.tagName === current.tagName);
      parts.unshift(tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")");
      current = current.parentElement;
      if (current?.id) {
        parts.unshift("#" + CSS.escape(current.id));
        break;
      }
    }
    return parts.join(" > ");
  }
  function label(element) {
    return (element.getAttribute("aria-label") || element.getAttribute("title") ||
      element.innerText || element.getAttribute("data-testid") || "").trim().slice(0, 160);
  }
  function readVideos() {
    return [...document.querySelectorAll("video")].filter(visible).map((video) => ({
      selector: selector(video), key: selector(video),
      url: video.currentSrc || video.src || video.querySelector("source")?.src || "",
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
      poster: video.poster || null, error: video.error ? video.error.code : null
    }));
  }
  function readConversation() {
    const main = document.querySelector?.("#chat-route-main > main");
    if (!main || typeof main.cloneNode !== "function") return null;
    const copy = main.cloneNode(true);
    copy.querySelector("#input-engine-container")?.remove();
    for (const excluded of copy.querySelectorAll("script, style, aside, nav, [id*=sidebar]")) excluded.remove();
    return { text: (copy.textContent || "").trim().slice(-14000),
      controls: [...main.querySelectorAll("button, [role='button'], [data-testid]")].filter((item) =>
        visible(item) && !composerRoot().contains(item)
      ).map((item) => ({ selector: selector(item), text: label(item), testId: item.getAttribute("data-testid"), disabled: Boolean(item.disabled || item.getAttribute("aria-disabled") === "true") })).filter((item) => item.text).slice(-60)
    };
  }
  function readMediaPreviews() {
    const main = document.querySelector?.("#chat-route-main > main");
    if (!main) return [];
    return [...main.querySelectorAll("img, canvas, [class*=video], [class*=Video]")].filter((item) =>
      visible(item) && !composerRoot().contains(item)
    ).map((item) => ({
      selector: selector(item), tag: item.tagName, className: String(item.className || "").slice(0, 200),
      src: item.currentSrc || item.src || null, backgroundImage: getComputedStyle(item).backgroundImage || null,
      text: label(item), cursor: getComputedStyle(item).cursor,
      parentSelector: item.parentElement ? selector(item.parentElement) : null,
      context: (item.closest("[data-testid=receive_message]")?.textContent || item.parentElement?.textContent || "").slice(0, 300)
    })).slice(-60);
  }
  function page() {
    return {
      url: location.href, title: document.title, contentVersion: version, contentRevision: revision,
      composer: { selector: selector(composerRoot()), draftPresent: Boolean(normalize(inputValue(editors().at(-1)))), text: (composerRoot().innerText || "").slice(0, 4000), domText: (composerRoot().textContent || "").slice(0, 5000) },
      composerControls: [...composerRoot().querySelectorAll("*")].filter((item) =>
        item.hasAttribute?.("contenteditable") || item.hasAttribute?.("data-testid") || item.hasAttribute?.("role") ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(item.tagName) || getComputedStyle(item).cursor === "pointer"
      ).map((item) => ({ selector: selector(item), tag: item.tagName, text: label(item),
        role: item.getAttribute("role"), popup: item.getAttribute("aria-haspopup"), expanded: item.getAttribute("aria-expanded"), state: item.getAttribute("data-state"), editable: item.getAttribute("contenteditable"), testId: item.getAttribute("data-testid"),
        type: item.getAttribute("type"), domText: (item.textContent || "").slice(0, 350), visible: visible(item), display: getComputedStyle(item).display, visibility: getComputedStyle(item).visibility, rects: item.getClientRects().length, disabled: Boolean(item.disabled || item.getAttribute("aria-disabled") === "true")
      })).slice(0, 160),
      attachments: thumbnails(),
      conversation: readConversation(),
      confirmations: [...document.querySelectorAll("[data-testid*=safety_authorization]")].filter(visible).map((item) => ({ selector: selector(item), text: label(item), testId: item.getAttribute("data-testid"), context: (item.closest("[data-testid=safety_authorization_dialog]")?.innerText || item.closest("[data-testid=safety_authorization_dialog]")?.textContent || "").slice(0, 5000) })),
      editors: editors().map((input) => ({ selector: selector(input), tag: input.tagName, placeholder: input.getAttribute("placeholder") })),
      fileInputs: [...document.querySelectorAll("input[type='file']")].map((input) => ({
        selector: selector(input), accept: input.accept, multiple: input.multiple, label: label(input),
        context: (input.parentElement?.innerText || "").slice(0, 200),
        inComposer: composerRoot().contains?.(input) || false
      })),
      buttons: [...document.querySelectorAll("button, [role='button'], [role='menuitem'], a")].filter(visible).map((item) => ({
        selector: selector(item), text: label(item), testId: item.getAttribute("data-testid"), disabled: Boolean(item.disabled || item.getAttribute("aria-disabled") === "true")
      })).filter((item) => item.text).slice(-100),
      selects: [...document.querySelectorAll("select")].filter(visible).map((item) => ({
        selector: selector(item), value: item.value,
        options: [...item.options].map((option) => ({ value: option.value, text: option.text }))
      })),
      panels: [...document.querySelectorAll("[data-radix-popper-content-wrapper], [role='dialog'], [role='listbox'], [role='menu']")].filter(visible).map((panel) => ({
        selector: selector(panel), text: (panel.innerText || panel.textContent || "").slice(0, 5000),
        structure: [...panel.querySelectorAll("*")].filter((item) => !["svg", "path", "IMG"].includes(item.tagName)).map((item) => ({
          selector: selector(item), tag: item.tagName, text: (item.children?.length ? "" : label(item)),
          attributes: Object.fromEntries([...item.attributes].filter((attribute) => /^(role|aria-|data-state|data-orientation|tabindex|type|min|max|value|style)/u.test(attribute.name)).map((attribute) => [attribute.name, attribute.value]))
        })).slice(0, 180),
        controls: [...panel.querySelectorAll("*")].filter((item) => visible(item) &&
          (["BUTTON", "INPUT", "SELECT"].includes(item.tagName) || item.hasAttribute?.("role") ||
          getComputedStyle(item).cursor === "pointer" || !item.children?.length)
        ).map((item) => ({ selector: selector(item), tag: item.tagName, text: label(item), role: item.getAttribute("role"),
          value: item.value, checked: item.checked, disabled: Boolean(item.disabled || item.getAttribute("aria-disabled") === "true")
        })).filter((item) => item.text || item.value !== undefined).slice(0, 140)
      })).slice(0, 10),
      mediaPreviews: readMediaPreviews(),
      videos: readVideos()
    };
  }
  function one(selectorText) {
    const matches = [...document.querySelectorAll(selectorText)];
    if (matches.length !== 1) throw new Error("Selector must identify exactly one element: " + selectorText);
    return matches[0];
  }
  async function uiClick(selectorText, key, text) {
    const element = one(selectorText);
    if (!visible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") throw new Error("Control is not enabled and visible");
    if (/支付|购买|充值|开通会员|确认订阅/u.test(label(element))) throw new Error("This bridge will not operate payment controls");
    if (text !== undefined) {
      if (key !== undefined || typeof text !== "string" || !text.trim() || text.length > 1000) throw new Error("Provide at most 1000 characters of text without a slider key");
      if (!(element instanceof HTMLTextAreaElement) && element.getAttribute("contenteditable") !== "true") throw new Error("Text can only be entered into an inspected message editor");
      if (normalize(inputValue(element))) throw new Error("Pinned editor contains an unsent draft; refusing to replace it");
      if (!globalThis.DoubaoChat) throw new Error("Chat support is not ready");
      globalThis.DoubaoChat.enterPrompt(element, text);
      await sleep(100);
      return { typed: selectorText, length: text.length, sent: false, page: page() };
    }
    if (key !== undefined) {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key) || element.getAttribute("role") !== "slider") {
        throw new Error("Keyboard adjustment is restricted to an inspected slider and ArrowLeft/ArrowRight/Home/End");
      }
      element.focus();
      element.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));
      await sleep(400);
      return { adjusted: selectorText, key, value: element.getAttribute("aria-valuenow"), page: page() };
    }
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1 }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0 }));
    }
    element.scrollIntoView?.({ block: "center", inline: "nearest" });
    if (typeof MouseEvent === "function") {
      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    }
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", isPrimary: true }));
      element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse", isPrimary: true }));
    }
    element.click();
    await sleep(400);
    return { clicked: selectorText, page: page() };
  }
  function composerRoot() {
    const editor = editors().at(-1);
    const exact = document.querySelector?.("#input-engine-container");
    if (exact && visible(exact)) return exact;
    const form = editor?.closest("form");
    if (form) return form;
    let current = editor?.parentElement;
    for (let depth = 0; current && depth < 20; depth++, current = current.parentElement) {
      if (current.querySelector?.("#flow-end-msg-send")) return current;
    }
    return document.body;
  }
  function placeholderSource(src) {
    return !src || /^data:image\/svg\+xml/i.test(src) || /\.svg(?:[?#]|$)/i.test(src) || /\/rc\/icon\//i.test(src);
  }
  function thumbnails() {
    return [...composerRoot().querySelectorAll("img")].filter(visible).map((image) => {
      const src = image.currentSrc || image.src || "";
      return { src, loaded: image.complete && image.naturalWidth > 0,
        placeholder: placeholderSource(src), complete: image.complete,
        width: image.naturalWidth, height: image.naturalHeight,
        loading: image.loading || null, alt: image.alt || "", title: image.title || "",
        context: (image.parentElement?.innerText || "").slice(0, 160) };
    });
  }
  function requestPreviewLoading(previous) {
    for (const image of composerRoot().querySelectorAll("img")) {
      const src = image.currentSrc || image.src || "";
      if (!previous.includes(src) && !placeholderSource(src) && image.loading === "lazy") image.loading = "eager";
    }
  }
  async function uploadImages(message) {
    const images = message.images;
    if (!images?.length) throw new Error("No image files supplied");
    const role = message.imageRole || "reference";
    if (!["reference", "first_frame"].includes(role)) throw new Error("Invalid imageRole");
    if (message.uploadTriggerSelector) await uiClick(message.uploadTriggerSelector);
    let input;
    if (message.inputSelector) input = one(message.inputSelector);
    else {
      const inputs = [...document.querySelectorAll("input[type='file']")].filter((item) =>
        !item.accept || item.accept.includes("image") || /\.(?:png|jpg|jpeg|webp|gif)/i.test(item.accept));
      const frameInputs = inputs.filter((item) => /首帧|起始帧/u.test(label(item) + " " + (item.parentElement?.innerText || "")));
      const localInputs = inputs.filter((item) => composerRoot().contains?.(item));
      const candidates = role === "first_frame" ? frameInputs : (localInputs.length ? localInputs : inputs);
      if (candidates.length !== 1) throw new Error("Choose the image upload input from doubao_page inspection and pass inputSelector; found " + candidates.length);
      input = candidates[0];
    }
    if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("Selected control is not a file input");
    const roleVerified = role === "reference" || /首帧|起始帧/u.test(label(input) + " " + (input.parentElement?.innerText || ""));
    if (!roleVerified) throw new Error("Selected input is not labeled as a first-frame input; use reference mode or inspect the video first-frame control");
    if (images.length > 1 && !input.multiple) throw new Error("This input only supports one image at a time");
    const previous = thumbnails().map((item) => item.src);
    const transfer = new DataTransfer();
    for (const image of images) {
      const raw = atob(image.base64);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], image.name, { type: image.mime }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(400);
      requestPreviewLoading(previous);
      const previews = thumbnails().filter((item) => !previous.includes(item.src) && !item.placeholder && item.loaded);
      const root = composerRoot();
      const busy = [...root.querySelectorAll("[aria-busy='true'], [role='progressbar']")].some(visible) || /上传中|正在上传/u.test(root.innerText || "");
      if (previews.length >= images.length && !busy) {
        lastUpload = { names: images.map((image) => image.name), previewSources: previews.map((item) => item.src), imageRole: role };
        return { uploaded: lastUpload.names, confirmation: "loaded_preview", imageRole: role, roleVerified };
      }
    }
    throw new Error("Images were assigned to the input but loaded attachment previews were not confirmed; inspect the page before submitting");
  }
  async function applyControls(controls = {}) {
    for (const control of Object.values(controls)) {
      if (!control?.selector) throw new Error("Each video UI control needs a selector from page inspection");
      const element = one(control.selector);
      if (element.tagName === "SELECT") {
        const option = [...element.options].find((item) => item.value === control.value || item.text.trim() === control.value);
        if (!option) throw new Error("Video option not available: " + control.value);
        element.value = option.value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        await uiClick(control.selector);
        if (control.optionSelector) await uiClick(control.optionSelector);
        else if (control.value !== undefined) throw new Error("For a non-select dropdown, also provide optionSelector");
      }
    }
  }
  async function videoSubmit(message) {
    const initialInput = editors().at(-1);
    if (!initialInput) throw new Error("Could not find the Doubao message editor");
    if (normalize(inputValue(initialInput))) throw new Error("Pinned editor contains an unsent draft; refusing to replace it");
    if (message.controls) await applyControls(message.controls);
    const input = editors().at(-1);
    if (!input || normalize(inputValue(input))) throw new Error("The current video editor is missing or contains an unsent draft");
    let upload;
    if (message.images?.length) upload = await uploadImages(message);
    else {
      const current = thumbnails().filter((item) => !item.placeholder && item.loaded).map((item) => item.src);
      if (!lastUpload || !lastUpload.previewSources.every((src) => current.includes(src))) {
        throw new Error("A confirmed reference/first-frame image is required; upload images before generating");
      }
      if (lastUpload.imageRole !== (message.imageRole || "reference")) throw new Error("Existing attachment imageRole does not match the submission");
      upload = { uploaded: lastUpload.names, confirmation: "existing_loaded_preview", imageRole: lastUpload.imageRole };
    }
    const chat = globalThis.DoubaoChat;
    if (!chat) throw new Error("Chat support is not ready");
    const baseline = readVideos();
    const prompt = "请根据已上传的图片实际生成视频，保持参考人物的外观、服装与画风；场景和出场人物按下方脚本安排。" +
      "时长" + message.duration + "秒，比例" + message.ratio + "。" +
      (message.imageRole === "first_frame" ? "从上传的首帧开始接续动作。" : "以上传图片作为视觉参考。") +
      "无字幕、对白或背景音乐。\n" + message.prompt;
    chat.enterPrompt(input, prompt);
    await chat.sendPrompt(input);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(300);
      const text = document.body.textContent || "";
      if (!normalize(inputValue(input)) && normalize(text).includes(normalize(prompt))) {
        lastUpload = null;
        return {
          state: "submitted", uploaded: upload.uploaded, imageRole: upload.imageRole,
          parameterControl: message.controls ? "ui_controls_and_prompt" : "prompt_only",
          context: { conversationUrl: location.href, prompt, baselineUrls: baseline.map((video) => video.url),
            baselineKeys: baseline.map((video) => video.key) }
        };
      }
    }
    throw new Error("Send was attempted but the submitted message was not confirmed; do not resend automatically");
  }
  function status(job) {
    const context = job?.context;
    if (!context?.conversationUrl) return { state: "needs_recovery", reason: "Submission context is missing; inspect the pinned page and adopt the intended video explicitly" };
    const expected = new URL(context.conversationUrl);
    if (location.origin !== expected.origin || location.pathname !== expected.pathname) {
      return { state: "conversation_mismatch", reason: "The pinned tab switched conversations; no other video was selected" };
    }
    let text = document.body.innerText || "";
    if (context.prompt) {
      const compact = normalize(text);
      const marker = normalize(context.prompt);
      const position = compact.lastIndexOf(marker);
      if (position < 0) return { state: "needs_recovery", reason: "Original submitted message is not present in the current page" };
      text = compact.slice(position + marker.length);
    }
    const videos = readVideos().filter((video) => context.adoptedUrl || !(context.baselineKeys || []).includes(video.key));
    return { ...classifyMedia({ videos, baselineUrls: context.baselineUrls, adoptedUrl: context.adoptedUrl, text }),
      url: location.href, videoCount: videos.length };
  }
  function adopt(videoIndex) {
    if (!Number.isInteger(videoIndex) || videoIndex < 0) throw new Error("videoIndex must be a non-negative integer");
    const video = readVideos()[videoIndex];
    if (!video?.url || !video.duration || video.readyState < 1) throw new Error("Selected video is not ready; inspect or open its player first");
    return { state: "ready", media: video, context: { conversationUrl: location.href, adoptedUrl: video.url, baselineUrls: [] } };
  }
  async function handle(message) {
    if (message.type === "inspect") return page();
    if (message.type === "uiClick") return uiClick(message.selector, message.key, message.text);
    if (message.type === "uploadImages") return uploadImages(message);
    if (message.type === "videoSubmit") return videoSubmit(message);
    if (message.type === "videoStatus") return status(message.job);
    if (message.type === "videoAdopt") return adopt(message.videoIndex);
    throw new Error("Unknown media command");
  }
  globalThis.DoubaoMedia = { version, revision, handle };
})();
