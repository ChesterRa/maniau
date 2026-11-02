import { calculateCalendar } from './lib.mjs';

export async function runConversation({ request, send, answer, onUpdate = async () => {}, maxRequests = 8 }) {
  const messages = structuredClone(request.messages);
  let requests = 0;
  const snapshot = async (status, reason = null) => onUpdate({ messages, requests, status, reason });
  while (requests < maxRequests) {
    requests += 1;
    const response = await send({ ...request, messages }, requests);
    if (!Array.isArray(response.content) || typeof response.stop_reason !== 'string') {
      await snapshot('incomplete', 'invalid_response');
      return { messages, requests, status: 'incomplete', reason: 'invalid_response' };
    }
    messages.push({ role: 'assistant', content: response.content });
    await snapshot('running');
    if (response.stop_reason === 'end_turn') {
      if (response.content.some((block) => block.type === 'tool_use')) {
        await snapshot('incomplete', 'unresolved_tool');
        return { messages, requests, status: 'incomplete', reason: 'unresolved_tool' };
      }
      if (!response.content.some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim())) {
        await snapshot('incomplete', 'empty_response');
        return { messages, requests, status: 'incomplete', reason: 'empty_response' };
      }
      await snapshot('completed');
      return { messages, requests, status: 'completed', reason: null };
    }
    if (response.stop_reason !== 'tool_use') {
      await snapshot('incomplete', response.stop_reason);
      return { messages, requests, status: 'incomplete', reason: response.stop_reason };
    }
    const calls = response.content.filter((block) => block.type === 'tool_use');
    if (calls.length === 0 || calls.some((call) => typeof call.id !== 'string')) {
      await snapshot('incomplete', 'invalid_tool_use');
      return { messages, requests, status: 'incomplete', reason: 'invalid_tool_use' };
    }
    const results = [];
    for (const call of calls) {
      let result;
      let isError = false;
      try {
        if (call.name === 'ask_family') {
          if (typeof call.input?.question !== 'string' || !call.input.question.trim()) throw new Error('質問がありません。');
          result = await answer(call.input.question);
        } else if (call.name === 'calendar_calculation') {
          result = JSON.stringify(calculateCalendar(call.input ?? {}));
        } else {
          throw new Error('未対応の道具です。');
        }
      } catch (error) {
        result = error instanceof Error ? error.message : '道具を実行できませんでした。';
        isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: String(result), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
    await snapshot('running');
  }
  await snapshot('incomplete', 'request_limit');
  return { messages, requests, status: 'incomplete', reason: 'request_limit' };
}
