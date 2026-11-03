import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inputForModel, reviewReadingV4, scoreReadingV4 } from '../reading-v4-score.mjs';

const root = new URL('../cases/reading-v4/', import.meta.url);
const load = async (file) => JSON.parse(await readFile(new URL(file, root), 'utf8'));
const item = (source, index, kind, fields = {}) => ({
  kind,
  written: source.sentences[index - 1].text,
  sentenceIds: [source.sentences[index - 1].id],
  inferred: false,
  ...fields,
});
const response = (items, rest = {}) => ({
  items,
  unknowns: [],
  conditions: [],
  irrelevantSentenceIds: [],
  ambiguities: [],
  ...rest,
});
const status = (result, id) => result.checks.find((check) => check.id === id)?.status;

test('開発用の場面は架空で、参照する文・確認点が一意', async () => {
  const files = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
  assert.equal(files.length, 5);
  for (const file of files) {
    const scenario = await load(file);
    assert.equal(scenario.synthetic, true);
    assert.equal(scenario.task, 'extraction');
    const ids = new Set(scenario.source.sentences.map((sentence) => sentence.id));
    assert.equal(ids.size, scenario.source.sentences.length);
    const checks = scenario.expected.checks;
    assert.equal(new Set(checks.map((check) => check.id)).size, checks.length);
    assert.ok(checks.length > 0 && scenario.expected.manual.length > 0);
    for (const check of checks) {
      assert.ok(ids.has(check.sentenceId));
      assert.equal(check.critical, true);
    }
    const modelInput = inputForModel(scenario);
    assert.deepEqual(Object.keys(modelInput), [
      'receivedAt',
      'schoolYear',
      'sender',
      'sentences',
      'priorItems',
      'priorUnknowns',
    ]);
    assert.ok(!JSON.stringify(modelInput).includes('expected'));
  }
});

test('旧種別は残し、同じ事項を need と重ねたら失敗とする', async () => {
  const scenario = await load('dev-01.json');
  const source = scenario.source;
  const values = [
    item(source, 1, 'event'),
    item(source, 2, 'duty', { familyAction: true }),
    item(source, 3, 'submission'),
    item(source, 4, 'belongings'),
    item(source, 5, 'homework', { familyAction: true }),
    item(source, 6, 'duty', { familyAction: false }),
  ];
  const good = scoreReadingV4(scenario, response(values));
  assert.equal(good.state, 'partial');
  assert.ok(good.checks.every((check) => check.status === 'pass'));
  assert.ok(good.manual.every((check) => check.status === 'pending'));
  const duplicated = scoreReadingV4(scenario, response([...values, item(source, 3, 'need')]));
  assert.equal(status(duplicated, 'dev-01-06'), 'fail');
  const wrongFamily = structuredClone(values);
  wrongFamily[1].familyAction = false;
  assert.equal(status(scoreReadingV4(scenario, response(wrongFamily)), 'dev-01-03'), 'fail');
});

test('行事と家族の出席は、一文にあっても別々に確かめる', async () => {
  const scenario = await load('dev-02.json');
  const fields = { date: '2026-12-12', startTime: '13:00', endTime: '14:00' };
  const event = item(scenario.source, 1, 'event', fields);
  const need = item(scenario.source, 1, 'need', { ...fields, shape: 'window' });
  const both = scoreReadingV4(scenario, response([event, need]));
  assert.equal(status(both, 'dev-02-01'), 'pass');
  assert.equal(status(both, 'dev-02-02'), 'pass');
  assert.equal(status(scoreReadingV4(scenario, response([event])), 'dev-02-02'), 'fail');
  const uncertain = response([event], {
    ambiguities: [{ sentenceId: scenario.source.sentences[0].id, note: '確かめる' }],
  });
  assert.equal(status(scoreReadingV4(scenario, uncertain), 'dev-02-02'), 'undetermined');
  uncertain.ambiguities[0].note = '   ';
  assert.equal(status(scoreReadingV4(scenario, uncertain), 'dev-02-02'), 'fail');
});

test('締切と条件付きの家族の行動を別に確かめ、条件の参照も検査する', async () => {
  const scenario = await load('dev-03.json');
  const deadline = '2026-12-04T17:00+09:00';
  const items = [
    item(scenario.source, 1, 'deadline', { deadline }),
    item(scenario.source, 1, 'need', { shape: 'by', deadline, conditionNodeId: 'c' }),
  ];
  const valid = response(items, {
    unknowns: [{ id: 'u', values: ['はい', 'いいえ'] }],
    conditions: [{ id: 'c', kind: 'eq', unknownId: 'u', value: 'はい', childIds: [] }],
  });
  const result = scoreReadingV4(scenario, valid);
  assert.equal(status(result, 'dev-03-01'), 'pass');
  assert.equal(status(result, 'dev-03-02'), 'pass');
  assert.equal(status(result, 'condition-references'), 'pass');
  assert.ok(result.manual.every((check) => check.status === 'pending'));
  const dangling = structuredClone(valid);
  dangling.conditions = [];
  assert.equal(status(scoreReadingV4(scenario, dangling), 'condition-references'), 'fail');
  const cycle = structuredClone(valid);
  cycle.conditions = [{ id: 'c', kind: 'not', childIds: ['c'] }];
  assert.equal(status(scoreReadingV4(scenario, cycle), 'condition-references'), 'fail');
  const wrongValue = structuredClone(valid);
  wrongValue.conditions[0].value = '別の値';
  assert.equal(status(scoreReadingV4(scenario, wrongValue), 'condition-references'), 'fail');
  const missing = structuredClone(valid);
  missing.items[1].conditionNodeId = null;
  assert.equal(status(scoreReadingV4(scenario, missing), 'dev-03-02'), 'fail');
  missing.ambiguities = [{ sentenceId: scenario.source.sentences[0].id, note: '条件は未確認' }];
  assert.equal(status(scoreReadingV4(scenario, missing), 'dev-03-02'), 'undetermined');
  missing.items[1].deadline = '2026-12-05T17:00+09:00';
  assert.equal(status(scoreReadingV4(scenario, missing), 'dev-03-02'), 'fail');
});

test('不完全な窓から時刻や締切を作らず、未確認を残す', async () => {
  const scenario = await load('dev-04.json');
  const event = item(scenario.source, 1, 'event', { date: '2026-12-13', startTime: '09:00' });
  const need = item(scenario.source, 1, 'need', { shape: 'window', endTime: null });
  const result = scoreReadingV4(scenario, response([event, need]));
  assert.equal(status(result, 'dev-04-02'), 'pass');
  assert.equal(status(result, 'dev-04-03'), 'pass');
  assert.equal(status(result, 'dev-04-04'), 'pass');
  need.shape = 'by';
  need.endTime = '10:00';
  const fabricated = scoreReadingV4(scenario, response([event, need]));
  assert.equal(status(fabricated, 'dev-04-02'), 'fail');
  assert.equal(status(fabricated, 'dev-04-03'), 'fail');
  assert.equal(status(fabricated, 'dev-04-04'), 'fail');
});

test('文脈として別の文を参照しただけなら、誤分類と断定せず未判定にする', async () => {
  const scenario = await load('dev-01.json');
  const entry = item(scenario.source, 1, 'need');
  entry.sentenceIds.push(scenario.source.sentences[1].id);
  const result = scoreReadingV4(scenario, response([entry]));
  assert.equal(status(result, 'dev-01-04'), 'undetermined');
});

test('原文順の跨句引用と全半角・空白を受け、跨ぐ引用の対象は決めつけない', async () => {
  const mixed = await load('dev-02.json');
  const quote = item(mixed.source, 1, 'need', {
    sentenceIds: [mixed.source.sentences[1].id, mixed.source.sentences[0].id],
    written: 'ご参加ください。　会場は地域交流室です。',
  });
  assert.equal(status(scoreReadingV4(mixed, response([quote])), 'source-evidence'), 'pass');

  const old = await load('dev-01.json');
  const sameLine = item(old.source, 2, 'need', { written: '１２月１１日（金）のお茶当番' });
  const matched = scoreReadingV4(old, response([sameLine]));
  assert.equal(status(matched, 'source-evidence'), 'pass');
  assert.equal(status(matched, 'dev-01-04'), 'fail');

  const across = item(old.source, 2, 'need', {
    sentenceIds: [old.source.sentences[1].id, old.source.sentences[0].id],
    written: 'あります。１２月１１日',
  });
  const uncertain = scoreReadingV4(old, response([across]));
  assert.equal(status(uncertain, 'source-evidence'), 'pass');
  assert.equal(status(uncertain, 'dev-01-04'), 'undetermined');
});

test('機械で一致しても人の未採点は成功にせず、根拠と判定を別に記録する', async () => {
  const scenario = await load('dev-01.json');
  const source = scenario.source;
  const items = [
    item(source, 1, 'event'),
    item(source, 2, 'duty', { familyAction: true }),
    item(source, 3, 'submission'),
    item(source, 4, 'belongings'),
    item(source, 5, 'homework', { familyAction: true }),
    item(source, 6, 'duty', { familyAction: false }),
  ];
  const result = scoreReadingV4(scenario, response(items));
  assert.equal(reviewReadingV4(result, {}).verdict, 'pending');
  const decisions = Object.fromEntries(
    result.manual.map(({ id }) => [id, { status: 'pass', evidence: '出典と出力を確認した' }]),
  );
  assert.equal(reviewReadingV4(result, decisions).verdict, 'pass');
  const first = result.manual[0].id;
  decisions[first] = { status: 'undetermined', evidence: '条件の意味を確かめられない' };
  assert.equal(reviewReadingV4(result, decisions).verdict, 'undetermined');
  decisions[first] = { status: 'fail', evidence: '対象が違う' };
  assert.equal(reviewReadingV4(result, decisions).verdict, 'fail');
  decisions[first] = { status: 'pass', evidence: '' };
  assert.throws(() => reviewReadingV4(result, decisions));
});

test('存在しない出典・推測した成員・打ち切りは成功として数えない', async () => {
  const scenario = await load('dev-01.json');
  const madeUp = item(scenario.source, 1, 'event', { forMemberId: 'guessed' });
  madeUp.sentenceIds = ['unknown'];
  const result = scoreReadingV4(scenario, response([madeUp]));
  assert.equal(status(result, 'source-evidence'), 'fail');
  assert.equal(status(result, 'no-inferred-member-id'), 'fail');
  const badQuote = item(scenario.source, 1, 'event', { written: '書かれていない文' });
  assert.equal(status(scoreReadingV4(scenario, response([badQuote])), 'source-evidence'), 'fail');
  const validItem = item(scenario.source, 1, 'event');
  const crossed = response([validItem], { irrelevantSentenceIds: [validItem.sentenceIds[0]] });
  assert.equal(status(scoreReadingV4(scenario, crossed), 'source-evidence'), 'fail');
  assert.equal(status(scoreReadingV4(scenario, response([validItem])), 'sentence-coverage'), 'fail');
  const falseReference = response([], {
    ambiguities: [{ sentenceId: 'unknown', note: '確かめる' }],
  });
  assert.equal(status(scoreReadingV4(scenario, falseReference), 'source-evidence'), 'fail');
  assert.equal(scoreReadingV4(scenario, response([]), { stopReason: 'max_tokens' }).state, 'unscorable');
  assert.equal(scoreReadingV4(scenario, response([]), { stopReason: 'tool_use' }).state, 'unscorable');
  assert.equal(scoreReadingV4(scenario, null).state, 'unscorable');
});

test('保存済み応答の採点 CLI は打ち切りを数えず、許可された場所以外を読まない', async () => {
  const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const runs = path.join(repo, 'eval/runs');
  await mkdir(runs, { recursive: true });
  await mkdir(path.join(repo, '.local'), { recursive: true });
  const temp = await mkdtemp(path.join(runs, 'reading-v4-cli-'));
  const outsideDir = await mkdtemp(path.join(repo, '.local', 'reading-v4-cli-'));
  try {
    const inside = path.join(temp, 'response.json');
    await writeFile(inside, JSON.stringify({ stop_reason: 'max_tokens', output: response([]) }));
    const cli = path.join(repo, 'eval/score-reading-v4.mjs');
    const casePath = path.join(repo, 'eval/cases/reading-v4/dev-01.json');
    const run = (responsePath) =>
      spawnSync(process.execPath, [cli, '--case', casePath, '--response', responsePath], {
        cwd: repo,
        encoding: 'utf8',
      });
    const incomplete = run(inside);
    assert.equal(incomplete.status, 0);
    assert.equal(JSON.parse(incomplete.stdout).state, 'unscorable');
    const outside = path.join(outsideDir, 'outside.json');
    await writeFile(outside, '{"notForEvaluation":"CANARY-OUTSIDE-9127"}');
    const denied = run(outside);
    assert.notEqual(denied.status, 0);
    assert.ok(!`${denied.stdout}${denied.stderr}`.includes('CANARY-OUTSIDE-9127'));
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
