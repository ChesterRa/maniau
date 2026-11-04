import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequest, calculateCalendar, estimateCost } from '../lib.mjs';

test('評価者だけの正解と質問への答えを初回の入力に含めない', () => {
  const scenario = {
    synthetic: true,
    now: '2026-11-27T17:00:00+09:00',
    raw: ['元の文'],
    facts: [{ fact: '整理した事実' }],
    expected: [{ check: '採点だけの秘密' }],
    interview: [{ answer: '質問前の秘密' }],
  };
  const raw = JSON.stringify(buildRequest({ scenario, input: 'raw', prompt: 'プロンプト', model: 'model' }));
  assert.match(raw, /元の文/);
  assert.doesNotMatch(raw, /採点だけの秘密|質問前の秘密|整理した事実/);
  const facts = JSON.stringify(buildRequest({ scenario, input: 'facts', prompt: 'プロンプト', model: 'model' }));
  assert.match(facts, /整理した事実/);
  assert.doesNotMatch(facts, /採点だけの秘密|質問前の秘密|元の文/);
  assert.throws(() => buildRequest({ scenario: { ...scenario, synthetic: false }, input: 'raw', prompt: 'p', model: 'm' }));
});

test('日本の祝日と週末をまたぐ営業日を開始日を含めずに数える', () => {
  assert.deepEqual(calculateCalendar({ operation: 'add_business_days', value: '2026-11-20', amount: 1 }), {
    date: '2026-11-24', weekday: '火', excludes_start_day: true,
  });
  assert.deepEqual(calculateCalendar({ operation: 'add_business_days', value: '2026-11-24', amount: -1 }), {
    date: '2026-11-20', weekday: '金', excludes_start_day: true,
  });
  assert.throws(() => calculateCalendar({ operation: 'add_business_days', value: '2026-12-31', amount: 1 }), /範囲/);
});

test('曜日と時刻の算数は存在しない日時を受け付けない', () => {
  assert.deepEqual(calculateCalendar({ operation: 'weekday', value: '2026-12-07' }), { date: '2026-12-07', weekday: '月' });
  assert.deepEqual(calculateCalendar({ operation: 'add_minutes', value: '2026-11-30T17:30:00+09:00', amount: -10 }), {
    datetime: '2026-11-30T17:20:00+09:00',
  });
  assert.throws(() => calculateCalendar({ operation: 'weekday', value: '2026-02-30' }));
  assert.throws(() => calculateCalendar({ operation: 'add_minutes', value: '2026-11-30T24:00:00+09:00', amount: 1 }));
});

test('料金の根拠がない使用量、地域割増、キャッシュ料金は不明にする', () => {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, inference_geo: 'global', speed: 'standard' };
  assert.equal(estimateCost(usage, { input: 4, output: 20 }), 0.014);
  assert.equal(estimateCost(usage, null), null);
  assert.equal(estimateCost({ ...usage, cache_read_input_tokens: 1 }, { input: 4, output: 20 }), null);
  assert.equal(estimateCost({ ...usage, inference_geo: 'us' }, { input: 4, output: 20 }), null);
  assert.equal(estimateCost({ ...usage, inference_geo: undefined }, { input: 4, output: 20 }), null);
  assert.equal(estimateCost({ ...usage, speed: 'fast' }, { input: 4, output: 20 }), null);
  assert.equal(estimateCost({ ...usage, speed: 'fast' }, { input: 8, output: 40, speed: 'fast' }), 0.028);
  assert.equal(estimateCost(usage, { input: 8, output: 40, speed: 'fast' }), null);
  assert.equal(estimateCost({ ...usage, speed: undefined }, { input: 8, output: 40, speed: 'fast' }), null);
  assert.equal(estimateCost(null, { input: 4, output: 20 }), null);
});
