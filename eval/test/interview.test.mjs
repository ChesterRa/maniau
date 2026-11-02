import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveInterview } from '../interview.mjs';

test('非対話の質問にも、該当する場面の答えだけを返す', async () => {
  const scenario = JSON.parse(await readFile(new URL('../cases/04-questions.json', import.meta.url), 'utf8'));
  assert.deepEqual(resolveInterview('白い長袖シャツは家にありますか？', scenario.interview), {
    answer: '白い長袖シャツは家にありません。',
    matched_rules: [{ topic: '白い長袖シャツの有無', groups: [['シャツ', '家'], ['シャツ', 'あり'], ['長袖', '家']] }],
    resolution: 'matched',
  });
  assert.deepEqual(resolveInterview('水筒の色は何色ですか？', scenario.interview), {
    answer: '分かりません。', matched_rules: [], resolution: 'unknown',
  });
  assert.equal(resolveInterview('店にシャツはありますか？', scenario.interview).resolution, 'unknown');
});

test('複数の答えに一致した質問は勝手に一つを選ばない', () => {
  const rules = [
    { topic: '一つ目', match: [['シャツ']], answer: '一つ目の答え' },
    { topic: '二つ目', match: [['シャツ']], answer: '二つ目の答え' },
  ];
  assert.deepEqual(resolveInterview('シャツはありますか？', rules), {
    answer: '分かりません。', matched_rules: [
      { topic: '一つ目', groups: [['シャツ']] },
      { topic: '二つ目', groups: [['シャツ']] },
    ], resolution: 'ambiguous',
  });
});
