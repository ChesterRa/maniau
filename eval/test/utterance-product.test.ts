import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readUtterance } from '../../apps/server/src/reading/utterance.ts';
import { demoEvents } from '../../apps/server/src/demo.ts';
import { utteranceContext } from '../../apps/server/src/utterance-context.ts';
import { seenOf, toUtteranceReply } from '../../packages/core/src/reading/utterance.ts';
import { requestSnapshot } from '../../packages/core/src/engine/index.ts';
import { notice2, noticeArrived } from '../../packages/core/test/fixtures/demo.ts';
import { instrumentUtteranceClient } from '../utterance-api.mjs';
import { evaluateUtteranceCase, prepareUtteranceCase } from '../utterance-eval.mjs';

const root = new URL('../cases/spoken-updates/', import.meta.url);
const readCase = async (name: string) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const action = (type: string, fields: Record<string, unknown>) => ({
  type, taskKey: null, requestId: null, reply: null, unknownId: null, value: null, ...fields,
});

test('製品の読み取りと検査を、通信せず同じ場面に通す', async () => {
  const row = await readCase('02-helper-reply.json');
  const entries: unknown[] = [];
  const output = {
    kind: 'change',
    actions: [action('recordReply', { requestId: 'r-grandma-1207', reply: 'no' })],
    refs: { taskKeys: [], requestIds: [], itemIds: [] },
    unsupported: null,
  };
  const client = instrumentUtteranceClient({ messages: { parse: async (params: any) => {
    const input = JSON.parse(params.messages[0].content);
    assert.equal(input.utterance, row.input.utterance);
    assert.equal(input.requests.length, 2);
    assert.ok(!Object.hasOwn(input, 'expected'));
    return { parsed_output: output, stop_reason: 'end_turn', model: 'model-example', usage: { input_tokens: 42, output_tokens: 20 } };
  } } }, { ledger: async (entry: unknown) => { entries.push(entry); } });
  let raw: unknown;
  const result = await evaluateUtteranceCase(row, {
    read: async (context: any) => {
      const reading = await readUtterance(client as any, context);
      raw = reading.output;
      return reading.output;
    },
    toReply: (parsed: any, context: any) => toUtteranceReply(parsed, context, () => 'new-id'),
  });
  assert.deepEqual(raw, output);
  assert.equal(result.report.classification, 'match');
  assert.equal(result.report.commands, 'match');
  assert.equal(entries.length, 2);
  assert.ok(result.report.checks.every((check: any) => check.result === 'undetermined'));
});

test('担当本人が送ったなら、引き受け前の提案でも送信記録の候補にできる', async () => {
  const row = await readCase('07-record-sent.json');
  row.input.state.tasks[0].commitment = 'proposed';
  const output = {
    kind: 'change', actions: [action('recordSent', { taskKey: 'task:grandma-1207' })],
    refs: { taskKeys: [], requestIds: [], itemIds: [] }, unsupported: null,
  };
  const result = await evaluateUtteranceCase(row, {
    read: async () => output,
    toReply: (parsed: any, context: any) => toUtteranceReply(parsed, context, () => 'new-id'),
  });
  assert.equal(result.report.classification, 'match');
  assert.equal(result.report.commands, 'match');
});

test('対象を決められない時は、候補が空でも確認として返す', async () => {
  const row = await readCase('04-ambiguous-reply.json');
  const output = {
    kind: 'clarify', actions: [],
    refs: { taskKeys: [], requestIds: [], itemIds: [] }, unsupported: null,
  };
  const result = await evaluateUtteranceCase(row, {
    read: async () => output,
    toReply: (parsed: any, context: any) => toUtteranceReply(parsed, context, () => 'new-id'),
  });
  assert.equal(result.report.classification, 'match');
  assert.deepEqual(result.reply.proposals, []);
});

test('自分の変更と別の大人の変更が混ざる時、一方を黙って落とさない', async () => {
  const row = await readCase('01-own-task.json');
  row.input.utterance = '自分の届は出せず、彩も迎えに行けないそうです。';
  row.input.state.tasks.push({
    key: 'task:pickup', what: '子どもを迎える', date: '2026-11-27',
    assigneeId: 'b', commitment: 'accepted', live: true,
  });
  const output = {
    kind: 'change',
    actions: [action('withdraw', { taskKey: 'task:submit-1127' }), action('withdraw', { taskKey: 'task:pickup' })],
    refs: { taskKeys: [], requestIds: [], itemIds: [] }, unsupported: null,
  };
  const result = await evaluateUtteranceCase(row, {
    read: async () => output,
    toReply: (parsed: any, context: any) => toUtteranceReply(parsed, context, () => 'new-id'),
  });
  assert.equal(result.reply.kind, 'clarify');
  assert.equal(result.reply.reason, 'otherAdultsTask');
});

test('見せた作業の日や用件が変わったら、以前の控えと一致しない', async () => {
  const row = await readCase('01-own-task.json');
  const before = prepareUtteranceCase(row).context;
  const after = structuredClone(before);
  after.tasks[0].date = '2026-12-04';
  after.tasks[0].what = '別の日の学童への届を提出する';
  const command = { type: 'commitment', taskKey: 'task:submit-1127', action: 'withdraw' } as const;
  assert.notDeepEqual(seenOf(command, after), seenOf(command, before));
});

test('見せた依頼の相手や日が変わったら、以前の控えと一致しない', async () => {
  const before = prepareUtteranceCase(await readCase('02-helper-reply.json')).context;
  const after = structuredClone(before);
  after.requests[0].to = '別の相手';
  after.requests[0].forDate = '2026-12-14';
  const command = { type: 'recordReply', requestId: 'r-grandma-1207', reply: 'no' } as const;
  assert.notDeepEqual(seenOf(command, after), seenOf(command, before));
});

test('見せた未定の値の選択肢が変わったら、以前の控えと一致しない', async () => {
  const row = await readCase('01-own-task.json');
  row.input.state.unknowns = [{ id: 'u', label: '開催日', values: ['5日', '8日'], answer: null }];
  const before = prepareUtteranceCase(row).context;
  const after = structuredClone(before);
  after.unknowns[0].values = ['5日', '15日'];
  const command = { type: 'answer', unknownId: 'u', value: '5日' } as const;
  assert.notDeepEqual(seenOf(command, after), seenOf(command, before));
});

test('頼んだ後に手配の日が変わっても、一言の依頼の日は送った時の控えに従う', () => {
  const care = 'arr:childCare:i4:c';
  const option = `opt:${care}:opt-grandma`;
  const taskKey = `task:${option}:ask`;
  const log = noticeArrived()
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', { arrangementKey: care, optionKey: option, role: 'primary' })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey, assigneeId: 'b' })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', { taskKey, assigneeId: 'b', action: 'accept' });
  log.add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
    taskKey, requestId: 'r-grandma', snapshot: requestSnapshot(log.events, '2026-11-25T19:39+09:00', taskKey),
  });
  log.add('answered', '2026-11-26T10:00+09:00', 'b', { unknownId: 'u-date', value: '2026-12-05' });
  log.add('noticeReceived', '2026-11-27T17:00+09:00', 'b', {
    source: { ...notice2, id: 'n3', sentences: [{ id: 'n3#1', text: '（架空）' }] },
  });
  log.add('modelOutputRecorded', '2026-11-27T17:00+09:00', 'system', {
    call: 'extract', model: 'fixture', promptVersion: 'fixture', inputHash: 'fixture-n3', sourceId: 'n3',
    output: {
      sourceId: 'n3', unknowns: [], conditions: [], irrelevantSentenceIds: [], ambiguities: [],
      items: [{
        id: 'k1', sourceId: 'n3', sentenceIds: ['n3#1'], kind: 'dayChange', written: '（架空）',
        interpretation: { date: '2026-12-14', dayType: 'noSchool' }, evidence: 'stated',
        conditionNodeId: 'c-held-5', effects: [{ type: 'replace', itemId: 'i4' }],
      }],
    },
  });
  const context = utteranceContext(log.events, 'b', '2026-11-27T17:01+09:00', '');
  const request = context?.requests.find((entry) => entry.id === 'r-grandma');
  assert.ok(request);
  assert.equal(request.forDate, '2026-12-07');
});

test('取り消しを伝えた一言を、不要になった依頼の連絡として提案する', () => {
  const context = utteranceContext(demoEvents('postponed'), 'b', '2026-12-04T18:10+09:00', '');
  assert.ok(context);
  const request = context.requests.find((r) => r.id === 'r-grandma');
  assert.ok(request);
  assert.equal(request.needed, false);
  const output = {
    kind: 'change', actions: [action('recordCancellationSent', { requestId: 'r-grandma' })],
    refs: { taskKeys: [], requestIds: [], itemIds: [] }, unsupported: null,
  };
  const reply = toUtteranceReply(output as any, context, () => 'unused');
  assert.equal(reply.kind, 'change');
  if (reply.kind === 'change') assert.deepEqual(reply.proposals[0].command, { type: 'recordCancellationSent', requestId: 'r-grandma' });
});

test('一度返事があった後に相手の返事が変わった時も、後の返事を提案する', async () => {
  const row = await readCase('02-helper-reply.json');
  for (const [state, replyValue] of [['confirmed', 'no'], ['turnedDown', 'yes']] as const) {
    row.input.state.requests[0].state = state;
    const context = prepareUtteranceCase(row).context;
    const output = {
      kind: 'change', actions: [action('recordReply', { requestId: 'r-grandma-1207', reply: replyValue })],
      refs: { taskKeys: [], requestIds: [], itemIds: [] }, unsupported: null,
    };
    const reply = toUtteranceReply(output as any, context, () => 'unused');
    assert.equal(reply.kind, 'change');
    if (reply.kind === 'change') assert.deepEqual(reply.proposals[0].command, { type: 'recordReply', requestId: 'r-grandma-1207', reply: replyValue });
  }
});
