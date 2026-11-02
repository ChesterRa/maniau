import assert from 'node:assert/strict';
import test from 'node:test';
import { callClaude } from '../api.mjs';

test('使用量とモデルを各リクエストに対応付け、鍵は台帳に書かない', async () => {
  const entries = [];
  const result = await callClaude({
    payload: { model: 'test-model' }, number: 1, key: '架空の鍵',
    pricing: { input: 4, output: 20 }, ledger: async (entry) => entries.push(entry),
    fetchImpl: async (_url, options) => {
      assert.equal(entries[0].event, 'request_started');
      assert.equal(options.headers['x-api-key'], '架空の鍵');
      return new Response(JSON.stringify({ model: 'served-model', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } }), {
        status: 200, headers: { 'request-id': 'request-test' },
      });
    },
  });
  assert.equal(result.model, 'served-model');
  assert.equal(entries[0].request_id, entries[1].request_id);
  assert.equal(entries[1].actual_model, 'served-model');
  assert.equal(entries[1].cost_usd, 0.014);
  assert.doesNotMatch(JSON.stringify(entries), /架空の鍵/);
});

test('通信が途切れた試行の費用は不明として残す', async () => {
  const entries = [];
  await assert.rejects(callClaude({
    payload: {}, number: 2, key: '架空の鍵', pricing: null,
    ledger: async (entry) => entries.push(entry),
    fetchImpl: async () => { throw new Error('擬似的な通信エラー'); },
  }), /課金の有無は不明/);
  assert.equal(entries[1].outcome, 'network_error');
  assert.equal(entries[1].cost_usd, null);
  assert.equal(entries[0].request_id, entries[1].request_id);
});

test('制限・過負荷への再試行は個別に記録し、Retry-After を守る', async () => {
  const entries = [];
  const waits = [];
  let calls = 0;
  const result = await callClaude({
    payload: {}, number: 1, key: '架空の鍵', pricing: null,
    ledger: async (entry) => entries.push(entry),
    sleepImpl: async (ms) => waits.push(ms),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
      if (calls === 2) return new Response('{}', { status: 529 });
      return new Response('{"content":[],"stop_reason":"end_turn"}', { status: 200 });
    },
  });
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
  const starts = entries.filter((entry) => entry.event === 'request_started');
  assert.deepEqual(starts.map((entry) => entry.attempt), [1, 2, 3]);
  assert.equal(new Set(starts.map((entry) => entry.request_id)).size, 3);
  assert.equal(entries.filter((entry) => entry.event === 'request_finished').length, 3);
  assert.equal(entries.find((entry) => entry.http_status === 429).cost_usd, null);
});

test('長い Retry-After は早送りせずに試行を止める', async () => {
  let calls = 0;
  await assert.rejects(callClaude({
    payload: {}, number: 1, key: '架空の鍵', pricing: null, ledger: async () => {},
    sleepImpl: async () => assert.fail('待たずに再試行するべきではない'),
    fetchImpl: async () => { calls += 1; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } }); },
  }), /HTTP 429/);
  assert.equal(calls, 1);
});
