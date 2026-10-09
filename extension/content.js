(() => {
const contentVersion = globalThis.DoubaoBridgeVersion || "0.3.1";
const contentRevision = globalThis.DoubaoBridgeRevision || "attachments-v2";
const previousController = globalThis.__doubaoBridgeController;
if (previousController?.version === contentVersion && previousController?.revision === contentRevision) return;
if (globalThis.__doubaoBridgeContentReady && !previousController) {
  throw new Error("Legacy webpage script is still loaded. Refresh this Doubao tab once; unsent drafts were not changed.");
}
if (previousController) chrome.runtime.onMessage.removeListener(previousController.listener);
globalThis.__doubaoBridgeContentReady = true;
function visible(element) {
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
}

function editable() {
  return [...document.querySelectorAll("textarea, [contenteditable='true']")].filter(visible).at(-1);
}

function answerText() {
  const selectors = [
    "[data-message-author-role='assistant']",
    "[data-testid*='assistant']",
    "[class*='assistant-message']",
    "[class*='bot-message']"
  ];
  const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).filter(visible);
  return (candidates.at(-1)?.innerText || "").trim();
}

function enterPrompt(element, prompt) {
  element.focus();
  if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(element, prompt);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, prompt);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
  }
}

async function waitForEnabledSendButton() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const button = document.querySelector("#flow-end-msg-send");
    if (button instanceof HTMLElement && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function sendPrompt(element) {
  const button = await waitForEnabledSendButton();
  if (button) {
    button.click();
    return;
  }
  element.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", code: "Enter", bubbles: true, cancelable: true
  }));
  element.dispatchEvent(new KeyboardEvent("keyup", {
    key: "Enter", code: "Enter", bubbles: true, cancelable: true
  }));
}

function addedText(before, current) {
  let index = 0;
  const limit = Math.min(before.length, current.length);
  while (index < limit && before[index] === current[index]) index += 1;
  return current.slice(index).trim();
}

async function waitForAnswer(prompt, before, beforePage) {
  const deadline = Date.now() + 110000;
  let last = "";
  let stableCount = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const current = answerText();
    if (current && current !== before) {
      stableCount = current === last ? stableCount + 1 : 0;
      last = current;
      if (stableCount >= 3) return { text: current };
    }
    const newPageText = addedText(beforePage, document.body.innerText);
    if (newPageText.includes(prompt)) {
      const reply = newPageText.slice(newPageText.lastIndexOf(prompt) + prompt.length).trim();
      if (reply && !/^下载电脑版\s*有什么我能帮你的吗/u.test(reply)) {
        stableCount = reply === last ? stableCount + 1 : 0;
        last = reply;
        if (stableCount >= 7) return { text: reply };
      }
    }
  }
  throw new Error("Timed out waiting for Doubao's response");
}

globalThis.DoubaoChat = { enterPrompt, sendPrompt };

async function handleMessage(message) {
  const { type, prompt } = message;
  if (type === "bridgePing") {
    const editor = editable();
    return { version: contentVersion, revision: contentRevision, mediaRevision: globalThis.DoubaoMedia?.revision || null, mediaVersion: globalThis.DoubaoMedia?.version || null,
      editorPresent: Boolean(editor), draftPresent: Boolean(editor && (editor.value || editor.textContent || "").trim()) };
  }
  if (["inspect", "uiClick", "uploadImages", "videoSubmit", "videoStatus", "videoAdopt"].includes(type)) {
    return globalThis.DoubaoMedia.handle(message);
  }
  if (type === "read") {
    const text = answerText() || document.body.innerText.trim();
    if (!text) throw new Error("Could not find text in the Doubao page");
    return { text };
  }
  if (type !== "ask") throw new Error("Unknown Doubao page command");
  const input = editable();
  if (!input) throw new Error("Could not find Doubao's message editor");
  const before = answerText();
  const beforePage = document.body.innerText;
  enterPrompt(input, prompt);
  await sendPrompt(input);
  return waitForAnswer(prompt, before, beforePage);
}

const listener = (message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse, (error) => sendResponse({ __bridgeError: error.message }));
  return true;
};
chrome.runtime.onMessage.addListener(listener);
globalThis.__doubaoBridgeController = { version: contentVersion, revision: contentRevision, listener };

})();
