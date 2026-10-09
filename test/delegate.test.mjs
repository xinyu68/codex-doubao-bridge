import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDelegatePrompt,
  DELEGATE_CLOSE,
  DELEGATE_OPEN,
  extractDelegateFinal,
  runDelegation
} from "../delegate.mjs";

test("extractDelegateFinal keeps only the delimited answer", () => {
  const raw = `任务回显：请使用 ${DELEGATE_OPEN} 和 ${DELEGATE_CLOSE}\n${DELEGATE_OPEN}\n最终答案\n${DELEGATE_CLOSE}\n推荐问题`;
  assert.equal(extractDelegateFinal(raw), "最终答案");
  assert.equal(extractDelegateFinal("没有完成标签"), null);
});

test("buildDelegatePrompt requires a final answer even with limitations", () => {
  const prompt = buildDelegatePrompt("分析任务");
  assert.match(prompt, new RegExp(DELEGATE_OPEN.replace(/[<>]/g, "\\$&")));
  assert.match(prompt, /无论任务是否能完全完成/);
});

test("runDelegation stops after the first final answer", async () => {
  const commands = [];
  const result = await runDelegation("写一段摘要", async (type, payload) => {
    commands.push({ type, payload });
    return type === "newChat" ? "New chat ready" : `${DELEGATE_OPEN}\n摘要\n${DELEGATE_CLOSE}`;
  });

  assert.equal(result, "摘要");
  assert.deepEqual(commands.map((command) => command.type), ["newChat", "ask"]);
});

test("runDelegation rejects an answer without a final marker", async () => {
  await assert.rejects(
    runDelegation("完成任务", async (type) => type === "newChat" ? "New chat ready" : "仍未完成"),
    /final answer/
  );
});
