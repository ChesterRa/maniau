import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildRequest } from '../lib.mjs';

const scenario = JSON.parse(await readFile(new URL('../cases/05-joint-care.json', import.meta.url), 'utf8'));
const conflict = JSON.parse(await readFile(new URL('../cases/06-joint-conflict.json', import.meta.url), 'utf8'));

test('二日分の開発用場面は、採点と入力を分けて送る', () => {
  assert.equal(scenario.synthetic, true);
  assert.equal(scenario.now, '2026-11-30T17:00:00+09:00');
  assert.equal(scenario.expected.length, 5);
  assert.ok(scenario.expected.some((check) => check.critical));
  for (const input of ['raw', 'facts']) {
    const request = buildRequest({ scenario, input, prompt: '評価用', model: 'model' });
    const text = JSON.stringify(request);
    assert.doesNotMatch(text, /J1|J2|J3|J4|J5|変えずに置く候補があるため/);
    assert.match(text, /17時20分/);
    assert.match(text, /18時05分/);
  }
});

test('時間の重なる開発用場面も、正解をモデルに渡さない', () => {
  assert.equal(conflict.synthetic, true);
  assert.equal(conflict.now, '2026-11-30T17:00:00+09:00');
  assert.equal(conflict.expected.length, 5);
  for (const input of ['raw', 'facts']) {
    const request = buildRequest({ scenario: conflict, input, prompt: '評価用', model: 'model' });
    const text = JSON.stringify(request);
    assert.doesNotMatch(text, /K1|K2|K3|K4|K5|両方重ねずに置けないと示す/);
    assert.match(text, /17時10分/);
    assert.match(text, /17時25分/);
    assert.match(text, /15分/);
  }
});
