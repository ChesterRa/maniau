// 製品に送る入力と採点器がハッシュする入力を照らす。通信はしない。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildExtractInput } from '../../apps/server/src/reading/extract';
import { ExtractionOutput, Source, toExtraction } from '../../packages/core/src';
import { inputForModel, scoreReadingV4 } from '../reading-v4-score.mjs';

test('参照解と採点項目を送らず、製品の読み取り入力と一致する', async () => {
  const scenario = JSON.parse(
    await readFile(new URL('../cases/reading-v4/dev-01.json', import.meta.url), 'utf8'),
  );
  const actual = buildExtractInput({
    source: scenario.source,
    schoolYear: scenario.schoolYear,
    priorItems: scenario.priorItems,
    priorUnknowns: scenario.priorUnknowns,
  });
  assert.equal(actual, JSON.stringify(inputForModel(scenario)));
  assert.equal(Object.hasOwn(JSON.parse(actual), 'expected'), false);
});

test('前の事項がある場合も、製品が渡す欄だけをハッシュする', async () => {
  const scenario = JSON.parse(
    await readFile(new URL('../cases/reading-v4/dev-01.json', import.meta.url), 'utf8'),
  );
  scenario.priorItems = [
    {
      id: 'prior-1',
      kind: 'event',
      written: '架空の行事',
      interpretation: { what: '架空の行事' },
      sentenceIds: ['previous-1'],
      evidence: 'confirmed',
    },
  ];
  const actual = buildExtractInput({
    source: scenario.source,
    schoolYear: scenario.schoolYear,
    priorItems: scenario.priorItems,
    priorUnknowns: scenario.priorUnknowns,
  });
  assert.equal(actual, JSON.stringify(inputForModel(scenario)));
  assert.equal(Object.hasOwn(JSON.parse(actual).priorItems[0], 'evidence'), false);
});

test('跨句・逆順の参照と全半角・空白の引用は、製品と採点器で同じに照らす', async () => {
  const scenario = JSON.parse(
    await readFile(new URL('../cases/reading-v4/dev-02.json', import.meta.url), 'utf8'),
  );
  const source = Source.parse(scenario.source);
  const ids = [source.sentences[1]?.id, source.sentences[0]?.id];
  assert.ok(ids[0] && ids[1]);
  for (const [written, expected] of [
    ['ご参加ください。　会場は地域交流室です。', true],
    ['１２月１２日（土） １３:００〜１４:００', true],
    ['書かれていない引用', false],
  ] as const) {
    const output = ExtractionOutput.parse({
      items: [
        {
          id: 'i1', sentenceIds: ids, kind: 'event', written, date: null,
          writtenWeekday: 'none', startTime: null, endTime: null, what: null,
          dayType: null, deadline: null, audience: null, place: null, relativeDay: 'none',
          conditionNodeId: null, inferred: false, familyAction: false, shape: 'none', effects: [],
        },
      ],
      unknowns: [], conditions: [], irrelevantSentenceIds: [], ambiguities: [],
    });
    const product = toExtraction(output, source, { priorItems: [], priorUnknowns: [] });
    const productAccepts = !product.issues.some((issue) => issue.problem === 'quoteMismatch');
    const score = scoreReadingV4(scenario, output);
    const scored = score.checks.find((check: { id: string }) => check.id === 'source-evidence');
    assert.equal(productAccepts, expected, written);
    assert.equal(scored?.status === 'pass', expected, written);
  }
});
