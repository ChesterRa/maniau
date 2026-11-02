import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentUtteranceClient } from '../utterance-api.mjs';

test('読んだ結果が使えなくても、応答時の使用量と回数を先に記録する', async () => {
  const entries = [];
  const client = instrumentUtteranceClient({
    messages: { parse: async () => ({
      model: 'model-example', stop_reason: 'max_tokens', _request_id: 'provider-id',
      usage: { input_tokens: 200, output_tokens: 100, inference_geo: 'global', speed: 'standard' },
    }) },
  }, { ledger: async (entry) => entries.push(entry), pricing: { model: 'model-example', input: 4, output: 20 } });
  await client.messages.parse({ model: 'model-example', max_tokens: 1000, system: '架空の指示', messages: [{ text: '架空の発言' }] });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, 'request_started');
  assert.equal(entries[1].event, 'request_finished');
  assert.equal(entries[0].request_id, entries[1].request_id);
  assert.equal(entries[1].stop_reason, 'max_tokens');
  assert.equal(entries[1].cost_usd, 0.0028);
  assert.ok(!JSON.stringify(entries).includes('架空の発言'));
  assert.ok(!JSON.stringify(entries).includes('架空の指示'));
});

test('通信や拒否で使用量を得られない時は不明とし、エラー本文を保存しない', async () => {
  const entries = [];
  const client = instrumentUtteranceClient({ messages: { parse: async () => { throw new Error('private message'); } } }, {
    ledger: async (entry) => entries.push(entry), pricing: { model: 'm', input: 4, output: 20 },
  });
  await assert.rejects(client.messages.parse({ model: 'm' }));
  assert.equal(entries.length, 2);
  assert.equal(entries[1].outcome, 'network_or_client_error');
  assert.equal(entries[1].usage, null);
  assert.equal(entries[1].cost_usd, null);
  assert.ok(!JSON.stringify(entries).includes('private message'));
});

test('課金区分やキャッシュを確認できなければ費用を不明にする', async () => {
  const entries = [];
  const client = instrumentUtteranceClient({ messages: { parse: async () => ({
    model: 'm', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 5 },
  }) } }, { ledger: async (entry) => entries.push(entry), pricing: { model: 'm', input: 4, output: 20 } });
  await client.messages.parse({ model: 'm' });
  assert.equal(entries[1].usage.cache_read_input_tokens, 5);
  assert.equal(entries[1].cost_usd, null);
});

test('単価と応答のモデルが違う時は費用を推測しない', async () => {
  const entries = [];
  const client = instrumentUtteranceClient({ messages: { parse: async () => ({
    model: 'other', usage: { input_tokens: 10, output_tokens: 10, inference_geo: 'global' },
  }) } }, { ledger: async (entry) => entries.push(entry), pricing: { model: 'm', input: 4, output: 20 } });
  await client.messages.parse({ model: 'm' });
  assert.equal(entries[1].cost_usd, null);
});

test('標準速度を応答で確認できない時は費用を推測しない', async () => {
  const entries = [];
  const client = instrumentUtteranceClient({ messages: { parse: async () => ({
    model: 'm', usage: { input_tokens: 10, output_tokens: 10, inference_geo: 'global' },
  }) } }, { ledger: async (entry) => entries.push(entry), pricing: { model: 'm', input: 4, output: 20 } });
  await client.messages.parse({ model: 'm' });
  assert.equal(entries[1].cost_usd, null);
});
