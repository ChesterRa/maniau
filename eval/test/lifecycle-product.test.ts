// 開発用 07/08 を、架空の読み取り済み事実と正式な命令で再生する。モデルや外部 API は呼ばない。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runCommand } from '../../apps/server/src/commands';
import { demoEvents } from '../../apps/server/src/demo';
import { sendGate } from '../../apps/server/src/gate';
import { memoryStore } from '../../apps/server/src/store';
import { viewFor } from '../../apps/server/src/views';
import {
  type Command,
  isActiveTask,
  notificationHistory,
  notificationIntents,
  proposalSnapshot,
  todayCards,
} from '../../packages/core/src';
import { computePlan, keys } from '../../packages/core/src/engine';
import { verifyPlan } from '../../packages/verify/src';

const care = 'arr:childCare:n1:i6:c';
const school = keys.option(care, 'opt-gakudo');
const write = keys.task(school, 'write');
const submit = keys.task(school, 'submit');

async function checkCase(file: string, digest: string): Promise<void> {
  const bytes = await readFile(new URL(`../cases/${file}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
}

function scenario(stage: 'arrived' | 'chase', now: string) {
  const store = memoryStore(new Map([['demo', demoEvents(stage)]]));
  let sequence = 0;
  const run = async (memberId: string, command: Command) => {
    const result = await runCommand(
      store, 'demo', { memberId, operationId: `lifecycle-${++sequence}`, now, demo: true }, command,
    );
    assert.equal(result.status, 'ok', `${command.type}: ${JSON.stringify(result)}`);
  };
  const state = () => store.withHousehold('demo', (log) => {
    const events = [...log.events()];
    const set = events.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家庭がない');
    return { events, household: set.household, plan: computePlan(events, now) };
  });
  return { run, state };
}

function checkWholePlan(state: Awaited<ReturnType<ReturnType<typeof scenario>['state']>>) {
  const violations = verifyPlan(state).issues.filter((issue) => issue.kind === 'violation');
  assert.deepEqual(violations, []);
  const intents = notificationIntents(state.plan, state.household, notificationHistory(state.events));
  assert.equal(sendGate({ ...state, intents, batchEnds: state.events.map((event) => event.seq) }).all, false);
}

test('07：引き受けた後の辞退は、その作業だけを担当未決定に戻す', async () => {
  await checkCase('07-declined-task.json', '72d02c7175ce2f0d42eb7c431071a2100bf329c4a7879486b29113fe1166ac64');
  const { run, state } = scenario('arrived', '2026-11-25T19:40+09:00');
  await run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' });
  await run('b', { type: 'chooseOption', arrangementKey: care, optionKey: school, role: 'primary', assigneeId: 'a' });
  for (const key of [write, submit]) {
    const entry = (await state()).plan.tasks.find((task) => task.key === key);
    const shown = entry && proposalSnapshot(entry);
    if (!shown) throw new Error('本人に見せる提案がない');
    await run('a', { type: 'accept', taskKey: key, shown });
  }
  await run('a', { type: 'commitment', taskKey: write, action: 'decline' });
  const result = await state();
  const written = result.plan.tasks.find((task) => task.key === write);
  const handed = result.plan.tasks.find((task) => task.key === submit);
  assert.equal(written?.commitment, 'declined');
  assert.equal(handed?.commitment, 'accepted');
  assert.equal(handed?.assigneeId, 'a');
  assert.equal(result.plan.requests.some((request) => request.taskKey === submit), false);
  for (const member of ['a', 'b'])
    assert.ok(todayCards(result.plan, member).main.some((card) => card.kind === 'unowned' && card.task.key === write));
  checkWholePlan(result);
});

test('08：前の日の返事で新しい日の本命を確定せず、予備を続ける', async () => {
  await checkCase('08-moved-request.json', '9314c48c4103680b54fdbdf33695cb9bfd89eccc9cfc0edbda02dabec456df99');
  const now = '2026-11-29T21:00+09:00';
  const { run, state } = scenario('chase', now);
  await run('b', { type: 'chooseOption', arrangementKey: care, optionKey: school, role: 'backup', assigneeId: 'a' });
  await run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
  await run('a', { type: 'correctItem', itemId: 'n1:i6', interpretation: { date: '2026-12-14', writtenWeekday: 1 } });
  const result = await state();
  const current = result.plan.arrangements.find((entry) => entry.key === care);
  assert.equal(current?.start.slice(0, 10), '2026-12-14');
  assert.equal(current?.options.find((entry) => entry.key === school)?.decisionDeadline, '2026-12-07T17:20+09:00');
  const previous = result.plan.requests.find((request) => request.requestId === 'r-grandma');
  assert.equal(previous?.state, 'confirmed');
  assert.equal(previous?.window?.start.slice(0, 10), '2026-12-07');
  assert.equal(previous?.needsCheck, true);
  assert.equal(result.plan.requests.some((request) => request.requestId !== 'r-grandma' && request.basis.arrangementKey === care), false);
  const writing = result.plan.tasks.find((task) => task.key === write);
  assert.ok(writing && isActiveTask(result.plan, writing));
  assert.equal(writing?.commitment, 'proposed');
  assert.equal(result.plan.tasks.some((task) => task.cancels === 'r-grandma' && task.live), false);
  assert.ok(viewFor(result.events, 'b', now).today.main.some((card) => card.kind === 'check' && card.request.requestId === 'r-grandma'));
  checkWholePlan(result);
});
