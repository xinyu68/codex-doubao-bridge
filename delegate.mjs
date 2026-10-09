export const DELEGATE_OPEN = "<DELEGATE_FINAL>";
export const DELEGATE_CLOSE = "</DELEGATE_FINAL>";

export function buildDelegatePrompt(task) {
  return `你是一个受委派的执行器。请独立完成下面的任务，先自行分析和校验，不要向用户提问，不要展示思考过程。\n\n无论任务是否能完全完成，都必须且只能按以下格式回复：\n${DELEGATE_OPEN}\n最终结论；无法完成时请简要说明限制、假设或缺少的信息。\n${DELEGATE_CLOSE}\n\n任务：\n${task}`;
}

export function extractDelegateFinal(text) {
  const start = text.lastIndexOf(DELEGATE_OPEN);
  if (start < 0) return null;
  const bodyStart = start + DELEGATE_OPEN.length;
  const end = text.indexOf(DELEGATE_CLOSE, bodyStart);
  if (end < 0) return null;
  const finalText = text.slice(bodyStart, end).trim();
  return finalText || null;
}

export async function runDelegation(task, sendCommand) {
  await sendCommand("newChat", {}, 20000);
  const reply = await sendCommand("ask", { prompt: buildDelegatePrompt(task) }, 120000);
  const finalText = extractDelegateFinal(reply);
  if (finalText) return finalText;
  throw new Error(`Doubao did not return a final answer marked with ${DELEGATE_OPEN}`);
}
