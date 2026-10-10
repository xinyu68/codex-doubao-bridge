(() => {
  const version = globalThis.DoubaoBridgeVersion || "0.4.0";
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
  let lastPreparation = null;

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
  function page(detail = "summary") {
    const full = detail === "full";
    const result = {
      url: location.href, title: document.title, contentVersion: version, contentRevision: revision,
      detail, visibility: document.visibilityState || "unknown", settings: readSettings(),
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
        structure: full ? [...panel.querySelectorAll("*")].filter((item) => !["svg", "path", "IMG"].includes(item.tagName)).map((item) => ({
          selector: selector(item), tag: item.tagName, text: (item.children?.length ? "" : label(item)),
          attributes: Object.fromEntries([...item.attributes].filter((attribute) => /^(role|aria-|data-state|data-orientation|tabindex|type|min|max|value|style)/u.test(attribute.name)).map((attribute) => [attribute.name, attribute.value]))
        })).slice(0, 180) : undefined,
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
    if (!full) {
      result.composer.text = result.composer.text.slice(-800);
      delete result.composer.domText;
      result.composerControls = result.composerControls.filter((item) => item.visible &&
        (item.text || item.role || ["INPUT", "TEXTAREA", "SELECT"].includes(item.tag))).slice(-40).map((item) => ({
          selector: item.selector, tag: item.tag, text: item.text, role: item.role, popup: item.popup, disabled: item.disabled
        }));
      if (result.conversation) result.conversation = { text: result.conversation.text.slice(-2000) };
      result.buttons = result.buttons.slice(-30);
      result.panels = result.panels.map((panel) => ({ selector: panel.selector, text: panel.text.slice(0, 1200), controls: panel.controls.slice(0, 40) }));
      result.mediaPreviews = result.mediaPreviews.slice(-8);
    }
    return result;
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
    if (element.id === "flow-end-msg-send" || /^(?:发送|提交|生成视频|立即生成)$/u.test(label(element))) {
      throw new Error("Use the idempotent video submission tool to send a generation; UI preparation cannot submit");
    }
    lastPreparation = null;
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
    lastPreparation = null;
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
    const existing = thumbnails().filter((item) => !item.placeholder);
    if (lastUpload && lastUpload.imageRole === role && JSON.stringify(lastUpload.names) === JSON.stringify(images.map((item) => item.name)) &&
      existing.length === lastUpload.previewSources.length && existing.every((item) => item.loaded && lastUpload.previewSources.includes(item.src)) &&
      JSON.stringify(lastUpload.files) === JSON.stringify(images.map((item) => ({ name: item.name, mime: item.mime, base64: item.base64 })))) {
      return { uploaded: lastUpload.names, confirmation: "existing_loaded_preview", imageRole: role, roleVerified, reused: true };
    }
    if (existing.length) throw new Error("Composer contains other or unconfirmed attachments; inspect them before uploading again");
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
        lastUpload = { names: images.map((image) => image.name), files: images.map((item) => ({ name: item.name, mime: item.mime, base64: item.base64 })),
          previewSources: previews.map((item) => item.src), imageRole: role };
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
  function readSettings() {
    const root = composerRoot();
    const text = root.innerText || root.textContent || "";
    const unique = (items) => { const values = [...new Set(items)]; return values.length === 1 ? values[0] : null; };
    const duration = unique([...text.matchAll(/(?:^|[^\d])(\d{1,2})\s*(?:s\b|秒)/gi)].map((match) => Number(match[1])));
    const ratio = unique([...text.matchAll(/(?:9:16|16:9|1:1|3:4|4:3)/g)].map((match) => match[0]));
    const model = text.match(/Seedance\s*[\d.]+(?:\s*(?:Mini|Pro|Lite|Fast))?/i)?.[0] || null;
    return { videoMode: /视频生成/u.test(text), duration, ratio, model, source: "visible_composer", text: text.slice(-600) };
  }
  function confirmedUpload(message) {
    const current = thumbnails().filter((item) => !item.placeholder);
    if (!lastUpload || current.length !== lastUpload.previewSources.length ||
      !current.every((item) => item.loaded && lastUpload.previewSources.includes(item.src))) {
      throw new Error("A confirmed reference/first-frame image is required; upload images before generating");
    }
    if (lastUpload.imageRole !== (message.imageRole || "reference")) throw new Error("Existing attachment imageRole does not match the submission");
    return { uploaded: lastUpload.names, confirmation: "existing_loaded_preview", imageRole: lastUpload.imageRole };
  }
  function settingsMatch(settings, message) {
    return settings.videoMode && settings.duration === message.duration && settings.ratio === message.ratio &&
      (!message.model || normalize(settings.model).toLowerCase() === normalize(message.model).toLowerCase());
  }
  async function videoPrepare(message) {
    lastPreparation = null;
    const input = editors().at(-1);
    if (!input) return { state: "needs_page_ready", sent: false, reason: "Video editor is hidden or missing", page: page() };
    if (normalize(inputValue(input))) return { state: "preflight_failed", sent: false, reason: "Pinned editor contains an unsent draft" };
    if (message.controls) await applyControls(message.controls);
    if (!readSettings().videoMode) {
      const modes = [...composerRoot().querySelectorAll("button, [role='button']")].filter((item) => visible(item) && label(item) === "视频生成");
      if (modes.length === 1) await uiClick(selector(modes[0]));
    }
    const settings = readSettings();
    if (!settingsMatch(settings, message)) return { state: "needs_manual_settings", sent: false, requested: {
      duration: message.duration, ratio: message.ratio, model: message.model || null
    }, observed: settings, reason: "Use inspected controls to select the requested settings, then prepare again", page: page() };
    const upload = message.images?.length ? await uploadImages(message) : confirmedUpload(message);
    const after = readSettings();
    if (!settingsMatch(after, message) || normalize(inputValue(editors().at(-1)))) {
      return { state: "preflight_failed", sent: false, reason: "Settings or editor changed during preparation", observed: after };
    }
    lastPreparation = { duration: message.duration, ratio: message.ratio, model: message.model || null,
      settings: after, preparedAt: Date.now(), previewSources: [...lastUpload.previewSources] };
    return { state: "prepared", sent: false, ...upload, observed: after, parameterControl: "ui_verified" };
  }
  async function submissionPreflight(message) {
    const initialInput = editors().at(-1);
    if (!initialInput) throw new Error("Could not find the Doubao message editor");
    if (normalize(inputValue(initialInput))) throw new Error("Pinned editor contains an unsent draft; refusing to replace it");
    if (message.controls) await applyControls(message.controls);
    const input = editors().at(-1);
    if (!input || normalize(inputValue(input))) throw new Error("The current video editor is missing or contains an unsent draft");
    let upload;
    if (message.images?.length) {
      const preparation = lastPreparation;
      upload = await uploadImages(message);
      if (upload.reused) lastPreparation = preparation;
    }
    else upload = confirmedUpload(message);
    const settings = readSettings();
    if (message.requirePrepared && (!lastPreparation || Date.now() - lastPreparation.preparedAt > 600000 ||
      !settingsMatch(settings, message) || lastPreparation.duration !== message.duration || lastPreparation.ratio !== message.ratio ||
      lastPreparation.model !== (message.model || null) || JSON.stringify(lastPreparation.previewSources) !== JSON.stringify(lastUpload.previewSources))) {
      throw new Error("Run video preparation successfully with the same settings and images before submitting");
    }
    const chat = globalThis.DoubaoChat;
    if (!chat) throw new Error("Chat support is not ready");
    const baseline = readVideos();
    const prompt = "请根据已上传的图片实际生成视频，保持参考人物的外观、服装与画风；场景和出场人物按下方脚本安排。" +
      "时长" + message.duration + "秒，比例" + message.ratio + "。" +
      (message.imageRole === "first_frame" ? "从上传的首帧开始接续动作。" : "以上传图片作为视觉参考。") +
      (message.noText ? "不要字幕、文字或字母。" : "") +
      (message.silent ? "不要对白、配音、背景音乐或其他声音。" : "") + "\n" + message.prompt;
    return { input, upload, chat, baseline, prompt, settings };
  }
  async function videoSubmit(message) {
    let prepared;
    try { prepared = await submissionPreflight(message); }
    catch (error) { return { state: "preflight_failed", sendAttempted: false, retrySafe: true, phase: "before_send", error: error.message }; }
    const { input, upload, chat, baseline, prompt, settings } = prepared;
    // Everything from draft entry onwards is conservative: never automatically send again.
    try {
      chat.enterPrompt(input, prompt);
      await chat.sendPrompt(input);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await sleep(300);
        const text = document.body.textContent || "";
        if (!normalize(inputValue(input)) && normalize(text).includes(normalize(prompt))) {
          lastUpload = null;
          lastPreparation = null;
          return {
            state: "submitted", sendAttempted: true, retrySafe: false, uploaded: upload.uploaded, imageRole: upload.imageRole,
            parameterControl: message.requirePrepared ? "ui_verified" : message.controls ? "ui_controls_and_prompt" : "prompt_only", observed: settings,
            context: { conversationUrl: location.href, prompt, baselineUrls: baseline.map((video) => video.url),
              baselineKeys: baseline.map((video) => video.key) }
          };
        }
      }
      throw new Error("Send was attempted but the submitted message was not confirmed; do not resend automatically");
    } catch (error) { return { state: "unknown", sendAttempted: true, retrySafe: false, phase: "send_or_confirmation", error: error.message,
      context: { conversationUrl: location.href, prompt, baselineUrls: baseline.map((video) => video.url) } }; }
  }
  function status(job) {
    const context = job?.context;
    if (!context?.conversationUrl) return { state: "needs_recovery", reason: "Submission context is missing; inspect the pinned page and adopt the intended video explicitly" };
    const expected = new URL(context.conversationUrl);
    if (location.origin !== expected.origin || location.pathname !== expected.pathname) {
      return { state: "conversation_mismatch", reason: "The pinned tab switched conversations; no other video was selected" };
    }
    let text = document.body.innerText || "";
    let videos = readVideos();
    if (context.prompt) {
      // DOM positions are reusable; scope by the submitted message and its replies instead.
      const messages = [...document.querySelectorAll("[data-testid='send_message'], [data-testid='receive_message'], [data-message-author-role]")];
      const isUser = (item) => item.getAttribute("data-testid") === "send_message" || item.getAttribute("data-message-author-role") === "user";
      const index = messages.findLastIndex((item) => isUser(item) && normalize(item.innerText || item.textContent).includes(normalize(context.prompt)));
      if (index >= 0) {
        const next = messages.findIndex((item, position) => position > index && isUser(item));
        const replies = messages.slice(index + 1, next < 0 ? undefined : next).filter((item) => !isUser(item));
        text = replies.map((item) => item.innerText || item.textContent || "").join("\n");
        const selectors = new Set(replies.flatMap((item) => [...item.querySelectorAll("video")]).map(selector));
        videos = videos.filter((video) => selectors.has(video.selector));
      } else {
        if (messages.some(isUser)) return { state: "needs_recovery", reason: "Original message is not mounted; inspect the conversation and adopt explicitly" };
        const compact = normalize(text);
        const marker = normalize(context.prompt);
        const position = compact.lastIndexOf(marker);
        if (position < 0) return { state: "needs_recovery", reason: "Original submitted message is not present in the current page" };
        text = compact.slice(position + marker.length);
      }
    }
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
    if (message.type === "inspect") return page(message.detail);
    if (message.type === "uiClick") return uiClick(message.selector, message.key, message.text);
    if (message.type === "uploadImages") return uploadImages(message);
    if (message.type === "videoPrepare") return videoPrepare(message);
    if (message.type === "videoSubmit") return videoSubmit(message);
    if (message.type === "videoStatus") return status(message.job);
    if (message.type === "videoAdopt") return adopt(message.videoIndex);
    throw new Error("Unknown media command");
  }
  globalThis.DoubaoMedia = { version, revision, handle };
})();
