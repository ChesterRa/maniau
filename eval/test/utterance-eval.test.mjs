import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { evaluateUtteranceCase, prepareUtteranceCase, sameSourceFingerprints, scoreUtteranceCase } from '../utterance-eval.mjs';

const root = new URL('../cases/spoken-updates/', import.meta.url);
const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
const scenarios = await Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
const scenario = (number) => scenarios.find((entry) => entry.id === `update-dev-${number}`);
const proposal = (command) => ({ command, seen: { task: null } });

test('読み取り中のコードの変更や欠落を比較不能にする', () => {
  assert.equal(sameSourceFingerprints({ a: '1', b: '2' }, { b: '2', a: '1' }), true);
  assert.equal(sameSourceFingerprints({ a: '1' }, { a: '2' }), false);
  assert.equal(sameSourceFingerprints({ a: '1' }, { a: '1', b: '2' }), false);
  assert.equal(sameSourceFingerprints({ a: '1' }, null), false);
});

test('架空の全場面を、正解や採点項目を渡さず製品の入力に移す', () => {
  assert.equal(scenarios.length, 8);
  for (const row of scenarios) {
    const { context } = prepareUtteranceCase(row);
    assert.equal(context.utterance, row.input.utterance);
    assert.deepEqual(context.speaker, row.input.actor);
    assert.equal(context.now, row.input.now);
    assert.equal(context.timeZone, row.timeZone);
    const serialized = JSON.stringify(context);
    for (const key of ['expected', 'referenceCommands', 'checks', 'afterPreview', 'routines']) {
      assert.ok(!Object.hasOwn(context, key));
      assert.ok(!serialized.includes(`"${key}":`));
    }
    assert.ok(context.tasks.every((task) => task.cancels === null));
  }
  assert.throws(() => prepareUtteranceCase({ ...scenario('01'), synthetic: false }));
});

test('欠けた説明や種類を正解から補わず記録し、条件を残す', () => {
  const reply = prepareUtteranceCase(scenario('02'));
  assert.deepEqual(reply.omissions, [
    { type: 'request.what', id: 'r-grandma-1207' },
    { type: 'request.what', id: 'r-grandma-1214' },
  ]);
  assert.equal(reply.context.requests[0].what, '');
  const question = prepareUtteranceCase(scenario('03'));
  assert.equal(question.context.items[0].kind, '');
  assert.equal(question.context.items[0].condition, null);
  assert.equal(question.context.items[1].condition, '水泳が行われる場合');
  assert.equal(question.omissions.filter((entry) => entry.type === 'item.kind').length, 2);
  assert.equal(question.omissions.filter((entry) => entry.type === 'item.evidence').length, 2);
  assert.ok(question.omissions.some((entry) => entry.type === 'notice.title'));
});

test('送信済みを場面から判定できない時は、未送信と決めつけない', () => {
  const row = structuredClone(scenario('07'));
  assert.equal(prepareUtteranceCase(row).context.tasks[0].sent, false);
  row.input.state.requests.push({ id: 'r', to: '相手', live: true, state: 'awaitingReply', sentBy: 'b' });
  assert.throws(() => prepareUtteranceCase(row), /送信済みか判定できない/);
  row.input.state.tasks[0].sent = true;
  assert.equal(prepareUtteranceCase(row).context.tasks[0].sent, true);
  delete row.input.state.tasks[0].sent;
  row.input.state.requests[0].taskKey = 'task:grandma-1207';
  row.input.state.requests[0].live = false;
  const historical = prepareUtteranceCase(row).context;
  assert.equal(historical.tasks[0].sent, true);
  assert.equal(historical.requests.length, 0);
});

test('取り消し連絡の対象は不要になっていても入力に残し、不要と示す', () => {
  const row = structuredClone(scenario('07'));
  row.input.state.tasks[0].external = undefined;
  row.input.state.tasks[0].cancels = 'r-old';
  row.input.state.requests.push({
    id: 'r-old', taskKey: 'old-task', to: '相手', live: false,
    state: 'awaitingReply', sentBy: 'b', forDate: '2026-12-07', what: '子どもの世話',
  });
  const { context } = prepareUtteranceCase(row);
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].id, 'r-old');
  assert.equal(context.requests[0].needed, false);
});

test('参照する命令は種類・対象・返事を照合し、余分な命令も見逃さない', () => {
  const row = scenario('02');
  const good = { kind: 'change', proposals: [proposal({ type: 'recordReply', requestId: 'r-grandma-1207', reply: 'no' })] };
  assert.equal(scoreUtteranceCase(row, good).commands, 'match');
  assert.equal(scoreUtteranceCase(row, { ...good, proposals: [proposal({ ...good.proposals[0].command, reply: 'yes' })] }).commands, 'mismatch');
  assert.equal(scoreUtteranceCase(row, { ...good, proposals: [proposal({ ...good.proposals[0].command, requestId: 'r-grandma-1214' })] }).commands, 'mismatch');
  assert.equal(scoreUtteranceCase(row, { ...good, proposals: [...good.proposals, good.proposals[0]] }).commands, 'mismatch');
  const sent = scenario('07');
  assert.equal(scoreUtteranceCase(sent, { kind: 'change', proposals: [proposal({ type: 'recordSent', taskKey: 'task:grandma-1207', requestId: 'new-id' })] }).commands, 'match');
});

test('分類の一致は、画面や確認後の挙動を満たした証拠にしない', () => {
  const report = scoreUtteranceCase(scenario('03'), { kind: 'question', refs: { taskKeys: [], requestIds: [], itemIds: ['i-book', 'i-towel'] } });
  assert.equal(report.classification, 'match');
  assert.ok(report.checks.every((check) => check.result === 'undetermined'));
  assert.equal(scoreUtteranceCase(scenario('01'), { kind: 'unsupported' }).classification, 'mismatch');
  const hypothetical = scoreUtteranceCase(scenario('02'), { kind: 'whatIf', requestIds: ['r-grandma-1207'] });
  assert.equal(hypothetical.status, 'observed');
  assert.equal(hypothetical.classification, 'mismatch');
  assert.equal(hypothetical.commands, 'mismatch');
  assert.equal(scoreUtteranceCase(scenario('01'), null).status, 'incomplete');
  assert.equal(scoreUtteranceCase(scenario('01'), { kind: 'change', proposals: [] }).afterPreview, 'not_run');
});

test('対応する命令のない一日だけの変更は、API を呼ばず未実施にする', async () => {
  let calls = 0;
  const result = await evaluateUtteranceCase(scenario('06'), {
    read: async () => { calls += 1; },
    toReply: async () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(result.report.status, 'not_run');
  assert.equal(result.report.reason, 'routine_change_not_supported');
  assert.ok(result.report.checks.every((check) => check.result === 'not_run'));
  assert.ok(result.report.omissions.some((entry) => entry.type === 'routines'));
});

test('一回の入力に読み取りと変換をそれぞれ一回だけ使う', async () => {
  let calls = 0;
  const result = await evaluateUtteranceCase(scenario('08'), {
    read: async (context) => {
      calls += 1;
      assert.ok(!Object.hasOwn(context, 'expected'));
      return { kind: 'change' };
    },
    toReply: async (output, context) => {
      calls += 1;
      assert.equal(output.kind, 'change');
      assert.equal(context.requests.length, 2);
      return { kind: 'change', proposals: [proposal({ type: 'recordReply', requestId: 'r-grandma-1207', reply: 'yes' })] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.report.classification, 'match');
  assert.equal(result.report.commands, 'match');
});
