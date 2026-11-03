import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildRequest } from '../lib.mjs';

test('辞退と日付変更の開発用場面は、採点基準を比較相手に渡さない', async () => {
  for (const file of ['07-declined-task.json', '08-moved-request.json']) {
    const scenario = JSON.parse(await readFile(new URL(`../cases/${file}`, import.meta.url), 'utf8'));
    assert.equal(scenario.synthetic, true);
    assert.equal(scenario.expected.length, 5);
    assert.ok(scenario.expected.some((check) => check.critical));
    for (const input of ['raw', 'facts']) {
      const request = buildRequest({ scenario, input, prompt: '評価用', model: 'model' });
      const text = JSON.stringify(request);
      for (const check of scenario.expected) {
        assert.equal(text.includes(check.check), false);
        assert.equal(text.includes(check.id), false);
      }
      assert.match(text, /12月7日/);
    }
  }
});
