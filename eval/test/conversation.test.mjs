import assert from 'node:assert/strict';
import test from 'node:test';
import { runConversation } from '../conversation.mjs';

test('必要な質問の後だけ答えを渡し、道具の結果を次のリクエストに含める', async () => {
  const requests = [];
  const request = { messages: [{ role: 'user', content: '場面' }] };
  const result = await runConversation({
    request,
    send: async (payload) => {
      requests.push(structuredClone(payload));
      if (requests.length === 1) return {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'ask-1', name: 'ask_family', input: { question: 'ありますか？' } },
          { type: 'tool_use', id: 'date-1', name: 'calendar_calculation', input: { operation: 'weekday', value: '2026-12-07' } },
        ],
      };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '次の一手' }] };
    },
    answer: async (question) => { assert.equal(question, 'ありますか？'); return 'ありません'; },
  });
  assert.equal(result.status, 'completed');
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[0]), /ありません/);
  const toolResults = requests[1].messages.at(-1).content;
  assert.deepEqual(toolResults.map((item) => item.tool_use_id), ['ask-1', 'date-1']);
  assert.equal(toolResults[0].content, 'ありません');
  assert.match(toolResults[1].content, /月/);
});

test('途中打ち切りや上限は完了と扱わない', async () => {
  const truncated = await runConversation({
    request: { messages: [] }, send: async () => ({ stop_reason: 'max_tokens', content: [] }), answer: async () => '',
  });
  assert.equal(truncated.status, 'incomplete');
  assert.equal(truncated.reason, 'max_tokens');
  const empty = await runConversation({
    request: { messages: [] }, send: async () => ({ stop_reason: 'end_turn', content: [] }), answer: async () => '',
  });
  assert.equal(empty.status, 'incomplete');
  assert.equal(empty.reason, 'empty_response');
  const limited = await runConversation({
    request: { messages: [] }, maxRequests: 1,
    send: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: '1', name: 'ask_family', input: { question: '質問' } }] }),
    answer: async () => '不明',
  });
  assert.equal(limited.status, 'incomplete');
  assert.equal(limited.reason, 'request_limit');
});
